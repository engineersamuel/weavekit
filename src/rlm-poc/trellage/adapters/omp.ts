import { TrellageHeadlessTerminal, type TrellageHeadlessResult } from "../contracts.js";
import {
  malformedResult,
  normalizeTokenUsage,
  parseJsonLines,
  readRecord,
  readString,
  readTextContent,
  type HeadlessAdapterInput,
  type JsonRecord,
  type TrellageHeadlessAdapter,
} from "./contracts.js";

function eventType(event: JsonRecord): string | undefined {
  return readString(event, "type");
}

function isSession(event: JsonRecord): boolean {
  return eventType(event) === "session";
}

function isTurnEnd(event: JsonRecord): boolean {
  return eventType(event) === "turn_end";
}

function isTerminalAgentEnd(event: JsonRecord): boolean {
  return eventType(event) === "agent_end" && event.isTerminal === true;
}

function isError(event: JsonRecord): boolean {
  return eventType(event) === "error";
}

function errorMessage(event: JsonRecord): string {
  const data = readRecord(event, "data");
  const error = readRecord(data ?? event, "error");
  return (
    readString(error, "message", "error", "code") ??
    readString(data ?? event, "message", "error", "error_message", "code") ??
    readTextContent(error ?? data ?? event) ??
    "OMP emitted an error event."
  );
}

/**
 * Normalizes OMP's `--mode=json` JSONL output for its native `copilot` profile.
 *
 * OMP provides the resumable ID in its initial `session` event. Its response, model, and usage
 * belong to the last `turn_end.message`; only a terminal `agent_end` confirms clean completion.
 */
export const ompCopilotHeadlessAdapter: TrellageHeadlessAdapter = {
  parse(input: HeadlessAdapterInput): TrellageHeadlessResult {
    const { events, warnings } = parseJsonLines(input.stdout);
    const sessionEvent = events[0];
    const sessionId = isSession(sessionEvent ?? {}) ? readString(sessionEvent, "id") : undefined;
    const turnEndEvent = [...events].reverse().find(isTurnEnd);
    const turnMessage = readRecord(turnEndEvent, "message");
    const errorEvent = [...events].reverse().find(isError);
    const usage = readRecord(turnMessage, "usage");
    const tokenUsage = normalizeTokenUsage(usage);

    if (errorEvent) {
      return {
        terminal: TrellageHeadlessTerminal.Failed,
        ...(sessionId ? { sessionId } : {}),
        ...(turnMessage && readTextContent(turnMessage)
          ? { finalText: readTextContent(turnMessage) }
          : {}),
        ...(turnMessage && readString(turnMessage, "model")
          ? { model: readString(turnMessage, "model") }
          : {}),
        ...(usage ? { usage } : {}),
        ...(tokenUsage ? { tokenUsage } : {}),
        reportedSuccess: false,
        harnessError: errorMessage(errorEvent),
        permissionDenials: [],
        changedFiles: [],
        parseWarnings: warnings,
      };
    }

    if (!sessionEvent || !sessionId) {
      return malformedResult([...warnings, "missing OMP session event with id"]);
    }
    if (!turnMessage) {
      return malformedResult([...warnings, "missing OMP turn_end message"]);
    }
    if (!events.some(isTerminalAgentEnd)) {
      return malformedResult([...warnings, "missing terminal OMP agent_end event"]);
    }

    const finalText = readTextContent(turnMessage);
    const model = readString(turnMessage, "model");
    return {
      terminal: TrellageHeadlessTerminal.Completed,
      ...(finalText ? { finalText } : {}),
      sessionId,
      ...(model ? { model } : {}),
      reportedSuccess: true,
      permissionDenials: [],
      ...(usage ? { usage } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      changedFiles: [],
      parseWarnings: warnings,
    };
  },
};
