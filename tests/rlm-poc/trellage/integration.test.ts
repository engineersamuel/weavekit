import { describe, expect, it, vi } from "vitest";
import type { RlmClient } from "../../../src/rlm-poc/session.js";
import { createTrellageAnswerer } from "../../../src/rlm-poc/trellage/integration.js";

describe("createTrellageAnswerer", () => {
  it("uses an isolated memory-disabled SDK session", async () => {
    let sessionConfig: Record<string, unknown> | undefined;
    let disconnected = false;
    let stopped = false;
    const client: RlmClient = {
      async start() {},
      async createSession(config) {
        sessionConfig = config;
        return {
          async sendAndWait() {
            return { data: { content: "Proceed." } };
          },
          async disconnect() {
            disconnected = true;
          },
        };
      },
      async stop() {
        stopped = true;
      },
    };
    const answerer = createTrellageAnswerer({
      model: "test-model",
      clientFactory: () => client,
      getConversationContext: async () => "The root approved routine work.",
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await expect(answerer("Can I proceed?")).resolves.toBe("Proceed.");
    } finally {
      write.mockRestore();
    }

    expect(sessionConfig).toMatchObject({
      model: "test-model",
      enableConfigDiscovery: false,
      enableSkills: false,
      memory: { enabled: false },
      availableTools: [],
      excludedTools: ["task_complete", "ask_user"],
    });
    expect(disconnected).toBe(true);
    expect(stopped).toBe(true);
  });

  it("answers a repeated report-permission question without reopening a submind session", async () => {
    let createSessionCalls = 0;
    const client: RlmClient = {
      async start() {},
      async createSession() {
        createSessionCalls += 1;
        return {
          async sendAndWait() {
            return { data: { content: "Yes, you may report it." } };
          },
          async disconnect() {},
        };
      },
      async stop() {},
    };
    const answerer = createTrellageAnswerer({
      model: "test-model",
      clientFactory: () => client,
      getConversationContext: async () => "The delegated harness must write result.md when done.",
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await expect(answerer("May I report this result?")).resolves.toBe("Yes, you may report it.");
      await expect(answerer("May I now report the result by writing the file?")).resolves.toBe(
        "Yes. Report the result now. Write the final answer to the requested result.md file, then reply in the terminal with that file path only. Do not ask again.",
      );
    } finally {
      write.mockRestore();
    }

    expect(createSessionCalls).toBe(1);
  });

  it("recovers the last non-empty assistant message when the terminal message is empty", async () => {
    const client: RlmClient = {
      async start() {},
      async createSession() {
        return {
          async sendAndWait() {
            return { data: { content: "" } };
          },
          async getEvents() {
            return [
              {
                type: "assistant.message",
                data: { content: "teal" },
              },
              {
                type: "assistant.message",
                data: { content: "" },
              },
            ] as never;
          },
          async disconnect() {},
        };
      },
      async stop() {},
    };
    const answerer = createTrellageAnswerer({
      model: "test-model",
      clientFactory: () => client,
      getConversationContext: async () => "The deployment color is teal.",
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await expect(answerer("What is the deployment color?")).resolves.toBe("teal");
    } finally {
      write.mockRestore();
    }
  });
});
