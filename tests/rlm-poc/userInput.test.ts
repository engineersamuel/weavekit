import { describe, expect, it, vi } from "vitest";
import { createSubmindUserInputHandler } from "../../src/rlm-poc/userInput.js";
import type { RlmClient, RlmSession } from "../../src/rlm-poc/session.js";

describe("createSubmindUserInputHandler", () => {
  it("gives the isolated answerer the complete root conversation snapshot", async () => {
    let sessionConfig: Record<string, unknown> | undefined;
    let sentPrompt: string | undefined;
    let sentTimeout: number | undefined;
    const answerSession: RlmSession = {
      async sendAndWait(options, timeout) {
        sentPrompt = options.prompt;
        sentTimeout = timeout;
        return { data: { content: "Blue." } };
      },
      async disconnect() {},
    };
    const client: RlmClient = {
      async start() {},
      async createSession(config) {
        sessionConfig = config;
        return answerSession;
      },
      async stop() {},
    };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const handler = createSubmindUserInputHandler({
      label: "test",
      delegatedPrompt: "Ask for a favorite color.",
      getConversationContext: async () =>
        "[system] Build a psychological profile.\n\n[tool result: rlm] Favorite book: Dune.",
      model: "test-model",
      clientFactory: () => client,
    });
    const result = await handler(
      { question: "What is your favorite color?" },
      { sessionId: "child-session" },
    );
    write.mockRestore();

    expect(result).toEqual({ answer: "Blue.", wasFreeform: true });
    expect(sentPrompt).toBe("What is your favorite color?");
    expect(sentTimeout).toBe(60_000);
    const systemMessage = sessionConfig?.systemMessage as { content: string };
    expect(systemMessage.content).toContain("[system] Build a psychological profile.");
    expect(systemMessage.content).toContain("[tool result: rlm] Favorite book: Dune.");
    expect(systemMessage.content).toContain("Ask for a favorite color.");
    expect(systemMessage.content).toContain("<root_conversation>");
    expect(systemMessage.content).toContain("do not invent it");
    expect(sessionConfig).toMatchObject({
      enableConfigDiscovery: false,
      enableSkills: false,
      availableTools: [],
    });
  });

  it("preserves constrained native ask_user choices", async () => {
    let systemPrompt = "";
    const client: RlmClient = {
      async start() {},
      async createSession(config) {
        systemPrompt = (config.systemMessage as { content: string }).content;
        return {
          async sendAndWait() {
            return { data: { content: "Approve" } };
          },
          async disconnect() {},
        };
      },
      async stop() {},
    };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const handler = createSubmindUserInputHandler({
      label: "test",
      delegatedPrompt: "Review the change.",
      getConversationContext: async () => "[user] Prefer the safe option.",
      model: "test-model",
      clientFactory: () => client,
    });

    const result = await handler(
      {
        question: "Approve or reject?",
        choices: ["Approve", "Reject"],
        allowFreeform: false,
      },
      { sessionId: "child-session" },
    );
    write.mockRestore();

    expect(result).toEqual({ answer: "Approve", wasFreeform: false });
    expect(systemPrompt).toContain('The allowed choices are: ["Approve","Reject"]');
    expect(systemPrompt).toContain("Return exactly one allowed choice");
  });
});
