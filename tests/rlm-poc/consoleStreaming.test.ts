import { describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@github/copilot-sdk";
import { attachConsoleStreaming } from "../../src/rlm-poc/consoleStreaming.js";
import type { RlmSession } from "../../src/rlm-poc/session.js";

function fakeStreamingSession(): {
  session: RlmSession;
  emit: (event: SessionEvent) => void;
  unsubscribe: () => void;
} {
  let handler: ((event: SessionEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const session: RlmSession = {
    async sendAndWait() {
      return undefined;
    },
    async disconnect() {},
    on(h) {
      handler = h;
      return unsubscribe;
    },
  };
  return {
    session,
    emit: (event: SessionEvent) => handler?.(event),
    unsubscribe,
  };
}

describe("attachConsoleStreaming", () => {
  it("writes assistant.message_delta chunks to stdout, prefixed with the label", () => {
    const { session, emit } = fakeStreamingSession();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    attachConsoleStreaming(session, { label: "submind" });
    emit({
      type: "assistant.message_delta",
      id: "evt-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      ephemeral: true,
      data: { deltaContent: "Hello", messageId: "msg-1" },
    } as SessionEvent);

    const output = write.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("[submind]");
    expect(output).toContain("Hello");
    write.mockRestore();
  });

  it("writes tool.execution_start and tool.execution_complete lines", () => {
    const { session, emit } = fakeStreamingSession();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    attachConsoleStreaming(session, { label: "rlm default depth 1/3" });
    emit({
      type: "tool.execution_start",
      id: "evt-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      data: { toolCallId: "call-1", toolName: "rlm", arguments: { prompt: "hi" } },
    } as SessionEvent);
    emit({
      type: "tool.execution_complete",
      id: "evt-2",
      parentId: "evt-1",
      timestamp: new Date().toISOString(),
      data: { toolCallId: "call-1", success: true },
    } as SessionEvent);

    const output = write.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("-> rlm(");
    expect(output).toContain("<- rlm done");
    write.mockRestore();
  });

  it("returns a no-op unsubscribe when the session does not support streaming", () => {
    const session: RlmSession = {
      async sendAndWait() {
        return undefined;
      },
      async disconnect() {},
    };

    expect(() => attachConsoleStreaming(session, { label: "submind" })()).not.toThrow();
  });
});
