import type { SessionEvent } from "@github/copilot-sdk";
import { writeRlmOutput } from "./environment.js";
import type { RlmSession } from "./session.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

export type ConsoleStreamingOptions = {
  /** Short human-readable label prefixed on tool/lifecycle lines, e.g. "submind" or "rlm depth 2/3". */
  label: string;
  /** Recursion depth (submind = 0), used to indent output so nested/sibling calls are visually distinct. */
  depthUsed?: number;
};

const indentFor = (depthUsed?: number): string => "  ".repeat(depthUsed ?? 0);

/**
 * Subscribes a session's event stream to `process.stdout`, so recursive `rlm` calls are visible
 * in real time rather than only appearing once the whole tree of nested sessions finishes.
 *
 * Requires the session to have been created with `streaming: true` (see `buildSessionConfig` in
 * `session.ts`) so `assistant.message_delta`/`assistant.reasoning_delta` events are emitted.
 *
 * Returns an unsubscribe function; callers must invoke it once the session is done (mirroring the
 * unsubscribe returned by `session.on(...)`) to avoid leaking handlers.
 */
export function attachConsoleStreaming(
  session: RlmSession,
  options: ConsoleStreamingOptions,
): () => void {
  if (!session.on) {
    return () => {};
  }

  const { label, depthUsed } = options;
  const indent = indentFor(depthUsed);
  const toolNamesByCallId = new Map<string, string>();
  let messageOpen = false;
  let reasoningOpen = false;

  const closeOpenStream = () => {
    if (messageOpen || reasoningOpen) {
      writeRlmOutput("\n");
      messageOpen = false;
      reasoningOpen = false;
    }
  };

  return session.on((event: SessionEvent) => {
    switch (event.type) {
      case "assistant.reasoning_delta": {
        if (!reasoningOpen) {
          closeOpenStream();
          writeRlmOutput(`${indent}${DIM}[${label}] (thinking) `);
          reasoningOpen = true;
        }
        writeRlmOutput(`${DIM}${event.data.deltaContent}${RESET}`);
        return;
      }
      case "assistant.message_delta": {
        if (!messageOpen) {
          closeOpenStream();
          writeRlmOutput(`${indent}${CYAN}[${label}]${RESET} `);
          messageOpen = true;
        }
        writeRlmOutput(event.data.deltaContent);
        return;
      }
      case "assistant.message": {
        closeOpenStream();
        return;
      }
      case "tool.execution_start": {
        closeOpenStream();
        toolNamesByCallId.set(event.data.toolCallId, event.data.toolName);
        const args = event.data.arguments ? JSON.stringify(event.data.arguments) : "{}";
        writeRlmOutput(`${indent}${GREEN}[${label}] -> ${event.data.toolName}(${args})${RESET}\n`);
        return;
      }
      case "tool.execution_complete": {
        closeOpenStream();
        const toolName =
          toolNamesByCallId.get(event.data.toolCallId) ??
          event.data.toolDescription?.name ??
          "tool";
        toolNamesByCallId.delete(event.data.toolCallId);
        const mark = event.data.success ? `${GREEN}<-` : `${RED}<-`;
        const suffix = event.data.success ? "" : ` (${event.data.error?.message ?? "failed"})`;
        writeRlmOutput(`${indent}${mark} ${toolName} done${suffix}${RESET}\n`);
        return;
      }
      default:
        return;
    }
  });
}
