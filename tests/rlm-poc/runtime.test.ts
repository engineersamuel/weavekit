import { describe, expect, it, vi } from "vitest";
import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import type { RlmToolArgs } from "../../src/rlm-poc/contracts.js";
import {
  RLM_VALIDATION_SCENARIO_PROMPT,
  RLM_VALIDATION_SYSTEM_PROMPT,
  runRlmPrototype,
  runRlmSubmind,
} from "../../src/rlm-poc/runtime.js";
import type { RlmClient } from "../../src/rlm-poc/session.js";
import { RLM_SUBMIND_SYSTEM_PROMPT } from "../../src/rlm-poc/submindPrompt.js";

const capturedClientOptions: Record<string, unknown>[] = [];

vi.mock("@github/copilot-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@github/copilot-sdk")>();
  class MockCopilotClient {
    constructor(options: Record<string, unknown> = {}) {
      capturedClientOptions.push(options);
    }
    async start() {}
    async createSession() {
      return {
        sessionId: "f13c1665-bc2c-4d97-9c37-8f31d5c87d17",
        async sendAndWait() {
          return { data: { content: "done" } };
        },
        async disconnect() {},
      };
    }
    async stop() {}
  }
  return { ...actual, CopilotClient: MockCopilotClient };
});

const noRootSkills = async () => undefined;

describe("RLM runtime prompts", () => {
  it("keeps the prototype validation prompt narrow and profile-specific", () => {
    expect(RLM_VALIDATION_SCENARIO_PROMPT).toContain('profile "validation"');
    expect(RLM_VALIDATION_SCENARIO_PROMPT).toContain("three separate parallel `rlm` calls");
    expect(RLM_VALIDATION_SCENARIO_PROMPT).toContain("native `ask_user`");
    expect(RLM_VALIDATION_SYSTEM_PROMPT).not.toContain("Independent Review");
  });

  it("keeps general orchestration policy separate from validation", () => {
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("Independent Review");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`general` (execution):");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`superpowers` (execution):");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`council` (deliberation):");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`research` (research):");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`media` (media):");
    expect(RLM_SUBMIND_SYSTEM_PROMPT).toContain("`review` (review):");
  });

  it("configures the live validation root with only rlm and the validation profile", async () => {
    let sessionConfig: Record<string, unknown> | undefined;
    let rootTimeout: number | undefined;
    const client: RlmClient = {
      async start() {},
      async createSession(config) {
        sessionConfig = config;
        return {
          async sendAndWait(_options, timeout) {
            rootTimeout = timeout;
            return { data: { content: "validated" } };
          },
          async disconnect() {},
        };
      },
      async stop() {},
    };

    await runRlmPrototype({
      clientFactory: () => client,
      consoleStreaming: false,
      prepareRootSkills: noRootSkills,
    });

    if (!sessionConfig) {
      throw new Error("Expected validation session config.");
    }
    expect(sessionConfig.model).toBe("mai-code-1.1-flash");
    expect(sessionConfig.reasoningEffort).toBe("medium");
    expect(sessionConfig.availableTools).toEqual(["custom:rlm"]);
    expect(sessionConfig.enableConfigDiscovery).toBe(true);
    expect(sessionConfig.enableSkills).toBe(false);
    expect(rootTimeout).toBe(35 * 60_000);
    expect(sessionConfig.systemMessage).toEqual({
      mode: "append",
      content: RLM_VALIDATION_SYSTEM_PROMPT,
    });
    const [tool] = sessionConfig.tools as Tool<RlmToolArgs>[];
    if (!tool) {
      throw new Error("Expected validation rlm tool.");
    }
    expect(
      (tool.parameters as { properties: { profile: { enum: string[] } } }).properties.profile.enum,
    ).toEqual(["validation"]);
  });

  it("runs the general Submind with generated orchestration instructions", async () => {
    let sessionConfig: Record<string, unknown> | undefined;
    let answererConfig: Record<string, unknown> | undefined;
    let sentPrompt: string | undefined;
    let rootTimeout: number | undefined;
    let factoryCalls = 0;
    const clientFactory = (): RlmClient => {
      factoryCalls += 1;
      const call = factoryCalls;
      return {
        async start() {},
        rpc: {
          skills: {
            async discover() {
              return call === 1
                ? {
                    skills: [
                      {
                        name: "handoff",
                        source: "custom",
                        enabled: true,
                        path: "/cache/handoff/skills/productivity/handoff/SKILL.md",
                      },
                      {
                        name: "host-specialist",
                        source: "builtin",
                        enabled: true,
                      },
                    ],
                  }
                : { skills: [] };
            },
          },
        },
        async createSession(config) {
          if (call === 1) {
            sessionConfig = config;
            return {
              sessionId: "f13c1665-bc2c-4d97-9c37-8f31d5c87d17",
              rpc: {
                skills: {
                  async ensureLoaded() {},
                  async list() {
                    return {
                      skills: [],
                    };
                  },
                },
              },
              async sendAndWait(options, timeout) {
                sentPrompt = options.prompt;
                rootTimeout = timeout;
                const [tool] = config.tools as Tool<RlmToolArgs>[];
                if (!tool?.handler) {
                  throw new Error("Expected root rlm handler.");
                }
                const result = (await tool.handler(
                  { prompt: "Return CHILD_OK.", profile: "general" },
                  {
                    sessionId: "root",
                    toolCallId: "call-1",
                    toolName: "rlm",
                    arguments: { prompt: "Return CHILD_OK.", profile: "general" },
                  },
                )) as ToolResultObject;
                const payload = JSON.parse(result.textResultForLlm) as { text: string };
                return { data: { content: payload.text } };
              },
              async getEvents() {
                return [
                  {
                    type: "user.message",
                    id: "root-user",
                    parentId: null,
                    timestamp: new Date().toISOString(),
                    data: { content: "The root answer is ROOT_CONTEXT_OK." },
                  },
                ];
              },
              async disconnect() {},
            };
          }
          if (call === 2) {
            return {
              async sendAndWait() {
                const handler = config.onUserInputRequest as (
                  request: { question: string },
                  invocation: { sessionId: string },
                ) => Promise<{ answer: string }>;
                const response = await handler(
                  { question: "What answer did the root provide?" },
                  { sessionId: "child" },
                );
                return { data: { content: response.answer } };
              },
              async disconnect() {},
            };
          }
          answererConfig = config;
          return {
            async sendAndWait() {
              return { data: { content: "ROOT_CONTEXT_OK" } };
            },
            async disconnect() {},
          };
        },
        async stop() {},
      };
    };

    const result = await runRlmSubmind("Implement the bounded task.", {
      clientFactory,
      consoleStreaming: false,
      maxTotalCalls: 6,
      prepareProfileSkills: noRootSkills,
      prepareRootSkills: async () => ({
        skillDirectories: ["/cache/handoff/skills/productivity"],
      }),
    });

    expect(result.finalText).toBe("ROOT_CONTEXT_OK");
    expect(result.conversationId).toBe("f13c1665-bc2c-4d97-9c37-8f31d5c87d17");
    expect(sentPrompt).toBe("Implement the bounded task.");
    expect(factoryCalls).toBe(3);
    expect(rootTimeout).toBe(200 * 60_000);
    expect(sessionConfig?.enableConfigDiscovery).toBe(true);
    expect(sessionConfig?.enableSkills).toBe(false);
    expect(sessionConfig?.skillDirectories).toBeUndefined();
    expect(sessionConfig?.disabledSkills).toBeUndefined();
    expect(sessionConfig?.availableTools).toEqual(["custom:rlm", "mcp:*"]);
    const systemMessage = sessionConfig?.systemMessage as { content: string };
    expect(systemMessage.content).toContain("enforces at most 6 total `rlm` calls");
    expect(systemMessage.content).toContain("`review` (review):");
    if (!answererConfig) {
      throw new Error("Expected root-grounded answerer session config.");
    }
    expect(answererConfig).toMatchObject({
      model: "gemini-3.6-flash",
      enableConfigDiscovery: false,
      enableSkills: false,
      availableTools: [],
    });
    expect((answererConfig.systemMessage as { content: string }).content).toContain(
      "The root answer is ROOT_CONTEXT_OK.",
    );
  });

  it("resumes the requested SDK conversation with current RLM tools and instructions", async () => {
    const conversationId = "f13c1665-bc2c-4d97-9c37-8f31d5c87d17";
    let resumedId: string | undefined;
    let resumedConfig: Record<string, unknown> | undefined;
    let created = false;
    const client: RlmClient = {
      async start() {},
      rpc: {
        skills: {
          async discover() {
            return {
              skills: [
                {
                  name: "handoff",
                  source: "custom",
                  enabled: true,
                  path: "/cache/handoff/skills/productivity/handoff/SKILL.md",
                },
                {
                  name: "workspace-implementation",
                  source: "project",
                  enabled: true,
                  path: "/repo/.github/skills/workspace-implementation/SKILL.md",
                },
              ],
            };
          },
        },
      },
      async createSession() {
        created = true;
        throw new Error("createSession must not run for a resumed conversation");
      },
      async resumeSession(sessionId, config) {
        resumedId = sessionId;
        resumedConfig = config;
        return {
          sessionId,
          rpc: {
            skills: {
              async ensureLoaded() {},
              async list() {
                return { skills: [] };
              },
            },
          },
          async sendAndWait({ prompt }) {
            return { data: { content: `continued: ${prompt}` } };
          },
          async disconnect() {},
        };
      },
      async stop() {},
    };

    const result = await runRlmSubmind("Use the prior turn.", {
      conversationId,
      clientFactory: () => client,
      consoleStreaming: false,
      prepareRootSkills: async () => ({
        skillDirectories: ["/cache/handoff/skills/productivity"],
      }),
    });

    expect(created).toBe(false);
    expect(resumedId).toBe(conversationId);
    expect(result).toMatchObject({
      finalText: "continued: Use the prior turn.",
      conversationId,
    });
    if (!resumedConfig) {
      throw new Error("Expected resumeSession configuration.");
    }
    expect(resumedConfig.enableConfigDiscovery).toBe(true);
    expect(resumedConfig.enableSkills).toBe(false);
    expect(resumedConfig.disabledSkills).toBeUndefined();
    expect(resumedConfig.availableTools).toEqual(["custom:rlm", "mcp:*"]);
    expect(resumedConfig.tools).toHaveLength(1);
    expect((resumedConfig.systemMessage as { content: string }).content).toContain(
      "Recursive RLM Submind",
    );
  });

  it.each(["fresh", "resumed"] as const)(
    "fails closed before sending a %s root prompt when the loaded skill policy is invalid",
    async (mode) => {
      let promptSent = false;
      const conversationId = "f13c1665-bc2c-4d97-9c37-8f31d5c87d17";
      const invalidSession = {
        sessionId: conversationId,
        rpc: {
          skills: {
            async ensureLoaded() {},
            async list() {
              return {
                skills: [
                  {
                    name: "rogue",
                    source: "project",
                    enabled: true,
                    path: "/repo/.github/skills/rogue/SKILL.md",
                  },
                ],
              };
            },
          },
        },
        async sendAndWait() {
          promptSent = true;
          return { data: { content: "must not run" } };
        },
        async disconnect() {},
      };
      const client: RlmClient = {
        async start() {},
        rpc: {
          skills: {
            async discover() {
              return {
                skills: [
                  {
                    name: "handoff",
                    source: "custom",
                    enabled: true,
                    path: "/cache/handoff/handoff/SKILL.md",
                  },
                ],
              };
            },
          },
        },
        async createSession() {
          return invalidSession;
        },
        async resumeSession() {
          return invalidSession;
        },
        async stop() {},
      };

      await expect(
        runRlmSubmind("Do not send.", {
          ...(mode === "resumed" ? { conversationId } : {}),
          clientFactory: () => client,
          consoleStreaming: false,
          prepareRootSkills: async () => ({
            skillDirectories: ["/cache/handoff"],
          }),
        }),
      ).rejects.toThrow("Enabled skills outside the profile manifest/path");
      expect(promptSent).toBe(false);
    },
  );

  it.each(["fresh", "resume"] as const)(
    "fails closed before the root prompt when a %s session enables an out-of-manifest skill",
    async (mode) => {
      let promptSent = false;
      let disconnected = false;
      const conversationId = "f13c1665-bc2c-4d97-9c37-8f31d5c87d17";
      const createRestrictedSession = () => ({
        sessionId: conversationId,
        rpc: {
          skills: {
            async ensureLoaded() {},
            async list() {
              return {
                skills: [
                  {
                    name: "rogue",
                    source: "plugin",
                    enabled: true,
                    path: "/plugins/rogue/SKILL.md",
                  },
                ],
              };
            },
          },
        },
        async sendAndWait() {
          promptSent = true;
          return { data: { content: "must not run" } };
        },
        async disconnect() {
          disconnected = true;
        },
      });
      const client: RlmClient = {
        async start() {},
        rpc: {
          skills: {
            async discover() {
              return { skills: [] };
            },
          },
        },
        async createSession() {
          return createRestrictedSession();
        },
        async resumeSession() {
          return createRestrictedSession();
        },
        async stop() {},
      };

      await expect(
        runRlmSubmind("Route this.", {
          ...(mode === "resume" ? { conversationId } : {}),
          clientFactory: () => client,
          consoleStreaming: false,
          prepareRootSkills: async () => ({
            skillDirectories: ["/cache/handoff/skills/productivity"],
          }),
        }),
      ).rejects.toThrow("Enabled skills outside the profile manifest/path");
      expect(promptSent).toBe(false);
      expect(disconnected).toBe(true);
    },
  );

  it("does not replace a missing resumed conversation with a fresh session", async () => {
    let created = false;
    const client: RlmClient = {
      async start() {},
      async createSession() {
        created = true;
        throw new Error("unexpected create");
      },
      async resumeSession() {
        throw new Error("Session not found");
      },
      async stop() {},
    };

    await expect(
      runRlmSubmind("Continue.", {
        conversationId: "f13c1665-bc2c-4d97-9c37-8f31d5c87d17",
        clientFactory: () => client,
        consoleStreaming: false,
        prepareRootSkills: noRootSkills,
      }),
    ).rejects.toThrow("Session not found");
    expect(created).toBe(false);
  });
});

describe("RLM runtime workingDirectory", () => {
  it("forwards workingDirectory to the default CopilotClient constructor", async () => {
    capturedClientOptions.length = 0;
    await runRlmSubmind("Implement the ticket.", {
      workingDirectory: "/tmp/mastermind-worktree",
      consoleStreaming: false,
      prepareRootSkills: noRootSkills,
    });
    expect(capturedClientOptions).toHaveLength(1);
    expect(capturedClientOptions[0]?.workingDirectory).toBe("/tmp/mastermind-worktree");
  });

  it("omits workingDirectory from the default CopilotClient constructor when unset", async () => {
    capturedClientOptions.length = 0;
    await runRlmSubmind("Implement the ticket.", {
      consoleStreaming: false,
      prepareRootSkills: noRootSkills,
    });
    expect(capturedClientOptions).toHaveLength(1);
    expect(capturedClientOptions[0]).not.toHaveProperty("workingDirectory");
  });
});
