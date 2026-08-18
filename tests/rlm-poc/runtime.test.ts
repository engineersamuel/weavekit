import { describe, expect, it, vi } from "vitest";
import type { SessionEvent, Tool, ToolResultObject } from "@github/copilot-sdk";
import type { RlmToolArgs } from "../../src/rlm-poc/contracts.js";
import {
  RLM_VALIDATION_SCENARIO_PROMPT,
  RLM_VALIDATION_SYSTEM_PROMPT,
  runRlmPrototype,
  runRlmSubmind,
} from "../../src/rlm-poc/runtime.js";
import type { RlmClient } from "../../src/rlm-poc/session.js";
import {
  beginRlmCall,
  createRlmRunState,
  snapshotRlmRunState,
  succeedRlmCall,
} from "../../src/rlm-poc/runState.js";
import { RLM_SUBMIND_SYSTEM_PROMPT } from "../../src/rlm-poc/submindPrompt.js";
import { RlmWorkerOutcome, type RlmWorkerReport } from "../../src/generated/baml_client/types.js";
import type {
  RlmWorkerContract,
  RlmWorkerContractInput,
} from "../../src/rlm-poc/workerContract.js";

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

function workerReport(summary: string): RlmWorkerReport {
  return {
    outcome: RlmWorkerOutcome.COMPLETED,
    summary,
    evidence: [],
    artifacts: [],
    verification: [],
    decisions: [],
    risks: [],
    openQuestions: [],
    remainingWork: [],
  };
}

const summaryWorkerContract: RlmWorkerContract = {
  async renderPrompt({ delegatedTask }) {
    return delegatedTask;
  },
  parseResponse(raw) {
    return workerReport(raw);
  },
};

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
    expect(sessionConfig.model).toBe("gpt-5.6-sol");
    expect(sessionConfig.reasoningEffort).toBe("medium");
    expect(sessionConfig.availableTools).toEqual(["custom:rlm"]);
    expect(sessionConfig.enableConfigDiscovery).toBe(true);
    expect(sessionConfig.enableSkills).toBe(false);
    expect(sessionConfig.memory).toEqual({ enabled: false });
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

  it("keeps validation worker prompts and responses raw when a worker adapter is supplied", async () => {
    const renderPrompt = vi.fn(summaryWorkerContract.renderPrompt);
    const parseResponse = vi.fn(summaryWorkerContract.parseResponse);
    let factoryCall = 0;
    const clientFactory = (): RlmClient => {
      factoryCall += 1;
      if (factoryCall === 1) {
        return {
          async start() {},
          async createSession(config) {
            return {
              async sendAndWait() {
                const [tool] = config.tools as Tool<RlmToolArgs>[];
                if (!tool?.handler) throw new Error("Expected validation RLM tool.");
                const result = (await tool.handler(
                  { prompt: "Return this text unchanged.", profile: "validation" },
                  {
                    sessionId: "validation-root",
                    toolCallId: "validation-call",
                    toolName: "rlm",
                    arguments: {
                      prompt: "Return this text unchanged.",
                      profile: "validation",
                    },
                  },
                )) as ToolResultObject;
                const payload = JSON.parse(result.textResultForLlm) as { text: string };
                return { data: { content: payload.text } };
              },
              async disconnect() {},
            };
          },
          async stop() {},
        };
      }
      return {
        async start() {},
        async createSession() {
          return {
            async sendAndWait({ prompt }) {
              expect(prompt).toBe("Return this text unchanged.");
              return { data: { content: "RAW_VALIDATION_RESULT" } };
            },
            async disconnect() {},
          };
        },
        async stop() {},
      };
    };

    const result = await runRlmPrototype({
      clientFactory,
      consoleStreaming: false,
      prepareProfileSkills: noRootSkills,
      prepareRootSkills: noRootSkills,
      workerContract: { renderPrompt, parseResponse },
    });

    expect(result.finalText).toBe("RAW_VALIDATION_RESULT");
    expect(renderPrompt).not.toHaveBeenCalled();
    expect(parseResponse).not.toHaveBeenCalled();
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
      workerContract: summaryWorkerContract,
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
    expect(sessionConfig?.memory).toEqual({ enabled: false });
    expect(sessionConfig?.skillDirectories).toBeUndefined();
    expect(sessionConfig?.disabledSkills).toBeUndefined();
    expect(sessionConfig?.availableTools).toEqual([
      "custom:rlm",
      "mcp:*",
      "view",
      "glob",
      "grep",
      "bash",
    ]);
    const systemMessage = sessionConfig?.systemMessage as { content: string };
    expect(systemMessage.content).toContain("enforces at most 6 total `rlm` calls");
    expect(systemMessage.content).toContain("`review` (review):");
    if (!answererConfig) {
      throw new Error("Expected root-grounded answerer session config.");
    }
    expect(answererConfig).toMatchObject({
      model: "gemini-3.7-flash",
      enableConfigDiscovery: false,
      enableSkills: false,
      memory: { enabled: false },
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
          async getEvents() {
            return [
              {
                type: "user.message",
                id: "original-user",
                parentId: null,
                timestamp: new Date().toISOString(),
                data: { content: "Original objective." },
              } as SessionEvent,
            ];
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
      workerContract: summaryWorkerContract,
      prepareRootSkills: async () => ({
        skillDirectories: ["/cache/handoff/skills/productivity"],
      }),
    });

    expect(created).toBe(false);
    expect(resumedId).toBe(conversationId);
    expect(result).toMatchObject({
      finalText: "continued: Use the prior turn.",
      conversationId,
      runId: conversationId,
    });
    if (!resumedConfig) {
      throw new Error("Expected resumeSession configuration.");
    }
    expect(resumedConfig.enableConfigDiscovery).toBe(true);
    expect(resumedConfig.enableSkills).toBe(false);
    expect(resumedConfig.disabledSkills).toBeUndefined();
    expect(resumedConfig.availableTools).toEqual([
      "custom:rlm",
      "mcp:*",
      "view",
      "glob",
      "grep",
      "bash",
    ]);
    expect(resumedConfig.tools).toHaveLength(1);
    expect((resumedConfig.systemMessage as { content: string }).content).toContain(
      "Recursive RLM Submind",
    );
  });

  it("hydrates completed calls on resume and makes them available as explicit dependencies", async () => {
    const conversationId = "f13c1665-bc2c-4d97-9c37-8f31d5c87d17";
    const originalBrief = {
      objective: "Establish the prerequisite.",
      constraints: ["Keep evidence explicit."],
      acceptanceCriteria: ["A later call can select the report."],
      validationCommands: [],
    };
    const priorReport = workerReport("Prior verified evidence.");
    const priorState = createRlmRunState(originalBrief, { runId: conversationId });
    const priorCall = beginRlmCall(priorState, {
      profile: "general",
      depthUsed: 1,
    });
    succeedRlmCall(priorState, priorCall.callId, {
      model: "test-model",
      report: priorReport,
    });
    const checkpoint = snapshotRlmRunState(priorState);
    const renderedInputs: RlmWorkerContractInput[] = [];
    const workerContract: RlmWorkerContract = {
      async renderPrompt(input) {
        renderedInputs.push(structuredClone(input));
        return input.delegatedTask;
      },
      parseResponse(raw) {
        return raw === JSON.stringify(priorReport) ? priorReport : workerReport(raw);
      },
    };
    let factoryCall = 0;
    let currentPayload: Record<string, unknown> | undefined;
    let workerConfig: Record<string, unknown> | undefined;
    const clientFactory = (): RlmClient => {
      factoryCall += 1;
      if (factoryCall === 1) {
        return {
          async start() {},
          rpc: {
            skills: {
              async discover() {
                return { skills: [] };
              },
            },
          },
          async createSession() {
            throw new Error("Fresh root session must not be created during resume.");
          },
          async resumeSession(sessionId, config) {
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
              async getEvents() {
                return [
                  {
                    type: "tool.execution_complete",
                    id: "prior-tool-result",
                    parentId: null,
                    timestamp: new Date().toISOString(),
                    data: {
                      toolCallId: "prior-sdk-tool-call",
                      success: true,
                      result: { content: JSON.stringify({ state: checkpoint }) },
                    },
                  } as SessionEvent,
                ];
              },
              async sendAndWait() {
                const [tool] = config.tools as Tool<RlmToolArgs>[];
                if (!tool) throw new Error("Expected resumed RLM tool.");
                const result = await tool.handler?.(
                  {
                    prompt: "Use the prior verified evidence.",
                    profile: "general",
                    dependsOn: [priorCall.callId],
                  },
                  {
                    sessionId,
                    toolCallId: "current-sdk-tool-call",
                    toolName: "rlm",
                    arguments: {
                      prompt: "Use the prior verified evidence.",
                      profile: "general",
                      dependsOn: [priorCall.callId],
                    },
                  },
                );
                const payload = JSON.parse((result as ToolResultObject).textResultForLlm) as Record<
                  string,
                  unknown
                >;
                currentPayload = payload;
                return { data: { content: payload.text as string } };
              },
              async disconnect() {},
            };
          },
          async stop() {},
        };
      }
      return {
        async start() {},
        async createSession(config) {
          workerConfig = config;
          return {
            async sendAndWait() {
              return { data: { content: "Current completed work." } };
            },
            async disconnect() {},
          };
        },
        async stop() {},
      };
    };

    const result = await runRlmSubmind("Continue from the prerequisite.", {
      conversationId,
      clientFactory,
      consoleStreaming: false,
      prepareProfileSkills: noRootSkills,
      prepareRootSkills: noRootSkills,
      workerContract,
    });

    expect(result).toMatchObject({
      finalText: "Current completed work.",
      conversationId,
      runId: conversationId,
    });
    expect(renderedInputs).toEqual([
      {
        brief: originalBrief,
        delegatedTask: "Use the prior verified evidence.",
        dependencies: [
          {
            callId: priorCall.callId,
            profile: "general",
            report: priorReport,
          },
        ],
      },
    ]);
    expect(currentPayload).toMatchObject({
      callId: `${conversationId}:call-2`,
      dependencyCallIds: [priorCall.callId],
      state: {
        runId: conversationId,
        revision: 4,
        nextCallNumber: 3,
      },
    });
    expect(workerConfig?.memory).toEqual({ enabled: false });
  });

  it("fails closed before a resumed prompt when a versioned state checkpoint is malformed", async () => {
    let promptSent = false;
    const conversationId = "f13c1665-bc2c-4d97-9c37-8f31d5c87d17";
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
        throw new Error("Fresh root session must not be created during resume.");
      },
      async resumeSession(sessionId) {
        return {
          sessionId,
          async getEvents() {
            return [
              {
                type: "tool.execution_complete",
                id: "malformed-tool-result",
                parentId: null,
                timestamp: new Date().toISOString(),
                data: {
                  toolCallId: "malformed-tool-call",
                  success: true,
                  result: { content: JSON.stringify({ state: { schemaVersion: 1 } }) },
                },
              } as SessionEvent,
            ];
          },
          async sendAndWait() {
            promptSent = true;
            return { data: { content: "must not run" } };
          },
          async disconnect() {},
        };
      },
      async stop() {},
    };

    await expect(
      runRlmSubmind("Do not send.", {
        conversationId,
        clientFactory: () => client,
        consoleStreaming: false,
        prepareRootSkills: noRootSkills,
        workerContract: summaryWorkerContract,
      }),
    ).rejects.toThrow("Invalid RLM run-state checkpoint");
    expect(promptSent).toBe(false);
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
        async getEvents() {
          return [
            {
              type: "user.message",
              id: "original-user",
              parentId: null,
              timestamp: new Date().toISOString(),
              data: { content: "Original objective." },
            } as SessionEvent,
          ];
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
          workerContract: summaryWorkerContract,
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
        async getEvents() {
          return [
            {
              type: "user.message",
              id: "original-user",
              parentId: null,
              timestamp: new Date().toISOString(),
              data: { content: "Original objective." },
            } as SessionEvent,
          ];
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
          workerContract: summaryWorkerContract,
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
        workerContract: summaryWorkerContract,
        prepareRootSkills: noRootSkills,
      }),
    ).rejects.toThrow("Session not found");
    expect(created).toBe(false);
  });
});

describe("RLM runtime run brief", () => {
  function briefCapturingClientFactory(): () => RlmClient {
    let factoryCall = 0;
    return (): RlmClient => {
      factoryCall += 1;
      if (factoryCall > 1) {
        return {
          async start() {},
          async createSession() {
            return {
              async sendAndWait() {
                return { data: { content: "Worker done." } };
              },
              async disconnect() {},
            };
          },
          async stop() {},
        };
      }
      return {
        async start() {},
        rpc: {
          skills: {
            async discover() {
              return { skills: [] };
            },
          },
        },
        async createSession(config) {
          return {
            sessionId: "f13c1665-bc2c-4d97-9c37-8f31d5c87d17",
            rpc: {
              skills: {
                async ensureLoaded() {},
                async list() {
                  return { skills: [] };
                },
              },
            },
            async sendAndWait() {
              const [tool] = config.tools as Tool<RlmToolArgs>[];
              const args = { prompt: "Do the bounded work.", profile: "general" };
              const result = (await tool!.handler!(args, {
                sessionId: "root",
                toolCallId: "call-1",
                toolName: "rlm",
                arguments: args,
              })) as ToolResultObject;
              const payload = JSON.parse(result.textResultForLlm) as { text: string };
              return { data: { content: payload.text } };
            },
            async disconnect() {},
          };
        },
        async stop() {},
      };
    };
  }

  function capturingContract(
    renderedInputs: RlmWorkerContractInput[],
    deriveBrief?: RlmWorkerContract["deriveBrief"],
  ): RlmWorkerContract {
    return {
      async renderPrompt(input) {
        renderedInputs.push(structuredClone(input));
        return input.delegatedTask;
      },
      parseResponse(raw) {
        return workerReport(raw);
      },
      ...(deriveBrief ? { deriveBrief } : {}),
    };
  }

  it("passes the derived acceptance contract to every delegated worker", async () => {
    const renderedInputs: RlmWorkerContractInput[] = [];

    await runRlmSubmind("Ship the feature.", {
      clientFactory: briefCapturingClientFactory(),
      consoleStreaming: false,
      prepareProfileSkills: noRootSkills,
      prepareRootSkills: noRootSkills,
      workerContract: capturingContract(renderedInputs, async () => ({
        objective: "Ship the feature end to end.",
        constraints: ["Do not change the public API."],
        acceptanceCriteria: ["The feature is covered by a test."],
        validationCommands: ["nub run test"],
      })),
    });

    expect(renderedInputs[0]?.brief).toEqual({
      objective: "Ship the feature end to end.",
      constraints: ["Do not change the public API."],
      acceptanceCriteria: ["The feature is covered by a test."],
      validationCommands: ["nub run test"],
    });
  });

  it("lets an operator override replace only the field it binds", async () => {
    const renderedInputs: RlmWorkerContractInput[] = [];

    await runRlmSubmind("Ship the feature.", {
      clientFactory: briefCapturingClientFactory(),
      consoleStreaming: false,
      prepareProfileSkills: noRootSkills,
      prepareRootSkills: noRootSkills,
      runBrief: { validationCommands: ["nub run typecheck"] },
      workerContract: capturingContract(renderedInputs, async () => ({
        objective: "Ship the feature end to end.",
        constraints: [],
        acceptanceCriteria: ["The feature is covered by a test."],
        validationCommands: ["nub run test"],
      })),
    });

    expect(renderedInputs[0]?.brief.validationCommands).toEqual(["nub run typecheck"]);
    expect(renderedInputs[0]?.brief.acceptanceCriteria).toEqual([
      "The feature is covered by a test.",
    ]);
  });

  it("starts the run with an objective-only brief when derivation fails", async () => {
    const renderedInputs: RlmWorkerContractInput[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      await runRlmSubmind("Ship the feature.", {
        clientFactory: briefCapturingClientFactory(),
        consoleStreaming: false,
        prepareProfileSkills: noRootSkills,
        prepareRootSkills: noRootSkills,
        workerContract: capturingContract(renderedInputs, async () => {
          throw new Error("proxy unavailable");
        }),
      });
    } finally {
      stderr.mockRestore();
    }

    expect(renderedInputs[0]?.brief).toEqual({
      objective: "Ship the feature.",
      constraints: [],
      acceptanceCriteria: [],
      validationCommands: [],
    });
  });
});

describe("RLM runtime workingDirectory", () => {
  it("forwards workingDirectory to the default CopilotClient constructor", async () => {
    capturedClientOptions.length = 0;
    await runRlmSubmind("Implement the ticket.", {
      workingDirectory: "/tmp/mastermind-worktree",
      consoleStreaming: false,
      prepareRootSkills: noRootSkills,
      workerContract: summaryWorkerContract,
    });
    expect(capturedClientOptions).toHaveLength(1);
    expect(capturedClientOptions[0]?.workingDirectory).toBe("/tmp/mastermind-worktree");
  });

  it("omits workingDirectory from the default CopilotClient constructor when unset", async () => {
    capturedClientOptions.length = 0;
    await runRlmSubmind("Implement the ticket.", {
      consoleStreaming: false,
      prepareRootSkills: noRootSkills,
      workerContract: summaryWorkerContract,
    });
    expect(capturedClientOptions).toHaveLength(1);
    expect(capturedClientOptions[0]).not.toHaveProperty("workingDirectory");
  });
});
