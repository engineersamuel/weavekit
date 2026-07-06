import type {
  MacroWorkflowRunStateLike,
  RuntimeWorkflowNode,
  WorkflowExecutionCall,
  WorkflowExecutionMetadata,
  WorkflowNodeExecutionResult,
} from "../types.js";
import { WorkflowHarnessKind } from "../types.js";

const PLANNING_NODE_ID = "workflow-planning";

export type NodeExecutionDisplay = {
  plannedPrompt: string;
  execution?: WorkflowExecutionMetadata;
  calls: WorkflowExecutionCall[];
  hasActualExecution: boolean;
};

export function resolveNodeExecutionDisplay(args: {
  node?: RuntimeWorkflowNode;
  result?: WorkflowNodeExecutionResult;
  state?: MacroWorkflowRunStateLike;
}): NodeExecutionDisplay {
  const isPlanningNode = args.node?.id === PLANNING_NODE_ID;
  const plannedPrompt = isPlanningNode
    ? args.state?.objective ?? "No original prompt recorded."
    : args.node?.prompt ?? "";
  const execution = args.result?.execution ?? (args.node?.id ? args.state?.activeNodeExecutions?.[args.node.id] : undefined);
  const calls = execution?.calls?.length ? execution.calls : inferExecutionCalls(args.node, execution);
  return {
    plannedPrompt,
    execution,
    calls,
    hasActualExecution: Boolean(execution),
  };
}

export function resolveNodeModelDisplay(node: RuntimeWorkflowNode | undefined, state: MacroWorkflowRunStateLike | undefined): string {
  const result = node?.id ? state?.nodeResults?.find((entry) => entry.nodeId === node.id) : undefined;
  const liveExecution = node?.id ? state?.activeNodeExecutions?.[node.id] : undefined;
  const resultCallModel = result?.execution?.calls?.find((call) => call.model)?.model;
  const liveCallModel = liveExecution?.calls?.find((call) => call.model)?.model;
  if (result?.execution?.model) {
    return result.execution.model;
  }
  if (resultCallModel) {
    return resultCallModel;
  }
  if (liveExecution?.model) {
    return liveExecution.model;
  }
  if (liveCallModel) {
    return liveCallModel;
  }
  if (node?.model) {
    return node.model;
  }
  if (node?.harness === WorkflowHarnessKind.VERIFIER || node?.harness === WorkflowHarnessKind.REPORTER || node?.model === "deterministic") {
    return "deterministic";
  }
  return "Not recorded";
}

function inferExecutionCalls(
  node: RuntimeWorkflowNode | undefined,
  execution: WorkflowExecutionMetadata | undefined,
): WorkflowExecutionCall[] {
  if (execution?.executor || execution?.prompt || execution?.operation || execution?.mode) {
    return [{
      executor: execution.executor ?? node?.harness ?? "unknown",
      operation: execution.operation,
      mode: execution.mode,
      prompt: execution.prompt,
      cwd: execution.cwd,
      model: execution.model,
    }];
  }
  return [];
}
