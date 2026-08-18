import { TrellageHeadlessTerminal, type TrellageHeadlessResult } from "../contracts.js";
import {
  boundToolUseEvidence,
  malformedResult,
  normalizeTokenUsage,
  parseJsonLines,
  readBoolean,
  isJsonRecord,
  readNonNegativeNumber,
  readRecord,
  readString,
  readStringArray,
  readTextContent,
  type HeadlessAdapterInput,
  type JsonRecord,
  type TrellageHeadlessAdapter,
} from "./contracts.js";

function isClaudeResult(event: JsonRecord): boolean {
  return readString(event, "type") === "result";
}

function claudeToolUseEvidence(events: readonly JsonRecord[]) {
  const entries: Array<{ name: string; selector?: string }> = [];
  for (const event of events) {
    if (readString(event, "type") !== "assistant") continue;
    const message = readRecord(event, "message");
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isJsonRecord(part) || readString(part, "type") !== "tool_use") continue;
      const name = readString(part, "name");
      if (!name) continue;
      const toolInput = readRecord(part, "input");
      const selector =
        name === "Skill"
          ? readString(toolInput, "skill")
          : name === "Agent"
            ? readString(toolInput, "subagent_type")
            : undefined;
      entries.push({ name, ...(selector ? { selector } : {}) });
    }
  }
  return boundToolUseEvidence(entries);
}

/**
 * Normalizes Claude Code `--output-format stream-json` output.
 *
 * Bad individual lines are retained as warnings. Absence of the required `result` event is a
 * malformed terminal contract, even if the process exits with code zero.
 */
export const claudeHeadlessAdapter: TrellageHeadlessAdapter = {
  parse(input: HeadlessAdapterInput): TrellageHeadlessResult {
    const { events, warnings } = parseJsonLines(input.stdout);
    const resultEvent = [...events].reverse().find(isClaudeResult);
    if (!resultEvent) {
      return malformedResult([...warnings, "missing Claude result event"]);
    }

    const usage = readRecord(resultEvent, "usage");
    const tokenUsage = normalizeTokenUsage(usage);
    const toolEvidence = claudeToolUseEvidence(events);
    const isError = readBoolean(resultEvent, "is_error", "isError");
    const subtype = readString(resultEvent, "subtype");
    const reportedSuccess =
      isError === undefined ? subtype === "success" : !isError && subtype !== "error";
    const finalText = readTextContent(resultEvent);
    const result: TrellageHeadlessResult = {
      terminal: reportedSuccess
        ? TrellageHeadlessTerminal.Completed
        : TrellageHeadlessTerminal.Failed,
      ...(finalText ? { finalText } : {}),
      ...(readString(resultEvent, "session_id", "sessionId")
        ? { sessionId: readString(resultEvent, "session_id", "sessionId") }
        : {}),
      reportedSuccess,
      ...(reportedSuccess
        ? {}
        : {
            harnessError:
              readString(resultEvent, "error", "error_message") ??
              "Claude reported an unsuccessful result.",
          }),
      permissionDenials: readStringArray(resultEvent, "permission_denials", "permissionDenials"),
      ...(usage ? { usage } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(readNonNegativeNumber(resultEvent, "total_cost_usd", "cost_usd", "costUsd") !== undefined
        ? {
            costUsd: readNonNegativeNumber(resultEvent, "total_cost_usd", "cost_usd", "costUsd"),
          }
        : {}),
      ...(readNonNegativeNumber(resultEvent, "premium_requests", "premiumRequests") !== undefined
        ? {
            premiumRequests: readNonNegativeNumber(
              resultEvent,
              "premium_requests",
              "premiumRequests",
            ),
          }
        : {}),
      ...(readNonNegativeNumber(resultEvent, "duration_ms", "durationMs") !== undefined
        ? { durationMs: readNonNegativeNumber(resultEvent, "duration_ms", "durationMs") }
        : {}),
      ...(readNonNegativeNumber(resultEvent, "num_turns", "turns") !== undefined
        ? { turns: readNonNegativeNumber(resultEvent, "num_turns", "turns") }
        : {}),
      changedFiles: readStringArray(resultEvent, "changed_files", "changedFiles"),
      toolUses: toolEvidence.toolUses,
      toolUsesTruncated: toolEvidence.toolUsesTruncated,
      parseWarnings: warnings,
    };
    return result;
  },
};
