import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TokenUsage } from "promptfoo";
import {
  WorkflowNodeStatus,
  type MacroWorkflowRunStateLike,
  type WorkflowUsageSummary,
} from "../../macro-workflow/types.js";

type CompletedWorkflowStatus = Extract<
  MacroWorkflowRunStateLike["status"],
  typeof WorkflowNodeStatus.PASSED | typeof WorkflowNodeStatus.FAILED
>;

export type WeavekitRunMetadata = {
  runId: string;
  status: CompletedWorkflowStatus;
  failure?: string;
  tokenUsage?: TokenUsage;
  estimatedCostUsd?: number;
};

export async function loadWeavekitRunMetadata(runDir: string): Promise<WeavekitRunMetadata> {
  const statePath = join(runDir, "workflow-state.json");
  let state: Record<string, unknown>;
  try {
    state = requireRecord(JSON.parse(await readFile(statePath, "utf8")), "root");
  } catch (error) {
    throw new Error(`Invalid workflow-state.json at ${statePath}: ${errorMessage(error)}`);
  }

  try {
    return normalizeState(state);
  } catch (error) {
    throw new Error(`Invalid workflow-state.json at ${statePath}: ${errorMessage(error)}`);
  }
}

function normalizeState(state: Record<string, unknown>): WeavekitRunMetadata {
  const runId = requireNonEmptyString(state.runId, "runId");
  const status = requireCompletedStatus(state.status);
  const nodeResults = requireArray(state.nodeResults, "nodeResults");
  const failure = status === WorkflowNodeStatus.FAILED ? readFailure(nodeResults) : undefined;
  if (status === WorkflowNodeStatus.FAILED && !failure) {
    throw new Error("failed state has no node failure detail");
  }
  const usage = normalizeUsage(state.usage);
  return {
    runId,
    status,
    ...(failure ? { failure } : {}),
    ...(usage.tokenUsage ? { tokenUsage: usage.tokenUsage } : {}),
    ...(usage.estimatedCostUsd !== undefined ? { estimatedCostUsd: usage.estimatedCostUsd } : {}),
  };
}

function normalizeUsage(value: unknown): {
  tokenUsage?: TokenUsage;
  estimatedCostUsd?: number;
} {
  if (value === undefined) return {};
  const usage = requireRecord(value, "usage") as Partial<WorkflowUsageSummary>;
  const prompt = optionalNonNegativeNumber(usage.inputTokens, "usage.inputTokens");
  const completion = optionalNonNegativeNumber(usage.outputTokens, "usage.outputTokens");
  const cached = optionalNonNegativeNumber(usage.cachedInputTokens, "usage.cachedInputTokens");
  const reportedTotal = optionalNonNegativeNumber(usage.totalTokens, "usage.totalTokens");
  const estimatedCostUsd = optionalNonNegativeNumber(
    usage.estimatedCostUsd,
    "usage.estimatedCostUsd",
  );
  const hasTokens =
    prompt !== undefined ||
    completion !== undefined ||
    cached !== undefined ||
    reportedTotal !== undefined;
  if (!hasTokens) {
    return estimatedCostUsd === undefined ? {} : { estimatedCostUsd };
  }
  const tokenUsage = {
    prompt: prompt ?? 0,
    completion: completion ?? 0,
    cached: cached ?? 0,
    total: reportedTotal ?? (prompt ?? 0) + (completion ?? 0),
  };
  return {
    tokenUsage,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  };
}

function readFailure(nodeResults: unknown[]): string | undefined {
  for (const value of nodeResults) {
    const result = requireRecord(value, "nodeResults[]");
    if (result.status !== WorkflowNodeStatus.FAILED) continue;
    const error = optionalNonEmptyString(result.error, "nodeResults[].error");
    if (error) return error;
    const output = optionalNonEmptyString(result.output, "nodeResults[].output");
    if (output) return output;
  }
  return undefined;
}

function requireCompletedStatus(value: unknown): CompletedWorkflowStatus {
  if (value === WorkflowNodeStatus.PASSED || value === WorkflowNodeStatus.FAILED) return value;
  throw new Error(`status must be passed or failed, received ${String(value)}`);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  const normalized = optionalNonEmptyString(value, path);
  if (!normalized) throw new Error(`${path} must be a non-empty string`);
  return normalized;
}

function optionalNonEmptyString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  const normalized = value.trim();
  return normalized || undefined;
}

function optionalNonNegativeNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a finite non-negative number`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
