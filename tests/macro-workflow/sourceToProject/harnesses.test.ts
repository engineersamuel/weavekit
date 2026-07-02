import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowHarnessKind, WorkflowNodeKind } from "../../../src/macro-workflow/types.js";
import {
  createCopilotSdkHarnessClient,
  createSourceToProjectUserInputRequestHandler,
  createSourceToProjectDynamicExpander,
  createSourceToProjectHarnessRegistry,
  selectAcceptedOpportunities,
} from "../../../src/macro-workflow/sourceToProject/harnesses.js";

describe("source-to-project harness registry", () => {
  afterEach(() => {
    delete process.env.BAML_MODEL;
    delete process.env.WEAVEKIT_SOURCE_TO_PROJECT_MODEL;
    delete process.env.WEAVEKIT_SOURCE_TO_PROJECT_TIMEOUT_MS;
    delete process.env.WEAVEKIT_SOURCE_TO_PROJECT_MAX_TOOL_CALLS;
    delete process.env.WEAVEKIT_SOURCE_READING_MAX_TOOL_CALLS;
    delete process.env.WEAVEKIT_PROJECT_RESEARCH_MAX_TOOL_CALLS;
    delete process.env.WEAVEKIT_AGENT_NATIVE_SKILLS_INSTALLER;
    delete process.env.WEAVEKIT_MISE_BIN;
  });

  it("distills source reading output into typed payload", async () => {
    process.env.WEAVEKIT_SOURCE_TO_PROJECT_MODEL = "copilot-research-model";
    process.env.BAML_MODEL = "baml-distill-model";
    const copilotCalls: Array<{ prompt: string; maxToolCalls?: number }> = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/post",
      project: {
        id: "weavekit",
        displayName: "Weavekit",
        workingTree: "/tmp/weavekit",
        mainline: "origin main",
        remote: "origin",
        contextDocs: ["CONTEXT.md"],
        validationCommands: ["nub run typecheck"],
        autonomousPrAllowed: false,
        notification: "cli",
        knowledgeExport: "off",
      },
      mode: "advisory",
      copilot: {
        async run(args) {
          copilotCalls.push({ prompt: args.prompt, maxToolCalls: args.maxToolCalls });
          return "raw source research";
        },
      },
      baml: {
        async DistillSourceAnalysis() {
          return {
            sourceId: "source-1",
            title: "Post",
            accessLevel: "public",
            summary: "Summary",
            claims: ["Claim"],
            transferableLessons: ["Lesson"],
            evidence: [{ id: "e1", source: "https://example.com/post", quote: "Claim" }],
          };
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!({
      id: "source-reading",
      kind: "research",
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Read source",
      prompt: "Read",
      dependsOn: [],
      gates: ["output-contract"],
      writeMode: "read-only",
      replanPolicy: "never",
    }, { payloads: new Map(), artifacts: new Map() });

    expect(result.status).toBe("passed");
    expect(result.payload?.sourceAnalysis).toMatchObject({ sourceId: "source-1", title: "Post" });
    expect(copilotCalls[0]?.prompt).toContain("Read the Source artifact");
    expect(copilotCalls[0]?.prompt).toContain("Hard budget: use at most 40 tool calls");
    expect(copilotCalls[0]?.prompt).toContain("Source: https://example.com/post");
    expect(copilotCalls[0]?.maxToolCalls).toBe(40);
    expect(result.execution?.executor).toBe("copilot-sdk");
    expect(result.execution?.calls?.map((call) => call.executor)).toEqual(["copilot-sdk", "baml"]);
    expect(result.execution?.calls?.[0]).toMatchObject({
      executor: "copilot-sdk",
      mode: "research",
      model: "copilot-research-model",
      prompt: copilotCalls[0]?.prompt,
    });
    expect(result.execution?.calls?.[1]).toMatchObject({
      executor: "baml",
      operation: "DistillSourceAnalysis",
      model: "baml-distill-model",
    });
  });

  it("runs prompts through a Copilot SDK session in the live client", async () => {
    const calls: string[] = [];
    const session = {
      async sendAndWait(message: { prompt: string }) {
        calls.push(`send:${message.prompt}`);
        return { data: { content: "live response" } };
      },
      async disconnect() {
        calls.push("disconnect");
      },
    };
    const client = {
      async start() {
        calls.push("start");
      },
      async createSession(config: unknown) {
        const record = config as Record<string, unknown>;
        calls.push(`session:${String(record.model)}:${String(record.cwd)}`);
        return session;
      },
      async stop() {
        calls.push("stop");
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({
      model: "gpt-test",
      clientFactory: () => client,
    });

    const result = await copilot.run({ cwd: "/tmp/project", prompt: "Research project", mode: "research" });

    expect(copilot.model).toBe("gpt-test");
    expect(result).toBe("live response");
    expect(calls).toEqual([
      "start",
      "session:gpt-test:/tmp/project",
      "send:Research project",
      "disconnect",
      "stop",
    ]);
  });

  it("uses an explicit client factory without requiring the platform package resolver", async () => {
    const client = {
      async start() {},
      async createSession() {
        return {
          async sendAndWait() {
            return { data: { content: "live response" } };
          },
          async disconnect() {},
        };
      },
      async stop() {
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({ clientFactory: () => client });

    await expect(copilot.run({ prompt: "Hello", mode: "research" })).resolves.toBe("live response");
  });

  it("defaults the Copilot SDK model to the source-to-project primary model, not BAML_MODEL", async () => {
    process.env.BAML_MODEL = "gpt-5-mini";
    const models: unknown[] = [];
    const client = {
      async start() {},
      async createSession(config: unknown) {
        models.push((config as { model?: string }).model);
        return {
          async sendAndWait() {
            return { data: { content: "live response" } };
          },
          async disconnect() {},
        };
      },
      async stop() {
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({ clientFactory: () => client });

    await copilot.run({ prompt: "Hello", mode: "research" });

    expect(models).toEqual(["gpt-5.5"]);
  });

  it("uses the per-call Copilot SDK model when one is supplied", async () => {
    const models: unknown[] = [];
    const client = {
      async start() {},
      async createSession(config: unknown) {
        models.push((config as { model?: string }).model);
        return {
          async sendAndWait() {
            return { data: { content: "live response" } };
          },
          async disconnect() {},
        };
      },
      async stop() {
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({ model: "gpt-default", clientFactory: () => client });

    await copilot.run({ prompt: "Implement", mode: "implement", model: "gpt-5.3-codex" });

    expect(models).toEqual(["gpt-5.3-codex"]);
  });

  it("uses WEAVEKIT_SOURCE_TO_PROJECT_TIMEOUT_MS for Copilot SDK calls", async () => {
    process.env.WEAVEKIT_SOURCE_TO_PROJECT_TIMEOUT_MS = "600000";
    const timeouts: unknown[] = [];
    const client = {
      async start() {},
      async createSession() {
        return {
          async sendAndWait(_message: { prompt: string }, timeout?: number) {
            timeouts.push(timeout);
            return { data: { content: "live response" } };
          },
          async disconnect() {},
        };
      },
      async stop() {
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({ clientFactory: () => client });

    await copilot.run({ prompt: "Corroborate source", mode: "research" });

    expect(timeouts).toEqual([600000]);
  });

  it("uses WEAVEKIT_SOURCE_READING_MAX_TOOL_CALLS for source-reading Copilot runs", async () => {
    process.env.WEAVEKIT_SOURCE_READING_MAX_TOOL_CALLS = "12";
    const maxToolCalls: Array<number | undefined> = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/post",
      project: projectFixture(),
      mode: "advisory",
      copilot: {
        async run(args) {
          maxToolCalls.push(args.maxToolCalls);
          return "raw source research";
        },
      },
      baml: {
        async DistillSourceAnalysis() {
          return sourceAnalysisFixture();
        },
      },
    });

    await registry.get(WorkflowHarnessKind.COPILOT_SDK)!({
      id: "source-reading",
      kind: "research",
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Read source",
      prompt: "Read",
      dependsOn: [],
      gates: ["output-contract"],
      writeMode: "read-only",
      replanPolicy: "never",
    }, { payloads: new Map(), artifacts: new Map() });

    expect(maxToolCalls).toEqual([12]);
  });

  it("uses WEAVEKIT_PROJECT_RESEARCH_MAX_TOOL_CALLS for project-research Copilot runs", async () => {
    process.env.WEAVEKIT_PROJECT_RESEARCH_MAX_TOOL_CALLS = "24";
    const maxToolCalls: Array<number | undefined> = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/post",
      project: projectFixture(),
      mode: "advisory",
      copilot: {
        async run(args) {
          maxToolCalls.push(args.maxToolCalls);
          return "raw project research";
        },
      },
      baml: {
        async DistillProjectBrief() {
          return projectBriefFixture();
        },
      },
    });

    await registry.get(WorkflowHarnessKind.COPILOT_SDK)!({
      id: "project-research",
      kind: "research",
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Research target project",
      prompt: "Research",
      dependsOn: ["source-corroboration"],
      gates: ["output-contract"],
      writeMode: "read-only",
      replanPolicy: "never",
    }, { payloads: new Map(), artifacts: new Map(), objective: "Apply source" });

    expect(maxToolCalls).toEqual([24]);
  });

  it("denies Copilot SDK tool calls after the configured tool-call budget", async () => {
    const logs: Array<{ phase: string; toolCallCount?: number; maxToolCalls?: number; toolName?: string }> = [];
    const decisions: unknown[] = [];
    const client = {
      async start() {},
      async createSession(config: unknown) {
        const hook = (config as {
          hooks?: { onPreToolUse?: (input: { toolName?: string }) => unknown };
        }).hooks?.onPreToolUse;
        decisions.push(hook?.({ toolName: "glob" }));
        decisions.push(hook?.({ toolName: "view" }));
        decisions.push(hook?.({ toolName: "glob" }));
        return {
          async sendAndWait() {
            return { data: { content: "live response" } };
          },
          async disconnect() {},
        };
      },
      async stop() {
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({
      maxToolCalls: 2,
      clientFactory: () => client,
      onLog(event) {
        logs.push({
          phase: event.phase,
          toolCallCount: event.toolCallCount,
          maxToolCalls: event.maxToolCalls,
          toolName: event.toolName,
        });
      },
    });

    await expect(copilot.run({ prompt: "Read source", mode: "research" })).resolves.toBe("live response");

    expect(decisions.slice(0, 2)).toEqual([undefined, undefined]);
    expect(decisions[2]).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("2-tool research budget"),
    });
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: "tool-budget",
        toolName: "glob",
        toolCallCount: 3,
        maxToolCalls: 2,
      }),
    ]));
  });

  it("uses the last assistant message when the SDK never emits session idle", async () => {
    const logs: Array<{ phase: string; eventType?: string; contentLength?: number; timeoutMs?: number }> = [];
    const session = {
      handlers: [] as Array<(event: { type: string; data?: { content?: string } }) => void>,
      async send(message: { prompt: string }) {
        queueMicrotask(() => {
          for (const handler of this.handlers) {
            handler({ type: "assistant.message", data: { content: `partial for ${message.prompt}` } });
          }
        });
        return "message-1";
      },
      on(_eventHandler: unknown, maybeHandler?: unknown) {
        const handler = typeof maybeHandler === "function" ? maybeHandler : _eventHandler;
        this.handlers.push(handler as (event: { type: string; data?: { content?: string } }) => void);
        return () => {
          this.handlers = this.handlers.filter((candidate) => candidate !== handler);
        };
      },
      async disconnect() {},
    };
    const client = {
      async start() {},
      async createSession() {
        return session;
      },
      async stop() {
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({
      timeoutMs: 10,
      clientFactory: () => client,
      onLog(event) {
        logs.push({
          phase: event.phase,
          eventType: event.eventType,
          contentLength: event.contentLength,
          timeoutMs: event.timeoutMs,
        });
      },
    });

    await expect(copilot.run({ prompt: "Read source", mode: "research" })).resolves.toBe("partial for Read source");
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "client-create" }),
        expect.objectContaining({ phase: "session-created" }),
        expect.objectContaining({ phase: "prompt-send", timeoutMs: 10 }),
        expect.objectContaining({ phase: "timeout-partial", timeoutMs: 10 }),
        expect.objectContaining({ phase: "disconnect" }),
        expect.objectContaining({ phase: "client-stop" }),
      ]),
    );
    expect(logs.some((log) => log.phase === "assistant-message")).toBe(false);
  });

  it("suppresses raw Copilot SDK session-event logs by default", async () => {
    const logs: Array<{ phase: string; eventType?: string; contentLength?: number }> = [];
    const session = {
      handlers: [] as Array<(event: { type: string; data?: { content?: string; toolName?: string } }) => void>,
      async send() {
        queueMicrotask(() => {
          for (const handler of this.handlers) {
            handler({ type: "tool.execution_start", data: { toolName: "web_fetch" } });
            handler({ type: "hook.start" });
            handler({ type: "hook.end" });
            handler({ type: "permission.requested" });
            handler({ type: "permission.completed" });
            handler({ type: "assistant.streaming_delta", data: { content: "a" } });
            handler({ type: "assistant.message_delta", data: { content: "ab" } });
            handler({ type: "assistant.message", data: { content: "final answer" } });
            handler({ type: "tool.execution_complete", data: { toolName: "web_fetch" } });
            handler({ type: "session.idle" });
          }
        });
        return "message-1";
      },
      on(_eventHandler: unknown, maybeHandler?: unknown) {
        const handler = typeof maybeHandler === "function" ? maybeHandler : _eventHandler;
        this.handlers.push(handler as (event: { type: string; data?: { content?: string; toolName?: string } }) => void);
        return () => {
          this.handlers = this.handlers.filter((candidate) => candidate !== handler);
        };
      },
      async disconnect() {},
    };
    const client = {
      async start() {},
      async createSession() {
        return session;
      },
      async stop() {
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({
      clientFactory: () => client,
      onLog(event) {
        logs.push({
          phase: event.phase,
          eventType: event.eventType,
          contentLength: event.contentLength,
        });
      },
    });

    await expect(copilot.run({ prompt: "Read source", mode: "research" })).resolves.toBe("final answer");
    expect(logs.some((log) => log.phase === "session-event")).toBe(false);
    expect(logs.map((log) => log.eventType)).not.toEqual(expect.arrayContaining([
      "tool.execution_start",
      "hook.start",
      "hook.end",
      "permission.requested",
      "permission.completed",
      "assistant.streaming_delta",
      "assistant.message_delta",
      "assistant.message",
      "tool.execution_complete",
      "session.idle",
    ]));
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "session-idle" }),
    ]));
    expect(logs.some((log) => log.phase === "assistant-message")).toBe(false);
  });

  it("emits raw Copilot SDK session-event logs when verbose events are enabled", async () => {
    const logs: Array<{ eventType?: string }> = [];
    const session = {
      handlers: [] as Array<(event: { type: string; data?: { content?: string; toolName?: string } }) => void>,
      async send() {
        queueMicrotask(() => {
          for (const handler of this.handlers) {
            handler({ type: "tool.execution_start", data: { toolName: "web_fetch" } });
            handler({ type: "hook.start" });
            handler({ type: "permission.requested" });
            handler({ type: "assistant.streaming_delta", data: { content: "a" } });
            handler({ type: "assistant.message_delta", data: { content: "ab" } });
            handler({ type: "assistant.message", data: { content: "final answer" } });
            handler({ type: "tool.execution_complete", data: { toolName: "web_fetch" } });
            handler({ type: "session.idle" });
          }
        });
        return "message-1";
      },
      on(_eventHandler: unknown, maybeHandler?: unknown) {
        const handler = typeof maybeHandler === "function" ? maybeHandler : _eventHandler;
        this.handlers.push(handler as (event: { type: string; data?: { content?: string; toolName?: string } }) => void);
        return () => {
          this.handlers = this.handlers.filter((candidate) => candidate !== handler);
        };
      },
      async disconnect() {},
    };
    const client = {
      async start() {},
      async createSession() {
        return session;
      },
      async stop() {
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({
      verboseEvents: true,
      clientFactory: () => client,
      onLog(event) {
        logs.push({ eventType: event.eventType });
      },
    });

    await expect(copilot.run({ prompt: "Read source", mode: "research" })).resolves.toBe("final answer");
    expect(logs.map((log) => log.eventType)).toEqual(expect.arrayContaining([
      "tool.execution_start",
      "hook.start",
      "permission.requested",
      "assistant.streaming_delta",
      "assistant.message_delta",
      "assistant.message",
      "tool.execution_complete",
      "session.idle",
    ]));
  });

  it("emits Copilot SDK token usage from assistant usage events", async () => {
    const usageEvents: Array<{
      operation?: string;
      model: string;
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
    }> = [];
    const session = {
      handlers: [] as Array<(event: { type: string; data?: Record<string, unknown> }) => void>,
      async send() {
        queueMicrotask(() => {
          for (const handler of this.handlers) {
            handler({
              type: "assistant.usage",
              data: {
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 25,
                  prompt_tokens_details: { cached_tokens: 40 },
                },
              },
            });
            handler({ type: "assistant.message", data: { content: "final answer" } });
            handler({ type: "session.idle" });
          }
        });
        return "message-1";
      },
      on(_eventHandler: unknown, maybeHandler?: unknown) {
        const handler = typeof maybeHandler === "function" ? maybeHandler : _eventHandler;
        this.handlers.push(handler as (event: { type: string; data?: Record<string, unknown> }) => void);
        return () => {
          this.handlers = this.handlers.filter((candidate) => candidate !== handler);
        };
      },
      async disconnect() {},
    };
    const client = {
      async start() {},
      async createSession() {
        return session;
      },
      async stop() {
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({
      model: "gpt-5.5",
      clientFactory: () => client,
      onUsage(event) {
        usageEvents.push({
          operation: event.operation,
          model: event.model,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cachedInputTokens: event.usage.cachedInputTokens,
        });
      },
    });

    await expect(copilot.run({
      prompt: "Read source",
      mode: "research",
      operation: "source-reading",
    })).resolves.toBe("final answer");

    expect(usageEvents).toEqual([
      {
        operation: "source-reading",
        model: "gpt-5.5",
        inputTokens: 100,
        outputTokens: 25,
        cachedInputTokens: 40,
      },
    ]);
  });

  it("rejects Copilot SDK user-input requests instead of answering them locally", async () => {
    const client = {
      async start() {},
      async createSession(config: unknown) {
        const handler = (config as {
          onUserInputRequest?: (request: { question: string }) => Promise<unknown>;
        }).onUserInputRequest;
        await handler?.({ question: "Can I ask the user what to inspect?" });
        return {
          async sendAndWait() {
            return { data: { content: "live response" } };
          },
          async disconnect() {},
        };
      },
      async stop() {
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({ clientFactory: () => client });

    await expect(copilot.run({ prompt: "Read source", mode: "research" })).rejects.toThrow(
      /must resolve this through Telegram elicitation or by replanning with decision-council nodes/,
    );
  });

  it("sends Copilot SDK user-input questions through the source-to-project notifier before failing for replanning", async () => {
    const notifications: string[] = [];
    const handler = createSourceToProjectUserInputRequestHandler({
      source: "https://example.com/source",
      project: projectFixture(),
      notifier: {
        async notifyRejection() {
          throw new Error("not used");
        },
        async notifyElicitation(args) {
          notifications.push(args.question);
          return { channel: "telegram", status: "sent", message: args.question };
        },
      },
    });

    await handler({ question: "Which loop should apply?", choices: ["A", "B"] });

    expect(notifications).toEqual(["Which loop should apply?\nChoices: A, B"]);
  });

  it("accepts opportunities with at least 0.85 average applicability, impact, and confidence", () => {
    const acceptances = selectAcceptedOpportunities(latestRunCouncilReviewFixture(), {
      minApplicability: 0.7,
      minConfidence: 0.65,
      minImpact: 0.5,
      minAcceptanceAverage: 0.85,
      maxRisk: 0.8,
    });

    expect(acceptances.filter((acceptance) => acceptance.accepted).map((acceptance) => acceptance.id)).toEqual([
      "opp-1",
      "opp-3",
      "opp-4",
    ]);
    expect(acceptances.find((acceptance) => acceptance.id === "opp-2")?.reason).toContain("speculative");
  });

  it("creates dynamic planning, review, report, and visual design nodes after council review", async () => {
    const expander = createSourceToProjectDynamicExpander({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
    });

    const nodes = await expander({
      node: {
        id: "council-review",
        kind: "deliberation",
        harness: WorkflowHarnessKind.DECISION_COUNCIL,
        title: "Rank and bundle opportunities",
        prompt: "Rank",
        dependsOn: ["opportunity-mapping"],
        gates: ["review-accepted"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      result: {
        nodeId: "council-review",
        status: "passed",
        output: "Council ranked opportunities.",
        payload: { councilReview: latestRunCouncilReviewFixture() },
      },
      currentPlan: {
        id: "source-plan",
        objective: "Apply loops",
        templateId: "source-to-project",
        maxReplans: 0,
        nodes: [],
      },
      payloads: new Map(),
      completedNodeIds: new Set(),
    });

    expect(nodes?.map((node) => node.id)).toEqual([
      "plan-opportunity-opp-1",
      "review-opportunity-opp-1",
      "report-opportunity-opp-1",
      "visual-design-opportunity-opp-1",
      "plan-opportunity-opp-3",
      "review-opportunity-opp-3",
      "report-opportunity-opp-3",
      "visual-design-opportunity-opp-3",
      "plan-opportunity-opp-4",
      "review-opportunity-opp-4",
      "report-opportunity-opp-4",
      "visual-design-opportunity-opp-4",
    ]);
    expect(nodes?.find((node) => node.id === "report-opportunity-opp-1")).toMatchObject({
      kind: WorkflowNodeKind.REPORT,
      title: "Report opp-1: Add a conservative loop-engineering-starter advisory template",
      dependsOn: ["review-opportunity-opp-1"],
    });
    expect(nodes?.find((node) => node.id === "visual-design-opportunity-opp-1")).toMatchObject({
      kind: WorkflowNodeKind.VISUALIZATION,
      title: "Visual design opp-1: Add a conservative loop-engineering-starter advisory template",
      dependsOn: ["report-opportunity-opp-1"],
      model: "claude-opus-4.8",
    });
    expect(nodes?.find((node) => node.id === "report-opportunity-opp-1")).toMatchObject({
      model: "deterministic",
    });
    expect(nodes?.filter((node) => node.kind === WorkflowNodeKind.REPORT)).toHaveLength(3);
  });

  it("publishes a markdown report and feeds it into the visual-plan design node", async () => {
    const copilotCalls: Array<{ cwd?: string; prompt: string; mode: string; model?: string }> = [];
    const shellCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const acceptance = selectAcceptedOpportunities(latestRunCouncilReviewFixture(), {
      minApplicability: 0.7,
      minConfidence: 0.65,
      minImpact: 0.5,
      minAcceptanceAverage: 0.85,
      maxRisk: 0.8,
    }).find((candidate) => candidate.id === "opp-1")!;
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      shell: {
        async run(command, args, options) {
          shellCalls.push({ command, args, cwd: options.cwd });
          return "visual-plan installed";
        },
      },
      copilot: {
        async run(args) {
          copilotCalls.push(args);
          return "visual plan artifact";
        },
      },
    });
    const reportNode = {
      id: "report-opportunity-opp-1",
      kind: WorkflowNodeKind.REPORT,
      harness: WorkflowHarnessKind.REPORTER,
      title: "Report opp-1",
      prompt: "Report",
      input: {
        opportunity: acceptance.opportunity,
        opportunityAcceptance: acceptance,
      },
      dependsOn: ["review-opportunity-opp-1"],
      gates: ["output-contract" as const],
      writeMode: "read-only" as const,
      replanPolicy: "never" as const,
    };

    const reportResult = await registry.get(WorkflowHarnessKind.REPORTER)!(reportNode, {
      payloads: new Map([
        ["review-opportunity-opp-1", {
          finalRecommendationReview: acceptedFinalRecommendationReviewFixture(),
          plan: planSummaryFixture("Loop init plan"),
        }],
      ]),
      artifacts: new Map(),
    });

    expect(reportResult.status).toBe("passed");
    expect(reportResult.output).toContain("# Source-to-Project Report: opp-1");
    expect(reportResult.payload?.sourceToProjectReportMarkdown).toContain("## Implementation Outline");

    const visualResult = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!({
      id: "visual-design-opportunity-opp-1",
      kind: WorkflowNodeKind.VISUALIZATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Visual design opp-1",
      prompt: "Visual design",
      input: {
        opportunity: acceptance.opportunity,
        opportunityAcceptance: acceptance,
      },
      dependsOn: ["report-opportunity-opp-1"],
      gates: ["output-contract" as const],
      writeMode: "read-only" as const,
      replanPolicy: "never" as const,
    }, {
      payloads: new Map([
        ["report-opportunity-opp-1", reportResult.payload!],
      ]),
      artifacts: new Map(),
    });

    expect(shellCalls).toEqual([{
      command: "nub",
      args: ["x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
      cwd: "/tmp/secondbrain",
    }]);
    expect(copilotCalls).toHaveLength(1);
    expect(copilotCalls[0]).toMatchObject({ cwd: "/tmp/secondbrain", mode: "plan", model: "claude-opus-4.8" });
    expect(copilotCalls[0]?.prompt).toContain("/visual-plan Create an actual visual design artifact");
    expect(copilotCalls[0]?.prompt).toContain("# Source-to-Project Report: opp-1");
    expect(visualResult.payload?.sourceToProjectVisualPlan).toMatchObject({
      opportunityId: "opp-1",
      skill: "visual-plan",
      rawVisualPlan: "visual plan artifact",
    });
  });

  it("falls back to mise exec when the visual-plan installer cannot spawn nub directly", async () => {
    const shellCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const copilotCalls: Array<{ cwd?: string; prompt: string; mode: string; model?: string }> = [];
    const acceptance = selectAcceptedOpportunities(latestRunCouncilReviewFixture(), {
      minApplicability: 0.7,
      minConfidence: 0.65,
      minImpact: 0.5,
      minAcceptanceAverage: 0.85,
      maxRisk: 0.8,
    }).find((candidate) => candidate.id === "opp-1")!;
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      shell: {
        async run(command, args, options) {
          shellCalls.push({ command, args, cwd: options.cwd });
          if (command === "nub") {
            throw Object.assign(new Error("spawn nub ENOENT"), { code: "ENOENT" });
          }
          return "visual-plan installed through mise";
        },
      },
      copilot: {
        async run(args) {
          copilotCalls.push(args);
          return "visual plan artifact";
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!({
      id: "visual-design-opportunity-opp-1",
      kind: WorkflowNodeKind.VISUALIZATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Visual design opp-1",
      prompt: "Visual design",
      input: {
        opportunity: acceptance.opportunity,
        opportunityAcceptance: acceptance,
      },
      dependsOn: ["report-opportunity-opp-1"],
      gates: ["output-contract" as const],
      writeMode: "read-only" as const,
      replanPolicy: "never" as const,
    }, {
      payloads: new Map([
        ["report-opportunity-opp-1", { sourceToProjectReportMarkdown: "# Report" }],
      ]),
      artifacts: new Map(),
    });

    expect(shellCalls).toEqual([
      {
        command: "nub",
        args: ["x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
        cwd: "/tmp/secondbrain",
      },
      {
        command: "mise",
        args: ["exec", "--", "nub", "x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
        cwd: "/tmp/secondbrain",
      },
    ]);
    expect(copilotCalls).toHaveLength(1);
    expect(result.payload?.sourceToProjectVisualPlan).toMatchObject({
      skillInstall: {
        command: "mise",
        args: ["exec", "--", "nub", "x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
        output: "visual-plan installed through mise",
      },
      rawVisualPlan: "visual plan artifact",
    });
  });

  it("falls back to an absolute mise path when neither nub nor mise are on PATH", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "weavekit-mise-absolute-"));
    const configuredMise = join(tempDir, "mise");

    await writeFile(configuredMise, "#!/bin/sh\nexit 0\n");
    await chmod(configuredMise, 0o755);
    process.env.WEAVEKIT_MISE_BIN = configuredMise;

    const shellCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const copilotCalls: Array<{ cwd?: string; prompt: string; mode: string; model?: string }> = [];
    const acceptance = selectAcceptedOpportunities(latestRunCouncilReviewFixture(), {
      minApplicability: 0.7,
      minConfidence: 0.65,
      minImpact: 0.5,
      minAcceptanceAverage: 0.85,
      maxRisk: 0.8,
    }).find((candidate) => candidate.id === "opp-1")!;
    try {
      const registry = createSourceToProjectHarnessRegistry({
        source: "https://example.com/loops",
        project: projectFixture(),
        mode: "advisory",
        shell: {
          async run(command, args, options) {
            shellCalls.push({ command, args, cwd: options.cwd });
            if (command === "nub") {
              throw Object.assign(new Error("spawn nub ENOENT"), { code: "ENOENT" });
            }
            if (command === "mise") {
              throw Object.assign(new Error("spawn mise ENOENT"), { code: "ENOENT" });
            }
            return "visual-plan installed through absolute mise";
          },
        },
        copilot: {
          async run(args) {
            copilotCalls.push(args);
            return "visual plan artifact";
          },
        },
      });

      const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!({
        id: "visual-design-opportunity-opp-1",
        kind: WorkflowNodeKind.VISUALIZATION,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Visual design opp-1",
        prompt: "Visual design",
        input: {
          opportunity: acceptance.opportunity,
          opportunityAcceptance: acceptance,
        },
        dependsOn: ["report-opportunity-opp-1"],
        gates: ["output-contract" as const],
        writeMode: "read-only" as const,
        replanPolicy: "never" as const,
      }, {
        payloads: new Map([
          ["report-opportunity-opp-1", { sourceToProjectReportMarkdown: "# Report" }],
        ]),
        artifacts: new Map(),
      });

      expect(shellCalls).toEqual([
        {
          command: "nub",
          args: ["x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
          cwd: "/tmp/secondbrain",
        },
        {
          command: "mise",
          args: ["exec", "--", "nub", "x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
          cwd: "/tmp/secondbrain",
        },
        {
          command: configuredMise,
          args: ["exec", "--", "nub", "x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
          cwd: "/tmp/secondbrain",
        },
      ]);
      expect(copilotCalls).toHaveLength(1);
      expect(result.payload?.sourceToProjectVisualPlan).toMatchObject({
        skillInstall: {
          command: configuredMise,
          args: ["exec", "--", "nub", "x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
          output: "visual-plan installed through absolute mise",
        },
        rawVisualPlan: "visual plan artifact",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips a stale configured mise path and uses a discovered executable path", async () => {
    const originalPath = process.env.PATH;
    const tempDir = await mkdtemp(join(tmpdir(), "weavekit-mise-repro-"));
    const binDir = join(tempDir, "bin");
    const discoveredMise = join(binDir, "mise");

    try {
      await mkdir(binDir);
      await writeFile(discoveredMise, "#!/bin/sh\nexit 0\n");
      await chmod(discoveredMise, 0o755);
      process.env.PATH = originalPath ? `${binDir}${delimiter}${originalPath}` : binDir;
      process.env.WEAVEKIT_MISE_BIN = join(tempDir, "missing", "mise");

      const shellCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
      const copilotCalls: Array<{ cwd?: string; prompt: string; mode: string; model?: string }> = [];
      const acceptance = selectAcceptedOpportunities(latestRunCouncilReviewFixture(), {
        minApplicability: 0.7,
        minConfidence: 0.65,
        minImpact: 0.5,
        minAcceptanceAverage: 0.85,
        maxRisk: 0.8,
      }).find((candidate) => candidate.id === "opp-1")!;
      const registry = createSourceToProjectHarnessRegistry({
        source: "https://example.com/loops",
        project: projectFixture(),
        mode: "advisory",
        shell: {
          async run(command, args, options) {
            shellCalls.push({ command, args, cwd: options.cwd });
            if (command === "nub") {
              throw Object.assign(new Error("spawn nub ENOENT"), { code: "ENOENT" });
            }
            if (command === "mise") {
              throw Object.assign(new Error("spawn mise ENOENT"), { code: "ENOENT" });
            }
            if (command === process.env.WEAVEKIT_MISE_BIN) {
              throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
            }
            if (command === discoveredMise) {
              return "visual-plan installed through discovered mise";
            }
            throw new Error(`unexpected command ${command}`);
          },
        },
        copilot: {
          async run(args) {
            copilotCalls.push(args);
            return "visual plan artifact";
          },
        },
      });

      const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!({
        id: "visual-design-opportunity-opp-1",
        kind: WorkflowNodeKind.VISUALIZATION,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Visual design opp-1",
        prompt: "Visual design",
        input: {
          opportunity: acceptance.opportunity,
          opportunityAcceptance: acceptance,
        },
        dependsOn: ["report-opportunity-opp-1"],
        gates: ["output-contract" as const],
        writeMode: "read-only" as const,
        replanPolicy: "never" as const,
      }, {
        payloads: new Map([
          ["report-opportunity-opp-1", { sourceToProjectReportMarkdown: "# Report" }],
        ]),
        artifacts: new Map(),
      });

      expect(shellCalls).toEqual([
        {
          command: "nub",
          args: ["x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
          cwd: "/tmp/secondbrain",
        },
        {
          command: "mise",
          args: ["exec", "--", "nub", "x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
          cwd: "/tmp/secondbrain",
        },
        {
          command: discoveredMise,
          args: ["exec", "--", "nub", "x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
          cwd: "/tmp/secondbrain",
        },
      ]);
      expect(copilotCalls).toHaveLength(1);
      expect(result.payload?.sourceToProjectVisualPlan).toMatchObject({
        skillInstall: {
          command: discoveredMise,
          args: ["exec", "--", "nub", "x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
          output: "visual-plan installed through discovered mise",
        },
        rawVisualPlan: "visual plan artifact",
      });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("researches the target project in relation to the objective and source findings", async () => {
    const copilotCalls: Array<{ prompt: string; model?: string; maxToolCalls?: number }> = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/kg",
      project: projectFixture(),
      mode: "advisory",
      copilot: {
        async run(args) {
          copilotCalls.push({ prompt: args.prompt, model: args.model, maxToolCalls: args.maxToolCalls });
          return "raw project research";
        },
      },
      baml: {
        async DistillProjectBrief() {
          return projectBriefFixture();
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!({
      id: "project-research",
      kind: "research",
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Research target project",
      prompt: "Research target project in relation to source findings: secondbrain",
      dependsOn: ["source-corroboration"],
      gates: ["output-contract"],
      writeMode: "read-only",
      replanPolicy: "never",
    }, {
      objective: "Read KG source for how it applies to Second Brain",
      payloads: new Map([
        ["source-reading", { sourceAnalysis: sourceAnalysisFixture() }],
        ["source-corroboration", { corroboration: corroborationFixture() }],
      ]),
      artifacts: new Map(),
    });

    expect(result.status).toBe("passed");
    expect(copilotCalls[0]).toMatchObject({ model: "claude-sonnet-5", maxToolCalls: 60 });
    expect(copilotCalls[0]?.prompt).toContain("Do not produce a generic repository overview");
    expect(copilotCalls[0]?.prompt).toContain("Hard budget: use at most 60 tool calls for target project research");
    expect(copilotCalls[0]?.prompt).toContain("Original objective:\nRead KG source for how it applies to Second Brain");
    expect(copilotCalls[0]?.prompt).toContain("Source analysis so far:");
    expect(copilotCalls[0]?.prompt).toContain("chunk, extract triples, standardize entities");
    expect(copilotCalls[0]?.prompt).toContain("Corroboration so far:");
    expect(copilotCalls[0]?.prompt).toContain("disqualifying evidence");
  });

  it("plans the source-core KG candidate instead of meta LLM adapter plumbing", async () => {
    const prompts: string[] = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/kg",
      project: projectFixture(),
      mode: "advisory",
      copilot: {
        async run(args) {
          prompts.push(args.prompt);
          return "raw plan";
        },
      },
      baml: {
        async DistillPlanArtifact() {
          return planSummaryFixture("KG pipeline plan");
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(planNode(), {
      payloads: new Map([
        ["project-research", { projectBrief: projectBriefFixture() }],
        ["council-review", { councilReview: mixedCouncilReviewFixture() }],
      ]),
      artifacts: new Map(),
    });

    expect(result.status).toBe("passed");
    expect(result.payload?.planSelection).toMatchObject({
      status: "selected",
      selectedCandidate: { id: "opp-1", kind: "opportunity", opportunityIds: ["opp-1"] },
    });
    expect(result.execution?.calls?.map((call) => call.model)).toEqual(["claude-opus-4.8", "gpt-5-mini"]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("selected source-to-project candidate");
    expect(prompts[0]).toContain("knowledge graph");
    expect(prompts[0]).not.toContain("LLM adapter layer");
  });

  it("does not call plan mode when only meta plumbing clears numeric scores", async () => {
    const prompts: string[] = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/kg",
      project: projectFixture(),
      mode: "advisory",
      copilot: {
        async run(args) {
          prompts.push(args.prompt);
          return "raw plan";
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(planNode(), {
      payloads: new Map([
        ["project-research", { projectBrief: projectBriefFixture() }],
        ["council-review", { councilReview: adapterOnlyCouncilReviewFixture() }],
      ]),
      artifacts: new Map(),
    });

    expect(result.status).toBe("passed");
    expect(result.output).toContain("No actionable source-to-project plan selected");
    expect(result.payload).toMatchObject({
      plans: [],
      planSelection: { status: "rejected" },
    });
    expect(prompts).toEqual([]);
  });

  it("accepts a final recommendation review through the typed BAML contract", async () => {
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/kg",
      originalPrompt: "Read https://example.com/kg for Second Brain",
      project: projectFixture(),
      mode: "advisory",
      baml: {
        async ReviewFinalRecommendation(originalPrompt, source, _sourceAnalysis, _corroboration, _projectBrief, plans) {
          expect(originalPrompt).toContain("Second Brain");
          expect(source).toBe("https://example.com/kg");
          expect(plans[0]?.recommendation).toContain("KG extraction");
          return {
            status: "accepted",
            actionable: true,
            improvesProject: true,
            unnecessaryComplexity: false,
            benefitOutweighsCost: true,
            complexityAssessment: "Small bounded plan.",
            rationale: "Actionable and useful.",
            rejectionReason: null,
            telegramSummary: "Accepted.",
          };
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(finalReviewNode(), {
      objective: "Fallback objective",
      payloads: new Map([
        ["source-reading", { sourceAnalysis: sourceAnalysisFixture() }],
        ["source-corroboration", { corroboration: corroborationFixture() }],
        ["project-research", { projectBrief: projectBriefFixture() }],
        ["plan-selected-opportunities", { plans: [planSummaryFixture("KG pipeline plan")] }],
      ]),
      artifacts: new Map(),
    });

    expect(result.status).toBe("passed");
    expect(result.payload?.finalRecommendationReview).toMatchObject({ status: "accepted" });
    expect(result.payload?.notification).toBeUndefined();
    expect(result.execution?.calls?.[0]).toMatchObject({ executor: "baml", operation: "ReviewFinalRecommendation" });
  });

  it("records rejected final recommendations and notifies through the injected notifier", async () => {
    const notifications: string[] = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/kg",
      project: { ...projectFixture(), notification: "telegram" },
      mode: "advisory",
      notifier: {
        async notifyRejection(args) {
          notifications.push(args.review.telegramSummary);
          return { channel: "telegram", status: "sent", message: args.review.telegramSummary };
        },
        async notifyElicitation(args) {
          return { channel: "telegram", status: "sent", message: args.question };
        },
      },
      baml: {
        async ReviewFinalRecommendation() {
          return {
            status: "rejected",
            actionable: false,
            improvesProject: false,
            unnecessaryComplexity: true,
            benefitOutweighsCost: false,
            complexityAssessment: "Too much new machinery for weak value.",
            rationale: "The plan is mostly infrastructure.",
            rejectionReason: "Benefit does not outweigh complexity.",
            telegramSummary: null,
          };
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(finalReviewNode(), {
      payloads: new Map([
        ["source-reading", { sourceAnalysis: sourceAnalysisFixture() }],
        ["source-corroboration", { corroboration: corroborationFixture() }],
        ["project-research", { projectBrief: projectBriefFixture() }],
        ["plan-selected-opportunities", { plans: [planSummaryFixture("Adapter plan")] }],
      ]),
      artifacts: new Map(),
    });

    expect(result.status).toBe("passed");
    expect(result.output).toContain("rejected");
    expect(result.payload).toMatchObject({
      finalRecommendationReview: {
        status: "rejected",
        rejectionReason: "Benefit does not outweigh complexity.",
        telegramSummary: "Benefit does not outweigh complexity.",
      },
      notification: {
        channel: "telegram",
        status: "sent",
        message: "Benefit does not outweigh complexity.",
      },
    });
    expect(notifications).toEqual(["Benefit does not outweigh complexity."]);
  });

  it("turns an empty plan selection into a final-review rejection without calling BAML", async () => {
    let bamlCalled = false;
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/kg",
      project: projectFixture(),
      mode: "advisory",
      baml: {
        async ReviewFinalRecommendation() {
          bamlCalled = true;
          throw new Error("should not call BAML");
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(finalReviewNode(), {
      payloads: new Map([
        ["source-reading", { sourceAnalysis: sourceAnalysisFixture() }],
        ["source-corroboration", { corroboration: corroborationFixture() }],
        ["project-research", { projectBrief: projectBriefFixture() }],
        ["plan-selected-opportunities", {
          plans: [],
          planSelection: {
            status: "rejected",
            reason: "No opportunity met the quality gate.",
            candidatesConsidered: [],
          },
        }],
      ]),
      artifacts: new Map(),
    });

    expect(bamlCalled).toBe(false);
    expect(result.payload?.finalRecommendationReview).toMatchObject({
      status: "rejected",
      rejectionReason: "No opportunity met the quality gate.",
    });
  });
});

function projectFixture() {
  return {
    id: "secondbrain",
    displayName: "Second Brain",
    workingTree: "/tmp/secondbrain",
    mainline: "origin main",
    remote: "origin",
    contextDocs: ["README.md", "AGENTS.md"],
    validationCommands: ["scripts/vault-health-check.sh"],
    autonomousPrAllowed: false,
    notification: "cli" as const,
    knowledgeExport: "off" as const,
  };
}

function projectBriefFixture() {
  return {
    projectId: "secondbrain",
    displayName: "Second Brain",
    architecture: "Obsidian markdown vault with Copilot CLI agent harness, source ingest, synthesized wiki pages, action review, and output artifacts.",
    constraints: ["Do not process restricted notes."],
    goals: ["Create navigable wiki synthesis from source material.", "Surface reviewable actions and briefings."],
    changeSurfaces: ["07-wiki", "08-actions", "09-outputs"],
    validationCommands: ["scripts/vault-health-check.sh"],
    risks: ["Sensitive content must stay local."],
    evidence: [{ id: "p1", source: "README.md", quote: "Copilot CLI is the supported agent harness." }],
  };
}

function sourceAnalysisFixture() {
  return {
    sourceId: "https://example.com/kg",
    title: "KG source",
    accessLevel: "public",
    summary: "A source about chunk, extract triples, standardize entities, infer relationships, and visualize a knowledge graph.",
    claims: ["The source extracts SPO triples."],
    transferableLessons: ["Use a chunk, extract triples, standardize entities pipeline."],
    evidence: [{ id: "s1", source: "README.md", quote: "knowledge graph" }],
  };
}

function corroborationFixture() {
  return {
    sourceId: "https://example.com/kg",
    corroboratedClaims: ["SPO extraction and visualization are supported."],
    disputedClaims: ["Endpoint compatibility is implementation-specific."],
    competingViews: ["Inferred relationships need human review."],
    citations: [{ id: "c1", source: "README.md", quote: "visualization" }],
  };
}

function planNode() {
  return {
    id: "plan-selected-opportunities",
    kind: "planning" as const,
    harness: WorkflowHarnessKind.COPILOT_SDK,
    title: "Plan selected opportunities",
    prompt: "Create plan artifacts for selected opportunities and bundles.",
    dependsOn: ["council-review"],
    gates: ["verification" as const],
    writeMode: "read-only" as const,
    replanPolicy: "never" as const,
  };
}

function finalReviewNode() {
  return {
    id: "final-recommendation-review",
    kind: "deliberation" as const,
    harness: WorkflowHarnessKind.COPILOT_SDK,
    title: "Review final recommendation",
    prompt: "Review final recommendations.",
    dependsOn: ["plan-selected-opportunities"],
    gates: ["review-accepted" as const],
    writeMode: "read-only" as const,
    replanPolicy: "never" as const,
  };
}

function planSummaryFixture(title: string) {
  return {
    opportunityIds: ["opp-1", "opp-4"],
    title,
    recommendation: "Build a KG extraction pipeline for readable vault notes.",
    problemSolved: "The vault lacks a structured relationship artifact for synthesized knowledge.",
    sourceLessonApplied: "Chunk, extract triples, standardize entities, infer relationships, and visualize.",
    targetChange: "Add a read-only KG artifact generator for non-restricted notes.",
    expectedUserValue: "Maintainers can inspect relationships and candidate wiki updates.",
    implementationOutline: ["Extract triples", "Standardize entities", "Write review artifacts"],
    scope: "KG artifacts and review output only.",
    filesLikelyTouched: ["07-wiki", "08-actions", "09-outputs"],
    validationCommands: ["scripts/vault-health-check.sh"],
    risks: ["Hallucinated inferred relations."],
    rawPlanArtifactPath: "inline",
  };
}

function acceptedFinalRecommendationReviewFixture() {
  return {
    status: "accepted" as const,
    actionable: true,
    improvesProject: true,
    unnecessaryComplexity: false,
    benefitOutweighsCost: true,
    complexityAssessment: "Small bounded plan.",
    rationale: "Actionable and useful.",
    rejectionReason: null,
    telegramSummary: "Accepted.",
  };
}

function mixedCouncilReviewFixture() {
  return {
    opportunities: [
      {
        id: "opp-1",
        title: "Add source-to-wiki knowledge graph artifacts",
        lesson: "A practical pipeline pattern: chunk, extract SPO triples, standardize entities, infer, visualize.",
        projectChange: "Create a knowledge graph artifact from readable vault notes and link reviewable summaries into 07-wiki.",
        changeSurface: "07-wiki, 08-actions, 09-outputs",
        score: { applicability: 0.9, impact: 0.9, confidence: 0.82, implementationCost: 0.6, risk: 0.35 },
        evidence: [{ id: "e1", source: "README.md", quote: "knowledge graph" }],
        speculative: false,
      },
      {
        id: "opp-4",
        title: "Add entity deduplication review",
        lesson: "Combine rule-based entity standardization with optional LLM inference.",
        projectChange: "Write candidate entity merges to review notes before mutating wiki pages.",
        changeSurface: "08-actions, 09-outputs",
        score: { applicability: 0.9, impact: 0.82, confidence: 0.8, implementationCost: 0.5, risk: 0.25 },
        evidence: [{ id: "e2", source: "entity_standardization.py", quote: "standardize" }],
        speculative: false,
      },
      adapterOpportunityFixture(),
    ],
    nonApplicableLessons: [],
    bundles: [
      {
        id: "bundle-A",
        opportunityIds: ["opp-1", "opp-4"],
        rationale: "Build the knowledge graph pipeline and entity review together.",
        sharedChangeSurface: "source ingest, 07-wiki, 08-actions, 09-outputs",
        combinedUserValue: "A navigable knowledge graph with human-reviewed entity cleanup.",
        separationRisk: "Separate output formats could drift.",
        maxPrScope: "Add a knowledge graph artifact generator with review notes and validation.",
      },
      {
        id: "bundle-B",
        opportunityIds: ["opp-3"],
        rationale: "LLM adapter safety plumbing.",
        sharedChangeSurface: "LLM client module",
        combinedUserValue: "OpenAI-compatible endpoint flexibility.",
        separationRisk: "Endpoint response shapes may differ.",
        maxPrScope: "Add an LLM adapter layer and local-only flags.",
      },
    ],
    rankingRationale: "Adapter first, incorrectly.",
  };
}

function adapterOnlyCouncilReviewFixture() {
  return {
    opportunities: [adapterOpportunityFixture()],
    nonApplicableLessons: [],
    bundles: [],
    rankingRationale: "Only adapter work was found.",
  };
}

function adapterOpportunityFixture() {
  return {
    id: "opp-3",
    title: "LLM adapter layer",
    lesson: "Works with any OpenAI-compatible endpoint.",
    projectChange: "Implement an LLM adapter layer, response-shape parsing, local-only flags, and raw LLM logging.",
    changeSurface: "00-system LLM client plumbing",
    score: { applicability: 0.95, impact: 0.8, confidence: 0.9, implementationCost: 0.45, risk: 0.25 },
    evidence: [{ id: "e3", source: "llm.py", quote: "OpenAI-compatible endpoint" }],
    speculative: false,
  };
}

function latestRunCouncilReviewFixture() {
  const evidence = [{ id: "e1", source: "CONTEXT.md", quote: "loop" }];
  return {
    opportunities: [
      {
        id: "opp-1",
        title: "Add a conservative loop-engineering-starter advisory template",
        lesson: "Start with advisory loop templates.",
        projectChange: "Add a bounded advisory workflow template.",
        changeSurface: "workflow templates",
        score: { applicability: 0.95, impact: 0.7, confidence: 0.9, implementationCost: 0.3, risk: 0.2 },
        evidence,
        speculative: false,
      },
      {
        id: "opp-2",
        title: "Provide harness adapters for cost estimation",
        lesson: "Estimate loop costs.",
        projectChange: "Add cost estimation harness adapters.",
        changeSurface: "harnesses",
        score: { applicability: 0.9, impact: 0.85, confidence: 0.8, implementationCost: 0.5, risk: 0.3 },
        evidence,
        speculative: true,
      },
      {
        id: "opp-3",
        title: "Extend runner to record cost and telemetry",
        lesson: "Record budgets for loops.",
        projectChange: "Record cost telemetry and safe throttling budgets.",
        changeSurface: "runner",
        score: { applicability: 0.95, impact: 0.9, confidence: 0.85, implementationCost: 0.6, risk: 0.5 },
        evidence,
        speculative: false,
      },
      {
        id: "opp-4",
        title: "Add automated verifier rules for budgets",
        lesson: "Verify budget boundaries.",
        projectChange: "Add verifier rules for cost, iteration, and verification budgets.",
        changeSurface: "verifier",
        score: { applicability: 0.9, impact: 0.9, confidence: 0.8, implementationCost: 0.45, risk: 0.35 },
        evidence,
        speculative: false,
      },
      {
        id: "opp-5",
        title: "Ship starter checklists",
        lesson: "Document loop scenarios.",
        projectChange: "Add starter checklists and audit readiness docs.",
        changeSurface: "docs",
        score: { applicability: 0.85, impact: 0.6, confidence: 0.8, implementationCost: 0.3, risk: 0.1 },
        evidence,
        speculative: false,
      },
      {
        id: "opp-6",
        title: "Ensure snapshot-friendly replan boundaries",
        lesson: "Snapshot loops for replay.",
        projectChange: "Add snapshot-friendly replan boundaries and audit trails.",
        changeSurface: "replay",
        score: { applicability: 0.88, impact: 0.75, confidence: 0.75, implementationCost: 0.55, risk: 0.25 },
        evidence,
        speculative: false,
      },
    ],
    nonApplicableLessons: [],
    bundles: [],
    rankingRationale: "Ranked by source fit and impact.",
  };
}
