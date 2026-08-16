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

function eventType(event: JsonRecord): string | undefined {
  return readString(event, "type", "event");
}

function isResult(event: JsonRecord): boolean {
  return eventType(event) === "result";
}

function isTaskComplete(event: JsonRecord): boolean {
  return eventType(event) === "session.task_complete";
}

function isAssistantMessage(event: JsonRecord): boolean {
  return eventType(event) === "assistant.message";
}

function eventData(event: JsonRecord): JsonRecord {
  return readRecord(event, "data") ?? event;
}

/**
 * Normalizes Copilot CLI JSONL output.
 *
 * Copilot has two terminal signals: `session.task_complete` contains the task summary and
 * `result` reports process success. Both are required so a success-shaped process result cannot
 * silently stand in for task completion.
 */
export const copilotHeadlessAdapter: TrellageHeadlessAdapter = {
  parse(input: HeadlessAdapterInput): TrellageHeadlessResult {
    const { events, warnings } = parseJsonLines(input.stdout);
    const resultEvent = [...events].reverse().find(isResult);
    const taskCompleteEvent = [...events].reverse().find(isTaskComplete);
    const assistantMessages = [...events].reverse().filter(isAssistantMessage);
    const questionMessageEvent = assistantMessages.find((event) =>
      readTextContent(eventData(event))?.includes("<trellage_questions"),
    );
    const assistantMessageEvent = assistantMessages.find((event) =>
      Boolean(readTextContent(eventData(event))),
    );
    const assistantText = questionMessageEvent
      ? readTextContent(eventData(questionMessageEvent))
      : assistantMessageEvent
        ? readTextContent(eventData(assistantMessageEvent))
        : undefined;
    const isQuestionTurn = Boolean(questionMessageEvent);
    if (!resultEvent) return malformedResult([...warnings, "missing Copilot result event"]);
    if (!taskCompleteEvent && !isQuestionTurn) {
      return malformedResult([...warnings, "missing Copilot session.task_complete event"]);
    }
    const resultData = eventData(resultEvent);
    const taskData = taskCompleteEvent ? eventData(taskCompleteEvent) : undefined;
    const taskSuccess = taskData
      ? readBoolean(taskData, "success", "is_success", "isSuccess")
      : true;
    if (taskCompleteEvent && taskSuccess === undefined) {
      return malformedResult([
        ...warnings,
        "Copilot session.task_complete event did not contain success",
      ]);
    }
    const exitCode = readNumber(resultData, "exitCode", "exit_code");
    const legacyProcessSuccess = readBoolean(resultData, "success", "is_success", "isSuccess");
    const processSuccess = exitCode === undefined ? legacyProcessSuccess === true : exitCode === 0;
    const success = taskSuccess && processSuccess;
    const finalText = isQuestionTurn
      ? assistantText
      : (readTextContent(taskData ?? {}) ?? assistantText ?? readTextContent(resultData));
    const sessionStart = events.find((event) => eventType(event) === "session.start");
    const sessionData = eventData(sessionStart ?? {});
    const usage = readRecord(resultData, "usage") ?? readRecord(taskData, "usage");
    const codeChanges = readRecord(usage, "codeChanges");
    const changedFiles = [
      ...readStringArray(resultData, "changed_files", "changedFiles"),
      ...readStringArray(taskData, "changed_files", "changedFiles"),
      ...readStringArray(codeChanges, "filesModified", "files_modified"),
    ];

    return {
      terminal: success ? TrellageHeadlessTerminal.Completed : TrellageHeadlessTerminal.Failed,
      ...(finalText ? { finalText } : {}),
      ...((readString(resultData, "session_id", "sessionId") ??
      readString(taskData, "session_id", "sessionId") ??
      readString(sessionData, "session_id", "sessionId"))
        ? {
            sessionId:
              readString(resultData, "session_id", "sessionId") ??
              readString(taskData, "session_id", "sessionId") ??
              readString(sessionData, "session_id", "sessionId"),
          }
        : {}),
      reportedSuccess: success,
      ...(success
        ? {}
        : {
            harnessError:
              readString(resultData, "error", "error_message", "message") ??
              readString(taskData, "summary", "message") ??
              `Copilot reported an unsuccessful result${exitCode === undefined ? "" : ` (exit ${exitCode})`}.`,
          }),
      permissionDenials: [
        ...readStringArray(resultData, "permission_denials", "permissionDenials"),
        ...readStringArray(taskData, "permission_denials", "permissionDenials"),
      ],
      ...(usage ? { usage } : {}),
      ...(readNumber(resultData, "cost_usd", "costUsd", "total_cost_usd") !== undefined
        ? { costUsd: readNumber(resultData, "cost_usd", "costUsd", "total_cost_usd") }
        : {}),
      ...((readNumber(resultData, "premium_requests", "premiumRequests") ??
        readNumber(usage, "premium_requests", "premiumRequests")) !== undefined
        ? {
            premiumRequests:
              readNumber(resultData, "premium_requests", "premiumRequests") ??
              readNumber(usage, "premium_requests", "premiumRequests"),
          }
        : {}),
      ...((readNumber(resultData, "duration_ms", "durationMs") ??
        readNumber(usage, "sessionDurationMs", "session_duration_ms")) !== undefined
        ? {
            durationMs:
              readNumber(resultData, "duration_ms", "durationMs") ??
              readNumber(usage, "sessionDurationMs", "session_duration_ms"),
          }
        : {}),
      ...(readNumber(resultData, "turns", "num_turns") !== undefined
        ? { turns: readNumber(resultData, "turns", "num_turns") }
        : {}),
      changedFiles: [...new Set(changedFiles)],
      parseWarnings: warnings,
    };
  },
};
