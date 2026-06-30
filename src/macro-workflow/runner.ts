import type { HarnessRegistry } from "./harness.js";
import { resolveHarnessAdapter } from "./harness.js";
import type { MacroWorkflowEvent, MacroWorkflowLogger } from "./logger.js";
import { MacroWorkflowEventKind } from "./logger.js";
import type { MacroWorkflowRunState, RuntimeWorkflowPlan, WorkflowNodeExecutionResult, WorkflowReplanPatch, WorkflowReplayEvent } from "./types.js";
import { WorkflowNodeStatus as WorkflowNodeState, WorkflowReplanReason, WorkflowReplayEventKind } from "./types.js";
import { verifyWorkflowReplanPatch } from "./verifier.js";

export type WorkflowReplanner = {
  generateReplanPatch(args: {
    reason: string;
    maxRemainingReplans: number;
    completedNodeIds: string[];
    currentPlan: RuntimeWorkflowPlan;
  }): Promise<WorkflowReplanPatch>;
};

export type MacroWorkflowRunnerDependencies = {
  harnesses?: HarnessRegistry;
  replanner?: WorkflowReplanner;
  logger?: MacroWorkflowLogger;
  onStateChange?: (state: MacroWorkflowRunState, event: MacroWorkflowEvent) => void;
  onReplayEvent?: (event: WorkflowReplayEvent) => void;
};

export async function runMacroWorkflow(
  plan: RuntimeWorkflowPlan,
  dependencies: MacroWorkflowRunnerDependencies = {},
): Promise<MacroWorkflowRunState> {
  const state: MacroWorkflowRunState = {
    planId: plan.id,
    objective: plan.objective,
    templateId: plan.templateId,
    status: "running",
    startedAt: new Date(),
    plan,
    currentPlan: plan,
    nodeResults: [],
    replans: [],
    activeNodeId: undefined,
  };

  const logger = dependencies.logger;
  const emitStateChange = (event: MacroWorkflowEvent) => {
    logger?.emit(event);
    dependencies.onStateChange?.(state, event);
  };
  let replaySeq = 0;
  const emitReplayEvent = (event: Omit<WorkflowReplayEvent, "seq" | "ts">) => {
    dependencies.onReplayEvent?.({
      seq: ++replaySeq,
      ts: new Date().toISOString(),
      ...event,
    });
  };
  emitReplayEvent({
    kind: WorkflowReplayEventKind.PLANNING_STARTED,
    phase: "planning",
    nodeId: "workflow-planning",
  });
  for (const node of plan.nodes) {
    emitReplayEvent({
      kind: WorkflowReplayEventKind.NODE_ADDED,
      phase: "planning",
      nodeId: node.id,
      node,
    });
  }
  emitReplayEvent({
    kind: WorkflowReplayEventKind.PLANNING_COMPLETE,
    phase: "running",
    nodeId: "workflow-planning",
    status: WorkflowNodeState.PASSED,
  });
  emitStateChange({ type: MacroWorkflowEventKind.RUN_STARTED, planId: plan.id, timestamp: new Date() });

  let remainingPlan = plan;
  const completedNodeIds = new Set<string>();
  let remainingReplans = remainingPlan.maxReplans;

  while (true) {
    const nextNode = selectNextNode(remainingPlan, completedNodeIds);
    if (!nextNode) {
      break;
    }

    state.activeNodeId = nextNode.id;
    emitReplayEvent({
      kind: WorkflowReplayEventKind.NODE_STATUS_CHANGED,
      phase: "running",
      nodeId: nextNode.id,
      status: WorkflowNodeState.RUNNING,
    });
    emitStateChange({ type: MacroWorkflowEventKind.NODE_STARTED, planId: plan.id, nodeId: nextNode.id, timestamp: new Date() });

    const result = await executeNode(nextNode, dependencies.harnesses);
    state.activeNodeId = undefined;
    state.nodeResults.push(result);
    emitReplayEvent({
      kind: WorkflowReplayEventKind.NODE_STATUS_CHANGED,
      phase: "running",
      nodeId: nextNode.id,
      status: result.status,
    });
    emitStateChange({
      type: result.status === "passed" ? MacroWorkflowEventKind.NODE_COMPLETED : MacroWorkflowEventKind.NODE_FAILED,
      planId: plan.id,
      nodeId: nextNode.id,
      status: result.status,
      timestamp: new Date(),
    });

    if (result.status === "passed") {
      completedNodeIds.add(nextNode.id);
      continue;
    }

    if (remainingReplans <= 0 || nextNode.replanPolicy === "never") {
      state.status = "failed";
      state.completedAt = new Date();
      emitReplayEvent({
        kind: WorkflowReplayEventKind.RUN_COMPLETED,
        phase: "completed",
        status: WorkflowNodeState.FAILED,
      });
      emitStateChange({ type: MacroWorkflowEventKind.RUN_COMPLETED, planId: plan.id, status: "failed", timestamp: new Date() });
      return state;
    }

    const patch = await createReplanPatch(nextNode.id, result.error ?? result.output, remainingPlan, completedNodeIds, remainingReplans, dependencies.replanner);
    if (!patch) {
      state.status = "failed";
      state.completedAt = new Date();
      emitReplayEvent({
        kind: WorkflowReplayEventKind.RUN_COMPLETED,
        phase: "completed",
        status: WorkflowNodeState.FAILED,
      });
      emitStateChange({ type: MacroWorkflowEventKind.RUN_COMPLETED, planId: plan.id, status: "failed", timestamp: new Date() });
      return state;
    }

    const verification = verifyWorkflowReplanPatch(remainingPlan, patch, Array.from(completedNodeIds));
    if (!verification.valid) {
      state.status = "failed";
      state.completedAt = new Date();
      emitReplayEvent({
        kind: WorkflowReplayEventKind.RUN_COMPLETED,
        phase: "completed",
        status: WorkflowNodeState.FAILED,
      });
      emitStateChange({ type: MacroWorkflowEventKind.RUN_COMPLETED, planId: plan.id, status: "failed", timestamp: new Date() });
      return state;
    }

    remainingReplans -= 1;
    remainingPlan = applyReplanPatch(remainingPlan, patch, completedNodeIds);
    state.plan = remainingPlan;
    state.currentPlan = remainingPlan;
    state.replans.push({
      failedNodeId: nextNode.id,
      reason: patch.reason,
      rationale: `${nextNode.id} failed and triggered a bounded replan.`,
      patch,
      timestamp: new Date(),
    });
    emitReplayEvent({
      kind: WorkflowReplayEventKind.REPLAN_APPLIED,
      phase: "running",
      nodeId: nextNode.id,
      reason: patch.reason,
      patch,
    });
    emitStateChange({ type: MacroWorkflowEventKind.REPLAN_APPLIED, planId: plan.id, nodeId: nextNode.id, reason: patch.reason, timestamp: new Date() });
  }

  state.status = "passed";
  state.completedAt = new Date();
  emitReplayEvent({
    kind: WorkflowReplayEventKind.RUN_COMPLETED,
    phase: "completed",
    status: WorkflowNodeState.PASSED,
  });
  emitStateChange({ type: MacroWorkflowEventKind.RUN_COMPLETED, planId: plan.id, status: "passed", timestamp: new Date() });
  return state;
}

function selectNextNode(plan: RuntimeWorkflowPlan, completedNodeIds: Set<string>): RuntimeWorkflowPlan["nodes"][number] | undefined {
  return plan.nodes.find((node) => !completedNodeIds.has(node.id) && node.dependsOn.every((dependency) => completedNodeIds.has(dependency)));
}

async function executeNode(node: RuntimeWorkflowPlan["nodes"][number], harnesses?: HarnessRegistry): Promise<WorkflowNodeExecutionResult> {
  const adapter = harnesses ? resolveHarnessAdapter(harnesses, node.harness) : undefined;
  if (!adapter) {
    return { nodeId: node.id, status: WorkflowNodeState.PASSED, output: `No harness registered for ${node.harness}.` };
  }

  const result = await adapter(node);
  return { nodeId: node.id, status: result.status, output: result.output, error: result.error };
}

async function createReplanPatch(
  failedNodeId: string,
  failureText: string,
  currentPlan: RuntimeWorkflowPlan,
  completedNodeIds: Set<string>,
  remainingReplans: number,
  replanner?: WorkflowReplanner,
): Promise<WorkflowReplanPatch | undefined> {
  if (!replanner) {
    return {
      reason: WorkflowReplanReason.VERIFICATION_FAILURE,
      replaceRemainingNodeIds: currentPlan.nodes.filter((node) => !completedNodeIds.has(node.id)).map((node) => node.id),
      newNodes: [],
    };
  }

  const patch = await replanner.generateReplanPatch({
    reason: failureText,
    maxRemainingReplans: remainingReplans,
    completedNodeIds: Array.from(completedNodeIds),
    currentPlan,
  });
  return patch;
}

export function applyReplanPatch(plan: RuntimeWorkflowPlan, patch: WorkflowReplanPatch, completedNodeIds: Set<string>): RuntimeWorkflowPlan {
  const remainingNodes = plan.nodes.filter((node) => !completedNodeIds.has(node.id) && !patch.replaceRemainingNodeIds.includes(node.id));
  return {
    ...plan,
    nodes: [...remainingNodes, ...patch.newNodes],
  };
}
