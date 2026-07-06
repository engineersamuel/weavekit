import type { HarnessRegistry, WorkflowExecutionContext } from "./harness.js";
import { resolveHarnessAdapter } from "./harness.js";
import type { MacroWorkflowEvent, MacroWorkflowLogger } from "./logger.js";
import { MacroWorkflowEventKind } from "./logger.js";
import type { MacroWorkflowRunState, RuntimeWorkflowNode, RuntimeWorkflowPlan, WorkflowArtifactRef, WorkflowExecutionMetadata, WorkflowNodeExecutionResult, WorkflowNodePayload, WorkflowReplanPatch, WorkflowReplayEvent } from "./types.js";
import { WorkflowNodeStatus as WorkflowNodeState, WorkflowReplayEventKind } from "./types.js";
import { verifyWorkflowPlan, verifyWorkflowReplanPatch } from "./verifier.js";

export type WorkflowReplanner = {
  generateReplanPatch(args: {
    reason: string;
    maxRemainingReplans: number;
    completedNodeIds: string[];
    currentPlan: RuntimeWorkflowPlan;
  }): Promise<WorkflowReplanPatch>;
};

export type WorkflowDynamicExpander = (args: {
  node: RuntimeWorkflowNode;
  result: WorkflowNodeExecutionResult;
  currentPlan: RuntimeWorkflowPlan;
  payloads: Map<string, WorkflowNodePayload>;
  completedNodeIds: Set<string>;
}) => Promise<RuntimeWorkflowNode[] | undefined> | RuntimeWorkflowNode[] | undefined;

export type MacroWorkflowRunnerDependencies = {
  harnesses?: HarnessRegistry;
  replanner?: WorkflowReplanner;
  expandAfterNode?: WorkflowDynamicExpander;
  logger?: MacroWorkflowLogger;
  outputDir?: string;
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
  const planningReplayNode = {
    id: "workflow-planning",
    kind: "planning",
    harness: "workflow-planner",
    title: "DAG Planning",
    description: "Plan the workflow DAG from the objective and template before execution starts.",
    model: "claude-opus-4.8",
    modelRationale: "Workflow DAG planning uses the strongest available planning synthesis model.",
    prompt: plan.objective,
    dependsOn: [],
  };
  emitReplayEvent({
    kind: WorkflowReplayEventKind.PLANNING_STARTED,
    phase: "planning",
    nodeId: "workflow-planning",
    node: planningReplayNode,
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
    node: planningReplayNode,
    status: WorkflowNodeState.PASSED,
  });
  emitStateChange({ type: MacroWorkflowEventKind.RUN_STARTED, planId: plan.id, timestamp: new Date() });

  let remainingPlan = plan;
  const completedNodeIds = new Set<string>();
  let remainingReplans = remainingPlan.maxReplans;
  const payloads = new Map<string, WorkflowNodePayload>();
  const artifacts = new Map<string, WorkflowArtifactRef[]>();

  while (true) {
    const readyNodes = selectReadyNodes(remainingPlan, completedNodeIds);
    if (readyNodes.length === 0) {
      break;
    }

    const runnableNodes: RuntimeWorkflowNode[] = [];
    for (const node of readyNodes) {
      if (shouldRunNode(node, payloads)) {
        runnableNodes.push(node);
        continue;
      }

      const result: WorkflowNodeExecutionResult = {
        nodeId: node.id,
        status: WorkflowNodeState.SKIPPED,
        output: `Skipped because runWhen condition was not met.`,
      };
      state.nodeResults.push(result);
      completedNodeIds.add(node.id);
      emitReplayEvent({
        kind: WorkflowReplayEventKind.NODE_STATUS_CHANGED,
        phase: "running",
        nodeId: node.id,
        status: WorkflowNodeState.SKIPPED,
      });
      emitStateChange({
        type: MacroWorkflowEventKind.NODE_COMPLETED,
        planId: plan.id,
        nodeId: node.id,
        status: result.status,
        timestamp: new Date(),
      });
    }

    if (runnableNodes.length === 0) {
      continue;
    }

    const runnableContexts = new Map<string, WorkflowExecutionContext>();
    const activeNodeExecutions: Record<string, WorkflowExecutionMetadata> = {};
    for (const node of runnableNodes) {
      const context: WorkflowExecutionContext = { payloads, artifacts, objective: plan.objective, outputDir: dependencies.outputDir };
      const preparedExecution = await prepareNodeExecution(node, context, dependencies.harnesses);
      if (preparedExecution.warning) {
        emitStateChange({
          type: MacroWorkflowEventKind.NODE_WARNING,
          planId: plan.id,
          nodeId: node.id,
          reason: preparedExecution.warning,
          timestamp: new Date(),
        });
      }
      if (preparedExecution.execution) {
        context.preparedExecution = preparedExecution.execution;
        activeNodeExecutions[node.id] = preparedExecution.execution;
      }
      runnableContexts.set(node.id, context);
    }

    state.activeNodeId = runnableNodes[0]?.id;
    state.activeNodeIds = runnableNodes.map((node) => node.id);
    state.activeNodeExecutions = Object.keys(activeNodeExecutions).length > 0 ? activeNodeExecutions : undefined;
    for (const node of runnableNodes) {
      emitReplayEvent({
        kind: WorkflowReplayEventKind.NODE_STATUS_CHANGED,
        phase: "running",
        nodeId: node.id,
        status: WorkflowNodeState.RUNNING,
      });
      emitStateChange({ type: MacroWorkflowEventKind.NODE_STARTED, planId: plan.id, nodeId: node.id, timestamp: new Date() });
    }

    const batchResults = await Promise.all(runnableNodes.map(async (node) => ({
      node,
      result: await executeNode(node, runnableContexts.get(node.id) ?? { payloads, artifacts, objective: plan.objective }, dependencies.harnesses),
    })));
    state.activeNodeId = undefined;
    state.activeNodeIds = undefined;
    state.activeNodeExecutions = undefined;

    for (const { node, result } of batchResults) {
      state.nodeResults.push(result);
      if (result.payload) {
        payloads.set(node.id, result.payload);
      }
      if (result.artifacts) {
        artifacts.set(node.id, result.artifacts);
      }
      emitReplayEvent({
        kind: WorkflowReplayEventKind.NODE_STATUS_CHANGED,
        phase: "running",
        nodeId: node.id,
        status: result.status,
      });
    }

    const failedResults = batchResults.filter(({ result }) => result.status !== "passed");
    if (failedResults.length > 0) {
      for (const { node, result } of batchResults) {
        if (result.status !== "passed") {
          continue;
        }
        completedNodeIds.add(node.id);
        emitStateChange({
          type: MacroWorkflowEventKind.NODE_COMPLETED,
          planId: plan.id,
          nodeId: node.id,
          status: result.status,
          timestamp: new Date(),
        });
      }

      for (const { node, result } of failedResults) {
        emitStateChange({
          type: MacroWorkflowEventKind.NODE_FAILED,
          planId: plan.id,
          nodeId: node.id,
          status: result.status,
          timestamp: new Date(),
        });
      }

      const { node: failedNode, result: failedResult } = failedResults[0]!;
      if (remainingReplans <= 0 || failedNode.replanPolicy === "never") {
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

      const patch = await createReplanPatch(failedNode.id, failedResult.error ?? failedResult.output, remainingPlan, completedNodeIds, remainingReplans, dependencies.replanner);
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
        failedNodeId: failedNode.id,
        reason: patch.reason,
        rationale: `${failedNode.id} failed and triggered a bounded replan.`,
        patch,
        timestamp: new Date(),
      });
      emitReplayEvent({
        kind: WorkflowReplayEventKind.REPLAN_APPLIED,
        phase: "running",
        nodeId: failedNode.id,
        reason: patch.reason,
        patch,
      });
      emitStateChange({ type: MacroWorkflowEventKind.REPLAN_APPLIED, planId: plan.id, nodeId: failedNode.id, reason: patch.reason, timestamp: new Date() });
      continue;
    }

    for (const { node, result } of batchResults) {
      const expansion = await expandDynamicNodes({
        node,
        result,
        remainingPlan,
        payloads,
        completedNodeIds,
        expander: dependencies.expandAfterNode,
      });
      if (expansion.failed) {
        state.status = "failed";
        state.completedAt = new Date();
        emitReplayEvent({
          kind: WorkflowReplayEventKind.RUN_COMPLETED,
          phase: "completed",
          status: WorkflowNodeState.FAILED,
        });
        emitStateChange({ type: MacroWorkflowEventKind.RUN_COMPLETED, planId: plan.id, status: "failed", reason: expansion.error, timestamp: new Date() });
        return state;
      }
      if (expansion.nodes.length > 0) {
        remainingPlan = expansion.plan;
        state.plan = remainingPlan;
        state.currentPlan = remainingPlan;
        for (const node of expansion.nodes) {
          emitReplayEvent({
            kind: WorkflowReplayEventKind.NODE_ADDED,
            phase: "running",
            nodeId: node.id,
            node,
          });
        }
      }
      emitStateChange({
        type: MacroWorkflowEventKind.NODE_COMPLETED,
        planId: plan.id,
        nodeId: node.id,
        status: result.status,
        timestamp: new Date(),
      });
      completedNodeIds.add(node.id);
    }
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

async function expandDynamicNodes(args: {
  node: RuntimeWorkflowNode;
  result: WorkflowNodeExecutionResult;
  remainingPlan: RuntimeWorkflowPlan;
  payloads: Map<string, WorkflowNodePayload>;
  completedNodeIds: Set<string>;
  expander?: WorkflowDynamicExpander;
}): Promise<{ failed: false; plan: RuntimeWorkflowPlan; nodes: RuntimeWorkflowNode[] } | { failed: true; error: string }> {
  if (!args.expander) {
    return { failed: false, plan: args.remainingPlan, nodes: [] };
  }

  let nodes: RuntimeWorkflowNode[];
  try {
    nodes = await args.expander({
      node: args.node,
      result: args.result,
      currentPlan: args.remainingPlan,
      payloads: args.payloads,
      completedNodeIds: args.completedNodeIds,
    }) ?? [];
  } catch (error) {
    return { failed: true, error: error instanceof Error ? error.message : String(error) };
  }

  if (nodes.length === 0) {
    return { failed: false, plan: args.remainingPlan, nodes: [] };
  }

  const existingIds = new Set(args.remainingPlan.nodes.map((node) => node.id));
  const newNodes = nodes.filter((node) => !existingIds.has(node.id));
  if (newNodes.length === 0) {
    return { failed: false, plan: args.remainingPlan, nodes: [] };
  }

  const expandedPlan = {
    ...args.remainingPlan,
    nodes: [...args.remainingPlan.nodes, ...newNodes],
  };
  const verification = verifyWorkflowPlan(expandedPlan);
  if (!verification.valid) {
    return {
      failed: true,
      error: verification.issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"),
    };
  }

  return { failed: false, plan: expandedPlan, nodes: newNodes };
}

function selectReadyNodes(plan: RuntimeWorkflowPlan, completedNodeIds: Set<string>): RuntimeWorkflowPlan["nodes"] {
  return plan.nodes.filter((node) => !completedNodeIds.has(node.id) && node.dependsOn.every((dependency) => completedNodeIds.has(dependency)));
}

function shouldRunNode(
  node: RuntimeWorkflowPlan["nodes"][number],
  payloads: Map<string, WorkflowNodePayload>,
): boolean {
  if (!node.runWhen) {
    return true;
  }
  const payload = payloads.get(node.runWhen.nodeId);
  return readPath(payload, node.runWhen.key) === node.runWhen.equals;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, value);
}

async function executeNode(
  node: RuntimeWorkflowPlan["nodes"][number],
  context: WorkflowExecutionContext,
  harnesses?: HarnessRegistry,
): Promise<WorkflowNodeExecutionResult> {
  const adapter = harnesses ? resolveHarnessAdapter(harnesses, node.harness) : undefined;
  if (!adapter) {
    return { nodeId: node.id, status: WorkflowNodeState.PASSED, output: `No harness registered for ${node.harness}.` };
  }

  let result;
  try {
    result = await adapter(node, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      nodeId: node.id,
      status: WorkflowNodeState.FAILED,
      output: message,
      error: message,
      execution: context.preparedExecution ?? inferFailedNodeExecution(node),
    };
  }
  return {
    nodeId: node.id,
    status: result.status,
    output: result.output,
    error: result.error,
    payload: result.payload,
    artifacts: result.artifacts,
    execution: result.execution ?? context.preparedExecution,
  };
}

async function prepareNodeExecution(
  node: RuntimeWorkflowPlan["nodes"][number],
  context: WorkflowExecutionContext,
  harnesses?: HarnessRegistry,
): Promise<{ execution?: WorkflowExecutionMetadata; warning?: string }> {
  const adapter = harnesses ? resolveHarnessAdapter(harnesses, node.harness) : undefined;
  try {
    return { execution: await adapter?.prepareExecution?.(node, context) };
  } catch (error) {
    return { warning: `Harness ${node.harness} prepareExecution failed for ${node.id}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function inferFailedNodeExecution(node: RuntimeWorkflowNode): WorkflowExecutionMetadata {
  const mode = inferExecutionMode(node);
  const call = {
    executor: node.harness,
    mode,
    prompt: node.prompt,
    model: node.model,
  };
  return {
    executor: call.executor,
    mode: call.mode,
    prompt: call.prompt,
    model: call.model,
    calls: [call],
  };
}

function inferExecutionMode(node: RuntimeWorkflowNode): string {
  if (node.kind === "research") return "research";
  if (node.kind === "planning" || node.kind === "visualization") return "plan";
  if (node.kind === "implementation") return "implement";
  if (node.kind === "deliberation") return "review";
  if (node.kind === "verification") return "verify";
  if (node.kind === "report") return "report";
  return node.kind;
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
    return undefined;
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
