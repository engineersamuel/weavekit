import {
  TrellageHeadlessTerminal,
  type TrellageHeadlessResult,
  type TrellageTokenUsage,
  type TrellageToolUseEvidence,
} from "../contracts.js";

export const MAX_TOOL_USE_EVIDENCE_ENTRIES = 64;
export const MAX_TOOL_USE_EVIDENCE_STRING_LENGTH = 128;

export type JsonRecord = Record<string, unknown>;

export type ParsedJsonLines = {
  events: JsonRecord[];
  warnings: string[];
};

export type HeadlessAdapterInput = {
  stdout: string;
  stderr: string;
};

export type TrellageHeadlessAdapter = {
  parse(input: HeadlessAdapterInput): TrellageHeadlessResult;
};

type ToolUseEvidenceInput = {
  name: string;
  selector?: string;
  count?: number;
};

export function parseJsonLines(stdout: string): ParsedJsonLines {
  const events: JsonRecord[] = [];
  const warnings: string[] = [];
  for (const [index, line] of stdout.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (!isJsonRecord(value)) {
        warnings.push(`line ${index + 1}: event was not an object`);
        continue;
      }
      events.push(value);
    } catch {
      warnings.push(`line ${index + 1}: invalid JSON`);
    }
  }
  return { events, warnings };
}

export function malformedResult(parseWarnings: string[]): TrellageHeadlessResult {
  return {
    terminal: TrellageHeadlessTerminal.Malformed,
    permissionDenials: [],
    changedFiles: [],
    parseWarnings,
  };
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(
  record: JsonRecord | undefined,
  ...keys: readonly string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function readBoolean(
  record: JsonRecord | undefined,
  ...keys: readonly string[]
): boolean | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

export function readNumber(
  record: JsonRecord | undefined,
  ...keys: readonly string[]
): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function readNonNegativeNumber(
  record: JsonRecord | undefined,
  ...keys: readonly string[]
): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

export function normalizeTokenUsage(
  ...records: readonly (JsonRecord | undefined)[]
): TrellageTokenUsage | undefined {
  const inputTokens = readFirstNonNegativeNumber(records, [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
  ]);
  const outputTokens = readFirstNonNegativeNumber(records, [
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
  ]);
  const cachedInputTokens = readFirstNonNegativeNumber(records, [
    "cachedInputTokens",
    "cached_input_tokens",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
    "cacheReadTokens",
    "cache_read_tokens",
  ]);
  const cacheCreationInputTokens = readFirstNonNegativeNumber(records, [
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
    "cacheWriteTokens",
    "cache_write_tokens",
  ]);
  const totalTokens = readFirstNonNegativeNumber(records, ["totalTokens", "total_tokens"]);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

export function aggregateTokenUsage(
  usages: readonly (TrellageTokenUsage | undefined)[],
): TrellageTokenUsage | undefined {
  const inputTokens = sumOptionalNumbers(usages.map((usage) => usage?.inputTokens));
  const outputTokens = sumOptionalNumbers(usages.map((usage) => usage?.outputTokens));
  const cachedInputTokens = sumOptionalNumbers(usages.map((usage) => usage?.cachedInputTokens));
  const cacheCreationInputTokens = sumOptionalNumbers(
    usages.map((usage) => usage?.cacheCreationInputTokens),
  );
  const totalTokens = sumOptionalNumbers(usages.map((usage) => usage?.totalTokens));
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

export function boundToolUseEvidence(
  entries: readonly ToolUseEvidenceInput[],
  inheritedTruncation = false,
): { toolUses: TrellageToolUseEvidence[]; toolUsesTruncated: boolean } {
  const toolUses = new Map<string, TrellageToolUseEvidence>();
  let toolUsesTruncated = inheritedTruncation;
  for (const entry of entries) {
    if (entry.count !== undefined && (!Number.isSafeInteger(entry.count) || entry.count <= 0)) {
      continue;
    }
    const name = boundEvidenceString(entry.name);
    if (!name.value) continue;
    const selector = entry.selector === undefined ? undefined : boundEvidenceString(entry.selector);
    toolUsesTruncated ||= name.truncated || selector?.truncated === true;
    const key = JSON.stringify([name.value, selector?.value]);
    const existing = toolUses.get(key);
    const count = entry.count ?? 1;
    if (existing) {
      const combinedCount = existing.count + count;
      if (Number.isSafeInteger(combinedCount)) {
        existing.count = combinedCount;
      } else {
        existing.count = Number.MAX_SAFE_INTEGER;
        toolUsesTruncated = true;
      }
      continue;
    }
    if (toolUses.size >= MAX_TOOL_USE_EVIDENCE_ENTRIES) {
      toolUsesTruncated = true;
      continue;
    }
    toolUses.set(key, {
      name: name.value,
      ...(selector?.value ? { selector: selector.value } : {}),
      count,
    });
  }
  return { toolUses: [...toolUses.values()], toolUsesTruncated };
}

function readFirstNonNegativeNumber(
  records: readonly (JsonRecord | undefined)[],
  keys: readonly string[],
): number | undefined {
  for (const record of records) {
    const value = readNonNegativeNumber(record, ...keys);
    if (value !== undefined) return value;
  }
  return undefined;
}

function sumOptionalNumbers(values: readonly (number | undefined)[]): number | undefined {
  let total: number | undefined;
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value) || value < 0) continue;
    const next = (total ?? 0) + value;
    if (!Number.isFinite(next)) return undefined;
    total = next;
  }
  return total;
}

function boundEvidenceString(value: string): { value: string; truncated: boolean } {
  if (value.length <= MAX_TOOL_USE_EVIDENCE_STRING_LENGTH) {
    return { value, truncated: false };
  }
  return {
    value: value.slice(0, MAX_TOOL_USE_EVIDENCE_STRING_LENGTH),
    truncated: true,
  };
}

export function readRecord(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  const value = record?.[key];
  return isJsonRecord(value) ? value : undefined;
}

export function readStringArray(
  record: JsonRecord | undefined,
  ...keys: readonly string[]
): string[] {
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }
  }
  return [];
}

export function readTextContent(event: JsonRecord): string | undefined {
  const direct = readString(event, "result", "text", "content", "summary", "message");
  if (direct) return direct;
  const message = readRecord(event, "message");
  const messageText = readString(message, "text", "content");
  if (messageText) return messageText;
  const content = event.content ?? message?.content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((part) => (isJsonRecord(part) ? readString(part, "text") : undefined))
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

export function terminalFailure(
  event: JsonRecord,
  parseWarnings: string[],
): TrellageHeadlessResult {
  const data = readRecord(event, "data");
  return {
    terminal: TrellageHeadlessTerminal.Failed,
    ...(readTextContent(data ?? event) ? { finalText: readTextContent(data ?? event) } : {}),
    ...(readString(data ?? event, "error", "error_message", "message")
      ? { harnessError: readString(data ?? event, "error", "error_message", "message") }
      : {}),
    permissionDenials: readStringArray(data ?? event, "permission_denials", "permissionDenials"),
    changedFiles: readStringArray(data ?? event, "changed_files", "changedFiles"),
    parseWarnings,
  };
}
