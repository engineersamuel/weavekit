import type {
  MacroWorkflowRunStateLike,
  RuntimeWorkflowNode,
  WorkflowExecutionCall,
  WorkflowExecutionMetadata,
  WorkflowNodeExecutionResult,
} from "../types.js";
import { WorkflowHarnessKind, WorkflowNodeStatus } from "../types.js";

const PLANNING_NODE_ID = "workflow-planning";

export type NodeExecutionDisplay = {
  plannedPrompt: string;
  execution?: WorkflowExecutionMetadata;
  calls: WorkflowExecutionCall[];
  hasActualExecution: boolean;
};

export type BlockedNodeDisplay = {
  blocked: boolean;
  failedDependencies: Array<{
    nodeId: string;
    title: string;
    error?: string;
  }>;
  message: string;
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
  const execution = args.result?.execution ??
    (args.node?.id ? args.state?.activeNodeExecutions?.[args.node.id] : undefined) ??
    inferPreparedExecutionFromNode(args.node);
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

export function resolveBlockedNodeDisplay(
  node: RuntimeWorkflowNode | undefined,
  state: MacroWorkflowRunStateLike | undefined,
): BlockedNodeDisplay {
  const failedDependencies = (node?.dependsOn ?? []).flatMap((dependencyId) => {
    const result = state?.nodeResults?.find((entry) => entry.nodeId === dependencyId);
    if (result?.status !== WorkflowNodeStatus.FAILED) {
      return [];
    }
    const dependencyNode = state?.currentPlan?.nodes.find((candidate) => candidate.id === dependencyId) ??
      state?.plan?.nodes.find((candidate) => candidate.id === dependencyId);
    return [{
      nodeId: dependencyId,
      title: dependencyNode?.title ?? dependencyId,
      error: result.error ?? result.output,
    }];
  });
  const count = failedDependencies.length;
  return {
    blocked: count > 0,
    failedDependencies,
    message: count === 0
      ? "This node is waiting for its dependencies."
      : `This node did not run because ${count} ${count === 1 ? "dependency" : "dependencies"} failed.`,
  };
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

function inferPreparedExecutionFromNode(node: RuntimeWorkflowNode | undefined): WorkflowExecutionMetadata | undefined {
  if (node?.harness !== WorkflowHarnessKind.RESEARCH || node.input?.deepResearchStep !== "provider-research") {
    return undefined;
  }
  const provider = readString(node.input, "provider");
  const prompt = buildDeepResearchProviderPrompt({
    provider,
    objective: readString(node.input, "objective") ?? node.prompt,
    questions: readQuestionInputs(node.input.questions),
    queries: readStringArray(node.input.queries),
    maxResultsPerQuestion: readNumber(node.input, "maxResultsPerQuestion") ?? 0,
  });
  if (!provider || !prompt) {
    return undefined;
  }
  const call: WorkflowExecutionCall = {
    executor: provider,
    operation: "search",
    mode: "research",
    prompt,
    model: deepResearchProviderModel(provider),
  };
  return {
    executor: WorkflowHarnessKind.RESEARCH,
    calls: [call],
  };
}

function buildDeepResearchProviderPrompt(args: {
  provider: string | undefined;
  objective: string;
  questions: Array<{ id: string; text: string; searchQueries: string[] }>;
  queries: string[];
  maxResultsPerQuestion: number;
}): string | undefined {
  if (!args.provider) {
    return undefined;
  }
  if (args.provider === "grok") {
    return [
      "Use x_search for each query below. Return concise markdown with URLs, titles, and excerpts.",
      `Objective: ${args.objective}`,
      `Provider result limit per question: ${args.maxResultsPerQuestion}`,
      "",
      "Questions:",
      ...args.questions.map((question) => `- ${question.id}: ${question.text}`),
      "",
      "Queries:",
      ...args.queries.map((query) => `- ${query}`),
    ].join("\n");
  }
  if (args.provider === "copilot-last30days") {
    return [
      "/last30days Research recent community and web discussion from the last 30 days for this deep-research provider node.",
      "",
      `Objective: ${args.objective}`,
      `Provider result limit per question: ${args.maxResultsPerQuestion}`,
      "",
      "Return a concise synthesis with concrete source names, URLs when available, disagreement, recency signals, and confidence limits.",
      "",
      "Questions:",
      ...args.questions.map((question) => [
        `- ${question.id}: ${question.text}`,
        question.searchQueries.length > 0 ? `  Search queries: ${question.searchQueries.join("; ")}` : undefined,
      ].filter(Boolean).join("\n")),
      "",
      "All provider-node search queries:",
      ...args.queries.map((query) => `- ${query}`),
    ].join("\n");
  }
  if (args.provider === "exa") {
    return [
      "Run Exa web search for each question/query pair below.",
      `Objective: ${args.objective}`,
      `Provider result limit per question: ${args.maxResultsPerQuestion}`,
      "",
      "Questions:",
      ...args.questions.map((question) => [
        `- ${question.id}: ${question.text}`,
        question.searchQueries.length > 0 ? `  Search queries: ${question.searchQueries.join("; ")}` : undefined,
      ].filter(Boolean).join("\n")),
      "",
      "All provider-node search queries:",
      ...args.queries.map((query) => `- ${query}`),
    ].join("\n");
  }
  return undefined;
}

function deepResearchProviderModel(provider: string): string {
  if (provider === "grok") {
    return "grok-default";
  }
  if (provider === "copilot-last30days" || provider === "exa") {
    return "claude-sonnet-5";
  }
  return "deterministic";
}

function readQuestionInputs(value: unknown): Array<{ id: string; text: string; searchQueries: string[] }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    const id = typeof record.id === "string" ? record.id : undefined;
    const text = typeof record.text === "string" ? record.text : undefined;
    if (!id || !text) {
      return [];
    }
    return [{
      id,
      text,
      searchQueries: readStringArray(record.searchQueries),
    }];
  });
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
