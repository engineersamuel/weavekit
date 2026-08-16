import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@github/copilot-sdk";
import { snapshotConversation } from "../../src/rlm-poc/conversationContext.js";
import type { RlmSession } from "../../src/rlm-poc/session.js";

const event = (type: SessionEvent["type"], data: unknown, id: string): SessionEvent =>
  ({
    type,
    data,
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
  }) as SessionEvent;

describe("snapshotConversation", () => {
  it("preserves root instructions, messages, tool calls, and returned recursive results", async () => {
    const events: SessionEvent[] = [
      event(
        "system.message",
        { role: "system", content: "Develop a psychological profile." },
        "system",
      ),
      event("user.message", { content: "Interview the subject." }, "user"),
      event("assistant.message", { content: "I will ask three questions.", messageId: "a1" }, "a1"),
      event(
        "tool.execution_start",
        {
          toolCallId: "call-1",
          toolName: "rlm",
          arguments: { prompt: "What is your favorite book?", profile: "default" },
        },
        "tool-start",
      ),
      event(
        "tool.execution_complete",
        {
          toolCallId: "call-1",
          success: true,
          result: { content: "Gödel, Escher, Bach." },
        },
        "tool-complete",
      ),
    ];
    const session: RlmSession = {
      async sendAndWait() {
        return undefined;
      },
      async getEvents() {
        return events;
      },
      async disconnect() {},
    };

    const snapshot = await snapshotConversation({ current: session });

    expect(snapshot).toContain("[user] Interview the subject.");
    expect(snapshot).toContain("[assistant] I will ask three questions.");
    expect(snapshot).toContain('[assistant tool call] rlm {"prompt":"What is your favorite book?"');
    expect(snapshot).toContain("[tool result: rlm; success] Gödel, Escher, Bach.");
    expect(snapshot).not.toContain("Develop a psychological profile.");
  });

  it("uses explicit root instructions instead of copying SDK system-message events", async () => {
    const session: RlmSession = {
      async sendAndWait() {
        return undefined;
      },
      async getEvents() {
        return [
          event(
            "system.message",
            { role: "system", content: "Large internal Copilot CLI harness prompt." },
            "system",
          ),
          event("user.message", { content: "Profile the subject." }, "user"),
        ];
      },
      async disconnect() {},
    };

    const snapshot = await snapshotConversation({
      current: session,
      instructions: "Use prior interview answers.",
    });

    expect(snapshot).toContain("[parent instructions]\nUse prior interview answers.");
    expect(snapshot).toContain("[user] Profile the subject.");
    expect(snapshot).not.toContain("internal Copilot CLI harness prompt");
  });

  it("retains the root request before the active user turn is persisted", async () => {
    const session: RlmSession = {
      async sendAndWait() {
        return undefined;
      },
      async getEvents() {
        return [];
      },
      async disconnect() {},
    };

    const snapshot = await snapshotConversation({
      current: session,
      initialPrompt: "The deployment color is teal.",
    });

    expect(snapshot).toBe("[root user request]\nThe deployment color is teal.");
  });

  it("fails explicitly when the root session cannot provide its conversation", async () => {
    await expect(snapshotConversation({})).rejects.toThrow(/conversation is unavailable/iu);
  });
});
