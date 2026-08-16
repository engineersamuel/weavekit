import { TrellageHeadlessTerminal, type TrellageHeadlessResult } from "../contracts.js";

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
