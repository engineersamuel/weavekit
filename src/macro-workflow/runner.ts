import type { HarnessRegistry } from "./harness.js";
import { resolveHarnessAdapter } from "./harness.js";
import type { MacroWorkflowLogger } from "./logger.js";
import { MacroWorkflowEventKind } from "./logger.js";
import type { MacroWorkflowRunState, RuntimeWorkflowPlan, WorkflowNodeExecutionResult, WorkflowReplanPatch } from "./types.js";
import { WorkflowNodeStatus as WorkflowNodeState, WorkflowReplanReason } from "./types.js";
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
  };

  const logger = dependencies.logger;
  logger?.emit({ type: MacroWorkflowEventKind.RUN_STARTED, planId: plan.id, timestamp: new Date() });

  let remainingPlan = plan;
  const completedNodeIds = new Set<string>();
  let remainingReplans = remainingPlan.maxReplans;

  while (true) {
    const nextNode = selectNextNode(remainingPlan, completedNodeIds);
    if (!nextNode) {
      break;
    }

    const result = await executeNode(nextNode, dependencies.harnesses);
    state.nodeResults.push(result);
    logger?.emit({
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
      logger?.emit({ type: MacroWorkflowEventKind.RUN_COMPLETED, planId: plan.id, status: "failed", timestamp: new Date() });
      return state;
    }

    const patch = await createReplanPatch(nextNode.id, result.error ?? result.output, remainingPlan, completedNodeIds, remainingReplans, dependencies.replanner);
    if (!patch) {
      state.status = "failed";
      state.completedAt = new Date();
      logger?.emit({ type: MacroWorkflowEventKind.RUN_COMPLETED, planId: plan.id, status: "failed", timestamp: new Date() });
      return state;
    }

    const verification = verifyWorkflowReplanPatch(remainingPlan, patch, Array.from(completedNodeIds));
    if (!verification.valid) {
      state.status = "failed";
      state.completedAt = new Date();
      logger?.emit({ type: MacroWorkflowEventKind.RUN_COMPLETED, planId: plan.id, status: "failed", timestamp: new Date() });
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
    logger?.emit({ type: MacroWorkflowEventKind.REPLAN_APPLIED, planId: plan.id, nodeId: nextNode.id, reason: patch.reason, timestamp: new Date() });
  }

  state.status = "passed";
  state.completedAt = new Date();
  logger?.emit({ type: MacroWorkflowEventKind.RUN_COMPLETED, planId: plan.id, status: "passed", timestamp: new Date() });
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
