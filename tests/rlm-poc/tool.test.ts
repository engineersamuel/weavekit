import { describe, expect, it, vi } from "vitest";
import type { SessionEvent, Tool, ToolResultObject } from "@github/copilot-sdk";
import { createRlmExecutionBudget, snapshotRlmExecutionBudget } from "../../src/rlm-poc/budget.js";
import {
  RlmCallExecutionStatus,
  createRlmRunState,
  snapshotRlmRunState,
} from "../../src/rlm-poc/runState.js";
import {
  RlmProfileName,
  createRlmProfileRegistry,
  defaultRlmProfileRegistry,
} from "../../src/rlm-poc/profiles.js";
import {
  createRlmTool as createProductionRlmTool,
  type CreateRlmToolOptions,
} from "../../src/rlm-poc/tool.js";
import type { RlmClient, RlmSession } from "../../src/rlm-poc/session.js";
import {
  RlmProfileAuthority,
  RlmProfilePurpose,
  type RlmToolArgs,
} from "../../src/rlm-poc/contracts.js";
import { RlmModelGroup, parseCopilotModelCatalog } from "../../src/rlm-poc/modelCatalog.js";
import {
  RlmWorkerOutcome,
  type RlmRunBrief,
  type RlmWorkerReport,
} from "../../src/generated/baml_client/types.js";
import type {
  RlmWorkerContract,
  RlmWorkerContractInput,
} from "../../src/rlm-poc/workerContract.js";

const profiles = createRlmProfileRegistry({
  default: {
    name: "default",
    description: "Test profile.",
    purpose: RlmProfilePurpose.Submind,
    authority: RlmProfileAuthority.Implementation,
    repositoryWritePermission: true,
    model: "test-model",
    systemMessagePrompt: "Answer directly.",
  },
});

const runBrief: RlmRunBrief = {
  objective: "Complete the root objective.",
  constraints: ["Use only selected dependency reports."],
  acceptanceCriteria: ["Return a typed report."],
  validationCommands: ["nub run test -- tests/rlm-poc/tool.test.ts"],
};

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

function createWorkerContract(renderedInputs: RlmWorkerContractInput[] = []): RlmWorkerContract {
  return {
    async renderPrompt(input) {
      renderedInputs.push(structuredClone(input));
      return input.delegatedTask;
    },
    parseResponse(raw) {
      return workerReport(raw);
    },
  };
}

function createRlmTool(options: CreateRlmToolOptions) {
  return createProductionRlmTool({
    ...options,
    prepareProfileSkills: options.prepareProfileSkills ?? (async () => undefined),
  });
}

function fakeClientFactory(content: string): () => RlmClient {
  return () => ({
    async start() {},
    async createSession(): Promise<RlmSession> {
      return {
        async sendAndWait() {
          return { data: { content } };
        },
        async disconnect() {},
      };
    },
    async stop() {},
  });
}

async function invoke(tool: Tool<RlmToolArgs>, args: RlmToolArgs): Promise<ToolResultObject> {
  if (!tool.handler) {
    throw new Error("Expected the rlm tool to have a handler.");
  }
  return (await tool.handler(args, {
    sessionId: "test-session",
    toolCallId: "call-1",
    toolName: "rlm",
    arguments: args,
  })) as ToolResultObject;
}

describe("createRlmTool", () => {
  it("is named rlm and exposes bounded profile/model choices to the LLM", () => {
    const tool = createRlmTool({ depthRemaining: 3, maxDepth: 3, profiles });
    expect(tool.name).toBe("rlm");
    expect(tool.parameters).toBeDefined();
    expect(
      (tool.parameters as { properties: { profile: { enum: string[] } } }).properties.profile.enum,
    ).toContain("default");
    expect(
      (
        tool.parameters as {
          properties: { dependsOn: { minItems: number; uniqueItems: boolean } };
        }
      ).properties.dependsOn,
    ).toMatchObject({ minItems: 1, uniqueItems: true });
  });

  it("does not emit an invalid empty profile enum", () => {
    const tool = createRlmTool({
      depthRemaining: 1,
      maxDepth: 1,
      profiles,
      allowedProfiles: [],
    });
    expect(
      (tool.parameters as { properties: { profile: { enum?: string[] } } }).properties.profile.enum,
    ).toBeUndefined();
  });

  it("returns a success ToolResultObject with the nested session's answer", async () => {
    const tool = createRlmTool({
      depthRemaining: 3,
      maxDepth: 3,
      profiles,
      clientFactory: fakeClientFactory("Blue."),
    });

    const result = await invoke(tool, { prompt: "Favorite color?", profile: "default" });
    expect(result).toMatchObject({ resultType: "success" });
    const payload = JSON.parse((result as { textResultForLlm: string }).textResultForLlm);
    expect(payload).toEqual({
      text: "Blue.",
      depthUsed: 1,
      model: "test-model",
      modelRationale: "Profile uses fixed model test-model.",
      budget: { maxCalls: 12, usedCalls: 1, remainingCalls: 11 },
    });
  });

  it("injects only the explicitly selected completed dependency reports", async () => {
    const runState = createRlmRunState(runBrief, { runId: "run-one" });
    const renderedInputs: RlmWorkerContractInput[] = [];
    const responses = ["first report", "unrelated report", "dependent report"];
    const tool = createRlmTool({
      depthRemaining: 3,
      maxDepth: 3,
      profiles,
      runState,
      workerContract: createWorkerContract(renderedInputs),
      clientFactory: () => ({
        async start() {},
        async createSession() {
          return {
            async sendAndWait() {
              return { data: { content: responses.shift() ?? "unexpected" } };
            },
            async disconnect() {},
          };
        },
        async stop() {},
      }),
    });

    const first = JSON.parse(
      (await invoke(tool, { prompt: "Produce prerequisite evidence.", profile: "default" }))
        .textResultForLlm,
    );
    await invoke(tool, { prompt: "Produce unrelated evidence.", profile: "default" });
    const dependent = JSON.parse(
      (
        await invoke(tool, {
          prompt: "Use the prerequisite evidence.",
          profile: "default",
          dependsOn: [first.callId],
        })
      ).textResultForLlm,
    );

    expect(renderedInputs).toHaveLength(3);
    expect(renderedInputs[0]?.dependencies).toEqual([]);
    expect(renderedInputs[1]?.dependencies).toEqual([]);
    expect(renderedInputs[2]?.dependencies).toEqual([
      {
        callId: "run-one:call-1",
        profile: "default",
        report: workerReport("first report"),
      },
    ]);
    expect(renderedInputs[2]?.brief).toEqual(runBrief);
    expect(dependent).toMatchObject({
      runId: "run-one",
      callId: "run-one:call-3",
      dependencyCallIds: ["run-one:call-1"],
      text: "dependent report",
      report: workerReport("dependent report"),
    });
    expect(dependent.state.calls).toHaveLength(3);
  });

  it("shares one ledger with nested calls and records explicit parent IDs", async () => {
    const runState = createRlmRunState(runBrief, { runId: "run-nested" });
    const workerContract = createWorkerContract();
    let factoryCall = 0;
    let nestedPayload: Record<string, unknown> | undefined;
    const tool = createRlmTool({
      depthRemaining: 3,
      maxDepth: 3,
      profiles,
      runState,
      workerContract,
      clientFactory: () => {
        factoryCall += 1;
        const currentCall = factoryCall;
        return {
          async start() {},
          async createSession(config) {
            return {
              async sendAndWait() {
                if (currentCall === 1) {
                  const [nestedTool] = config.tools as Tool<RlmToolArgs>[];
                  if (!nestedTool) throw new Error("Expected nested RLM tool.");
                  nestedPayload = JSON.parse(
                    (
                      await invoke(nestedTool, {
                        prompt: "Complete nested work.",
                        profile: "default",
                      })
                    ).textResultForLlm,
                  );
                  return { data: { content: "outer report" } };
                }
                return { data: { content: "nested report" } };
              },
              async disconnect() {},
            };
          },
          async stop() {},
        };
      },
    });

    const result = await invoke(tool, {
      prompt: "Delegate nested work.",
      profile: "default",
    });
    const payload = JSON.parse(result.textResultForLlm);

    expect(nestedPayload).toMatchObject({
      runId: "run-nested",
      callId: "run-nested:call-2",
      parentCallId: "run-nested:call-1",
      text: "nested report",
    });
    expect(nestedPayload).not.toHaveProperty("state");
    expect(payload.state.calls).toMatchObject([
      {
        callId: "run-nested:call-1",
        status: RlmCallExecutionStatus.Succeeded,
      },
      {
        callId: "run-nested:call-2",
        parentCallId: "run-nested:call-1",
        status: RlmCallExecutionStatus.Succeeded,
      },
    ]);
    expect(snapshotRlmRunState(runState).nextCallNumber).toBe(3);
  });

  it("rejects invalid dependencies before starting a client or consuming call budget", async () => {
    const runState = createRlmRunState(runBrief, { runId: "run-invalid" });
    const executionBudget = createRlmExecutionBudget(3);
    const clientFactory = vi.fn(fakeClientFactory("unused"));
    const tool = createRlmTool({
      depthRemaining: 3,
      maxDepth: 3,
      profiles,
      runState,
      workerContract: createWorkerContract(),
      executionBudget,
      clientFactory,
    });

    const result = await invoke(tool, {
      prompt: "Use missing evidence.",
      profile: "default",
      dependsOn: ["run-invalid:call-99"],
    });
    const payload = JSON.parse(result.textResultForLlm);

    expect(result).toMatchObject({
      resultType: "failure",
      error: expect.stringMatching(/does not exist/iu),
    });
    expect(clientFactory).not.toHaveBeenCalled();
    expect(snapshotRlmExecutionBudget(executionBudget)).toEqual({
      maxCalls: 3,
      usedCalls: 0,
      remainingCalls: 3,
    });
    expect(payload.state.calls).toMatchObject([
      {
        callId: "run-invalid:call-1",
        dependencyCallIds: ["run-invalid:call-99"],
        status: RlmCallExecutionStatus.Failed,
        error: expect.stringMatching(/does not exist/iu),
      },
    ]);
  });

  it("records typed report parse failures as failed calls", async () => {
    const runState = createRlmRunState(runBrief, { runId: "run-parse" });
    const executionBudget = createRlmExecutionBudget(3);
    const workerContract: RlmWorkerContract = {
      async renderPrompt({ delegatedTask }) {
        return delegatedTask;
      },
      parseResponse() {
        throw new Error("invalid typed worker report");
      },
    };
    const tool = createRlmTool({
      depthRemaining: 3,
      maxDepth: 3,
      profiles,
      runState,
      workerContract,
      executionBudget,
      clientFactory: fakeClientFactory("not structured"),
    });

    const result = await invoke(tool, {
      prompt: "Return invalid output.",
      profile: "default",
    });
    const payload = JSON.parse(result.textResultForLlm);

    expect(result).toMatchObject({
      resultType: "failure",
      error: "invalid typed worker report",
    });
    expect(payload.state.calls).toMatchObject([
      {
        callId: "run-parse:call-1",
        status: RlmCallExecutionStatus.Failed,
        error: "invalid typed worker report",
      },
    ]);
    expect(snapshotRlmExecutionBudget(executionBudget).usedCalls).toBe(1);
  });

  it("uses only validated dynamic candidates and falls back from an invalid request", async () => {
    const dynamicProfiles = createRlmProfileRegistry({
      dynamic: {
        name: "dynamic",
        description: "Dynamic test profile.",
        purpose: RlmProfilePurpose.Submind,
        authority: RlmProfileAuthority.Implementation,
        repositoryWritePermission: true,
        model: "fallback-model",
        modelPolicy: {
          preferredGroups: [RlmModelGroup.FastEfficient],
          requiredCapabilities: { toolCall: true },
        },
        systemMessagePrompt: "Answer directly.",
      },
    });
    const modelCatalog = parseCopilotModelCatalog({
      groups: {
        "frontier-current": [],
        "balanced-workhorse": [],
        "coding-specialist": [],
        "fast-efficient": ["fast-model"],
      },
      models: [
        {
          id: "fast-model",
          name: "Fast model",
          description: "Fast tool model.",
          preview: false,
          capabilities: {
            reasoning: true,
            tool_call: true,
            structured_output: true,
            attachments: false,
          },
        },
      ],
    });
    let configuredModel: unknown;
    const tool = createRlmTool({
      depthRemaining: 3,
      maxDepth: 3,
      profiles: dynamicProfiles,
      modelCatalog,
      clientFactory: () => ({
        async start() {},
        async createSession(config) {
          configuredModel = config.model;
          return {
            async sendAndWait() {
              return { data: { content: "done" } };
            },
            async disconnect() {},
          };
        },
        async stop() {},
      }),
    });

    const result = await invoke(tool, {
      prompt: "Do it.",
      profile: "dynamic",
      model: "invented-model",
    });
    const payload = JSON.parse(result.textResultForLlm);

    expect(configuredModel).toBe("fast-model");
    expect(payload).toMatchObject({
      model: "fast-model",
      modelRationale: expect.stringContaining("not eligible"),
    });
  });

  it("fails closed with a failure ToolResultObject when depth is exhausted, without invoking the client", async () => {
    const clientFactory = vi.fn(fakeClientFactory("unused"));
    const tool = createRlmTool({ depthRemaining: 0, maxDepth: 3, profiles, clientFactory });

    const result = await invoke(tool, { prompt: "Favorite color?", profile: "default" });
    expect(result).toMatchObject({ resultType: "failure" });
    expect((result as { error?: string }).error).toMatch(/depth/iu);
    expect(result.toolTelemetry).toMatchObject({
      rlm: {
        depthUsed: 4,
        budget: { maxCalls: 12, usedCalls: 0, remainingCalls: 12 },
      },
    });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("fails closed with a failure ToolResultObject for an unresolvable profile", async () => {
    const tool = createRlmTool({
      depthRemaining: 3,
      maxDepth: 3,
      profiles,
      clientFactory: fakeClientFactory("unused"),
    });

    const result = await invoke(tool, { prompt: "Favorite color?", profile: "nope" });
    expect(result).toMatchObject({ resultType: "failure" });
    expect((result as { error?: string }).error).toMatch(/nope/u);
  });

  it("prevents capability-scoped sessions from switching to an unrestricted profile", async () => {
    const clientFactory = vi.fn(fakeClientFactory("unused"));
    const tool = createRlmTool({
      depthRemaining: 3,
      maxDepth: 3,
      profiles: defaultRlmProfileRegistry,
      allowedProfiles: [RlmProfileName.Review],
      clientFactory,
    });

    const result = await invoke(tool, {
      prompt: "Escalate capabilities.",
      profile: RlmProfileName.General,
    });

    expect(result).toMatchObject({
      resultType: "failure",
      error: expect.stringMatching(/not allowed/iu),
    });
    expect(clientFactory).not.toHaveBeenCalled();
    expect(
      (tool.parameters as { properties: { profile: { enum: string[] } } }).properties.profile.enum,
    ).toEqual(["review"]);
  });

  it("shares one total-call budget across concurrent sibling invocations", async () => {
    const clientFactory = vi.fn(fakeClientFactory("done"));
    const tool = createRlmTool({
      depthRemaining: 3,
      maxDepth: 3,
      maxTotalCalls: 1,
      profiles,
      clientFactory,
    });

    const [first, second] = await Promise.all([
      invoke(tool, { prompt: "First.", profile: "default" }),
      invoke(tool, { prompt: "Second.", profile: "default" }),
    ]);
    const results = [first, second];

    expect(results.filter((result) => result.resultType === "success")).toHaveLength(1);
    expect(results.filter((result) => result.resultType === "failure")).toHaveLength(1);
    expect(results.find((result) => result.resultType === "failure")).toMatchObject({
      error: expect.stringMatching(/total call budget/iu),
    });
    expect(clientFactory).toHaveBeenCalledTimes(1);
  });

  it("registers a nested rlm tool on the spawned session, one depth level lower", async () => {
    let nestedSessionTools: unknown;
    const tool = createRlmTool({
      depthRemaining: 3,
      maxDepth: 3,
      profiles,
      clientFactory: () => ({
        async start() {},
        async createSession(config: Record<string, unknown>) {
          nestedSessionTools = config.tools;
          return {
            async sendAndWait() {
              return { data: { content: "done" } };
            },
            async disconnect() {},
          };
        },
        async stop() {},
      }),
    });

    await invoke(tool, { prompt: "Favorite color?", profile: "default" });

    expect(Array.isArray(nestedSessionTools)).toBe(true);
    const nestedTools = nestedSessionTools as Tool<RlmToolArgs>[];
    expect(nestedTools).toHaveLength(1);
    expect(nestedTools[0]!.name).toBe("rlm");
  });

  it("propagates a restricted profile's child-profile allowlist into recursive tools", async () => {
    let nestedTool: Tool<RlmToolArgs> | undefined;
    const tool = createRlmTool({
      depthRemaining: 3,
      maxDepth: 3,
      profiles: defaultRlmProfileRegistry,
      clientFactory: () => ({
        async start() {},
        async createSession(config) {
          [nestedTool] = config.tools as Tool<RlmToolArgs>[];
          return {
            async sendAndWait() {
              return { data: { content: "done" } };
            },
            async disconnect() {},
          };
        },
        async stop() {},
      }),
    });

    await invoke(tool, { prompt: "Validate.", profile: RlmProfileName.Validation });

    if (!nestedTool) {
      throw new Error("Expected restricted nested rlm tool.");
    }
    expect(
      (nestedTool.parameters as { properties: { profile: { enum: string[] } } }).properties.profile
        .enum,
    ).toEqual(["validation"]);
  });

  it("returns captured ask_user exchanges explicitly to the root conversation", async () => {
    let factoryCalls = 0;
    let answererTimeout: number | undefined;
    const ownerSession: RlmSession = {
      async sendAndWait() {
        return undefined;
      },
      async getEvents() {
        return [
          {
            type: "user.message",
            id: "user-1",
            parentId: null,
            timestamp: new Date().toISOString(),
            data: { content: "Develop a psychological profile." },
          },
        ];
      },
      async disconnect() {},
    };
    const clientFactory = (): RlmClient => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        return {
          async start() {},
          async createSession(config) {
            return {
              async sendAndWait() {
                const handler = config.onUserInputRequest as (
                  request: { question: string },
                  invocation: { sessionId: string },
                ) => Promise<{ answer: string }>;
                const response = await handler(
                  { question: "What is your favorite color?" },
                  { sessionId: "child" },
                );
                return { data: { content: response.answer } };
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
            async sendAndWait(_options, timeout) {
              answererTimeout = timeout;
              return { data: { content: "Blue." } };
            },
            async disconnect() {},
          };
        },
        async stop() {},
      };
    };
    const tool = createRlmTool({
      depthRemaining: 3,
      maxDepth: 3,
      profiles,
      clientFactory,
      consoleStreaming: false,
      rootSessionReference: {
        current: ownerSession,
        instructions: "Use all prior interview context.",
      },
    });

    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await invoke(tool, {
      prompt: "Ask for the subject's favorite color.",
      profile: "default",
    });
    write.mockRestore();
    const payload = JSON.parse((result as { textResultForLlm: string }).textResultForLlm);

    expect(payload).toEqual({
      text: "Blue.",
      depthUsed: 1,
      model: "test-model",
      modelRationale: "Profile uses fixed model test-model.",
      budget: { maxCalls: 12, usedCalls: 1, remainingCalls: 11 },
      userInputs: [{ question: "What is your favorite color?", answer: "Blue." }],
    });
    expect(factoryCalls).toBe(2);
    expect(answererTimeout).toBe(60_000);
  });

  it("bubbles ask_user exchanges from deeper recursive descendants to the root tool result", async () => {
    let factoryCalls = 0;
    let answererSystemPrompt = "";
    const rootConversationEvents: SessionEvent[] = [
      {
        type: "user.message",
        id: "user-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        data: { content: "Root fact: the favorite color is blue." },
      },
    ];
    const childConversationEvents: SessionEvent[] = [
      {
        type: "user.message",
        id: "child-user-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        data: { content: "Child-local context must not replace the root snapshot." },
      },
    ];
    const sessionWithConversation = (
      sendAndWait: RlmSession["sendAndWait"],
      events = childConversationEvents,
    ): RlmSession => ({
      sendAndWait,
      async getEvents() {
        return [...events];
      },
      async disconnect() {},
    });
    const clientFactory = (): RlmClient => {
      factoryCalls += 1;
      const call = factoryCalls;
      return {
        async start() {},
        async createSession(config) {
          if (call === 1) {
            return sessionWithConversation(async () => {
              const [nestedTool] = config.tools as Tool<RlmToolArgs>[];
              if (!nestedTool?.handler) {
                throw new Error("Expected nested rlm handler.");
              }
              const nestedResult = await nestedTool.handler(
                { prompt: "Ask the favorite color.", profile: "default" },
                {
                  sessionId: "depth-1",
                  toolCallId: "nested-call",
                  toolName: "rlm",
                  arguments: { prompt: "Ask the favorite color.", profile: "default" },
                },
              );
              return {
                data: {
                  content: (nestedResult as { textResultForLlm: string }).textResultForLlm,
                },
              };
            });
          }
          if (call === 2) {
            return sessionWithConversation(async () => {
              const handler = config.onUserInputRequest as (
                request: { question: string },
                invocation: { sessionId: string },
              ) => Promise<{ answer: string }>;
              const response = await handler(
                { question: "What is your favorite color?" },
                { sessionId: "depth-2" },
              );
              return { data: { content: response.answer } };
            });
          }
          answererSystemPrompt =
            (config.systemMessage as { content: string } | undefined)?.content ?? "";
          return {
            async sendAndWait() {
              return { data: { content: "Blue." } };
            },
            async disconnect() {},
          };
        },
        async stop() {},
      };
    };
    const ownerSession = sessionWithConversation(async () => undefined, rootConversationEvents);
    const tool = createRlmTool({
      depthRemaining: 3,
      maxDepth: 3,
      profiles,
      clientFactory,
      consoleStreaming: false,
      rootSessionReference: { current: ownerSession, instructions: "Use prior context." },
    });

    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await invoke(tool, { prompt: "Delegate another level.", profile: "default" });
    write.mockRestore();
    const payload = JSON.parse((result as { textResultForLlm: string }).textResultForLlm);

    expect(payload.depthUsed).toBe(1);
    expect(payload.budget).toEqual({
      maxCalls: 12,
      usedCalls: 2,
      remainingCalls: 10,
    });
    expect(payload.userInputs).toEqual([
      { question: "What is your favorite color?", answer: "Blue." },
    ]);
    expect(answererSystemPrompt).toContain("Root fact: the favorite color is blue.");
    expect(answererSystemPrompt).not.toContain(
      "Child-local context must not replace the root snapshot.",
    );
    expect(factoryCalls).toBe(3);
  });

  it("preserves completed ask_user exchanges when a descendant exhausts the call budget", async () => {
    let factoryCalls = 0;
    const ownerSession: RlmSession = {
      async sendAndWait() {
        return undefined;
      },
      async getEvents() {
        return [];
      },
      async disconnect() {},
    };
    const clientFactory = (): RlmClient => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        return {
          async start() {},
          async createSession(config) {
            return {
              async sendAndWait() {
                const askUser = config.onUserInputRequest as (
                  request: { question: string },
                  invocation: { sessionId: string },
                ) => Promise<{ answer: string }>;
                await askUser(
                  { question: "What is your favorite color?" },
                  { sessionId: "depth-1" },
                );
                const [nestedTool] = config.tools as Tool<RlmToolArgs>[];
                if (!nestedTool?.handler) {
                  throw new Error("Expected nested rlm handler.");
                }
                const nestedResult = (await nestedTool.handler(
                  { prompt: "Try one more call.", profile: "default" },
                  {
                    sessionId: "depth-1",
                    toolCallId: "over-budget",
                    toolName: "rlm",
                    arguments: { prompt: "Try one more call.", profile: "default" },
                  },
                )) as ToolResultObject;
                return { data: { content: nestedResult.textResultForLlm } };
              },
              async getEvents() {
                return [];
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
            async sendAndWait() {
              return { data: { content: "Blue." } };
            },
            async disconnect() {},
          };
        },
        async stop() {},
      };
    };
    const tool = createRlmTool({
      depthRemaining: 3,
      maxDepth: 3,
      maxTotalCalls: 1,
      profiles,
      clientFactory,
      consoleStreaming: false,
      rootSessionReference: { current: ownerSession },
    });

    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await invoke(tool, { prompt: "Ask then recurse.", profile: "default" });
    write.mockRestore();
    const payload = JSON.parse(result.textResultForLlm);

    expect(payload.text).toContain("total call budget exceeded");
    expect(payload.userInputs).toEqual([
      { question: "What is your favorite color?", answer: "Blue." },
    ]);
    expect(payload.budget).toEqual({
      maxCalls: 1,
      usedCalls: 1,
      remainingCalls: 0,
    });
    expect(factoryCalls).toBe(2);
  });
});
