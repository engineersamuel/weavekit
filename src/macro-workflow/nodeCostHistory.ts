import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkflowUsageRecord, WorkflowUsageSummary } from "./usage.js";

export type NodeCostHistoryEntry = {
  key: string;
  nodeId: string;
  harness?: string;
  model?: string;
  samples: number;
  averageTokens: number;
  costSamples?: number;
  averageCostUsd?: number;
  updatedAt: string;
};

export type NodeCostHistory = {
  version: 1;
  updatedAt: string;
  nodes: Record<string, NodeCostHistoryEntry>;
};

export function defaultNodeCostHistoryPath(): string {
  return join(homedir(), ".weavekit", "node-cost-history.json");
}

export function emptyNodeCostHistory(now = new Date()): NodeCostHistory {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    nodes: {},
  };
}

export async function loadNodeCostHistory(
  path = defaultNodeCostHistoryPath(),
): Promise<NodeCostHistory> {
  if (!existsSync(path)) {
    return emptyNodeCostHistory();
  }
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<NodeCostHistory>;
  return {
    version: 1,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    nodes: normalizeNodeCostEntries(parsed.nodes),
  };
}

export async function recordNodeCostHistoryFromUsage(args: {
  path?: string;
  summary: WorkflowUsageSummary;
  now?: Date;
}): Promise<NodeCostHistory> {
  const path = args.path ?? defaultNodeCostHistoryPath();
  const now = args.now ?? new Date();
  const history = await loadNodeCostHistory(path);
  const updatedAt = now.toISOString();
  let changed = false;

  for (const record of args.summary.records) {
    const next = updateNodeCostEntry(
      history.nodes[buildNodeCostHistoryKey(record)],
      record,
      updatedAt,
    );
    if (next) {
      history.nodes[next.key] = next;
      changed = true;
    }
  }

  if (!changed) {
    return history;
  }
  history.updatedAt = updatedAt;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  return history;
}

export function buildNodeCostHistoryKey(args: {
  nodeId?: string;
  harness?: string;
  executor?: string;
  model?: string;
}): string {
  return [
    normalizeKeyPart(args.harness ?? args.executor ?? "unknown-harness"),
    normalizeKeyPart(args.model ?? "unknown-model"),
    normalizeKeyPart(args.nodeId ?? "unknown-node"),
  ].join(":");
}

function updateNodeCostEntry(
  existing: NodeCostHistoryEntry | undefined,
  record: WorkflowUsageRecord,
  updatedAt: string,
): NodeCostHistoryEntry | undefined {
  if (!record.nodeId || record.totalTokens === undefined) {
    return undefined;
  }
  const samples = (existing?.samples ?? 0) + 1;
  const averageTokens = rollingAverage(
    existing?.averageTokens,
    existing?.samples,
    record.totalTokens,
  );
  const costSamples =
    record.estimatedCostUsd === undefined
      ? (existing?.costSamples ?? 0)
      : (existing?.costSamples ?? 0) + 1;
  const averageCostUsd =
    record.estimatedCostUsd === undefined
      ? existing?.averageCostUsd
      : rollingAverage(existing?.averageCostUsd, existing?.costSamples, record.estimatedCostUsd);
  const key = buildNodeCostHistoryKey(record);
  return {
    key,
    nodeId: record.nodeId,
    harness: record.executor,
    model: record.model,
    samples,
    averageTokens,
    ...(costSamples <= 0 ? {} : { costSamples }),
    ...(averageCostUsd === undefined ? {} : { averageCostUsd }),
    updatedAt,
  };
}

function rollingAverage(
  previousAverage: number | undefined,
  previousSamples: number | undefined,
  nextValue: number,
): number {
  const samples = previousSamples ?? 0;
  if (samples <= 0 || previousAverage === undefined) {
    return nextValue;
  }
  return (previousAverage * samples + nextValue) / (samples + 1);
}

function normalizeNodeCostEntries(
  value: NodeCostHistory["nodes"] | undefined,
): Record<string, NodeCostHistoryEntry> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, NodeCostHistoryEntry] => {
      const node = entry[1];
      return (
        node &&
        typeof node === "object" &&
        typeof node.key === "string" &&
        typeof node.nodeId === "string" &&
        typeof node.samples === "number" &&
        typeof node.averageTokens === "number"
      );
    }),
  );
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}
