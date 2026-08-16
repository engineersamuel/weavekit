import { TrellageHeadlessTerminal, type TrellageHeadlessResult } from "../contracts.js";
import {
  malformedResult,
  parseJsonLines,
  readBoolean,
  readNumber,
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
      ...(readNumber(resultEvent, "total_cost_usd", "cost_usd", "costUsd") !== undefined
        ? { costUsd: readNumber(resultEvent, "total_cost_usd", "cost_usd", "costUsd") }
        : {}),
      ...(readNumber(resultEvent, "premium_requests", "premiumRequests") !== undefined
        ? { premiumRequests: readNumber(resultEvent, "premium_requests", "premiumRequests") }
        : {}),
      ...(readNumber(resultEvent, "duration_ms", "durationMs") !== undefined
        ? { durationMs: readNumber(resultEvent, "duration_ms", "durationMs") }
        : {}),
      ...(readNumber(resultEvent, "num_turns", "turns") !== undefined
        ? { turns: readNumber(resultEvent, "num_turns", "turns") }
        : {}),
      changedFiles: readStringArray(resultEvent, "changed_files", "changedFiles"),
      parseWarnings: warnings,
    };
    return result;
  },
};
