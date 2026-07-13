import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  BudgetGateBlockedError,
  evaluateBudgetGate,
} from "../../../src/macro-workflow/budgetGate.js";
import type { WorkflowExecutionContext } from "../../../src/macro-workflow/harness.js";
import {
  type RuntimeWorkflowNode,
  WorkflowGateKind,
  WorkflowHarnessKind,
  WorkflowNodeKind,
} from "../../../src/macro-workflow/types.js";
import { runMacroWorkflow } from "../../../src/macro-workflow/runner.js";
import { materializeWorkflowPlan } from "../../../src/macro-workflow/templates.js";
import type { OpportunityCouncilReview } from "../../../src/generated/baml_client/index.js";
import type { CouncilDeliberationResult } from "../../../src/macro-workflow/sourceToProject/councilDeliberation.js";
import {
  createCopilotSdkHarnessClient,
  createSourceToProjectUserInputRequestHandler,
  createSourceToProjectDynamicExpander,
  createSourceToProjectHarnessRegistry,
  resolveCopilotCliPathFromSdkModuleUrl,
  selectAcceptedOpportunities,
  stripPlanningAgentPreamble,
} from "../../../src/macro-workflow/sourceToProject/harnesses.js";
import {
  compilePracticeLedger,
  requiredCoverage,
} from "../../../src/macro-workflow/sourceToProject/portfolioCompiler.js";

const HOSTED_VISUAL_PLAN_ARTIFACT =
  "Published visual-plan MDX artifact: https://plan.agent-native.com/builder/o5-visual-plan";
const HOSTED_VISUAL_PLAN_ARTIFACT_URL = "https://plan.agent-native.com/builder/o5-visual-plan";

describe("source-to-project harness registry", () => {
  afterEach(() => {
    delete process.env.BAML_MODEL;
  });

  it("distills source reading output into typed payload", async () => {
    process.env.BAML_MODEL = "baml-distill-model";
    const copilotCalls: Array<{
      prompt: string;
      maxToolCalls?: number;
      capabilityScope?: unknown;
    }> = [];
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
      sourceToProject: {
        maxOpportunities: 1,
        thresholds: {
          minApplicability: 0.7,
          minConfidence: 0.65,
          minImpact: 0.5,
          minAcceptanceAverage: 0.85,
          maxRisk: 0.8,
        },
        mode: "advisory",
        offline: false,
        copilotModel: "copilot-research-model",
        prLauncher: {
          provider: "herdr",
          agentCommand: "codex",
          agentArgs: [],
          split: "right",
          agentOptions: [],
        },
        autoImplementOnReport: false,
      },
      copilot: {
        async run(args) {
          copilotCalls.push({
            prompt: args.prompt,
            maxToolCalls: args.maxToolCalls,
            capabilityScope: args.capabilityScope,
          });
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
            practiceLedger: {
              sourceId: "source-1",
              summary: "Summary",
              claims: ["Claim"],
              evidence: [{ id: "e1", source: "https://example.com/post", quote: "Claim" }],
              practices: [
                {
                  id: "boundary-validation",
                  title: "Boundary validation",
                  behavior: "Validate input at ingress.",
                  rationale: "Reject malformed input early.",
                  adoptionPreconditions: ["The project has an ingress boundary."],
                  requiredBehaviors: ["Validate route input"],
                  proofObligations: ["Exercise the real adapter"],
                  evidence: [{ id: "e1", source: "https://example.com/post", quote: "Claim" }],
                },
              ],
            },
          };
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
        id: "source-reading",
        kind: "research",
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Read source",
        prompt: "Read",
        dependsOn: [],
        gates: ["output-contract"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      { payloads: new Map(), artifacts: new Map() },
    );

    expect(result.status).toBe("passed");
    expect(result.payload?.sourceAnalysis).toMatchObject({ sourceId: "source-1", title: "Post" });
    expect(result.payload?.practiceLedger).toMatchObject({
      sourceId: "source-1",
      practices: [
        {
          id: "practice-boundary-validation",
          behaviorIds: ["practice-boundary-validation/behavior-1"],
          proofIds: ["practice-boundary-validation/proof-1"],
        },
      ],
    });
    expect(copilotCalls[0]?.prompt).toContain("Read the Source artifact");
    expect(copilotCalls[0]?.prompt).toContain("Hard budget: use at most 40 tool calls");
    expect(copilotCalls[0]?.prompt).toContain("Source: https://example.com/post");
    expect(copilotCalls[0]?.maxToolCalls).toBe(40);
    expect(copilotCalls[0]?.capabilityScope).toBeUndefined();
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
    const sessionConfigs: Array<Record<string, unknown>> = [];
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
        sessionConfigs.push(record);
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

    const result = await copilot.run({
      cwd: "/tmp/project",
      prompt: "Research project",
      mode: "research",
    });

    expect(copilot.model).toBe("gpt-test");
    expect(result).toBe("live response");
    expect(calls).toEqual([
      "start",
      "session:gpt-test:/tmp/project",
      "send:Research project",
      "disconnect",
      "stop",
    ]);
    expect(sessionConfigs[0]?.pluginDirectories).toBeUndefined();
  });

  it("scopes a Copilot SDK run to a plugin command capability", async () => {
    const messages: string[] = [];
    const sessionConfigs: Array<Record<string, unknown>> = [];
    const session = {
      async sendAndWait(message: { prompt: string }) {
        messages.push(message.prompt);
        return { data: { content: "scoped response" } };
      },
      async disconnect() {},
    };
    const client = {
      async start() {},
      async createSession(config: unknown) {
        sessionConfigs.push(config as Record<string, unknown>);
        return session;
      },
      async stop() {
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({
      model: "gpt-test",
      clientFactory: () => client,
    });

    const result = await copilot.run({
      cwd: "/tmp/project",
      prompt: "Research project\nUse source evidence.",
      mode: "research",
      capabilityScope: {
        kind: "plugin-command",
        pluginDirectory: "/plugins/hve-core",
        command: "hve-core:task-research",
        promptInputName: "topic",
        commandArgs: { subagents: "auto" },
      },
    });

    expect(result).toBe("scoped response");
    expect(sessionConfigs[0]).toMatchObject({
      model: "gpt-test",
      cwd: "/tmp/project",
      pluginDirectories: ["/plugins/hve-core"],
    });
    expect(messages).toEqual([
      '/hve-core:task-research topic="Research project\\nUse source evidence." subagents=auto',
    ]);
  });

  it("loads and enables a skill-scoped Copilot SDK run before sending the prompt", async () => {
    const calls: string[] = [];
    const sessionConfigs: Array<Record<string, unknown>> = [];
    const session = {
      rpc: {
        skills: {
          async ensureLoaded() {
            calls.push("skills.ensureLoaded");
          },
          async reload() {
            calls.push("skills.reload");
            return { warnings: [], errors: [] };
          },
          async enable(args: { name: string }) {
            calls.push(`skills.enable:${args.name}`);
          },
          async list() {
            calls.push("skills.list");
            return { skills: [{ name: "visual-plan", enabled: true }] };
          },
        },
      },
      async sendAndWait(message: { prompt: string }) {
        calls.push(`send:${message.prompt}`);
        return { data: { content: "skill response" } };
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
        sessionConfigs.push(config as Record<string, unknown>);
        calls.push("session");
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

    const result = await copilot.run({
      cwd: "/tmp/project",
      prompt: "Create a local plan.",
      mode: "plan",
      capabilityScope: {
        kind: "skill",
        skillName: "visual-plan",
        skillDirectories: ["/skills"],
        disabledSkills: ["other-skill"],
      },
    });

    expect(result).toBe("skill response");
    expect(sessionConfigs[0]).toMatchObject({
      model: "gpt-test",
      cwd: "/tmp/project",
      skillDirectories: ["/skills"],
      disabledSkills: ["other-skill"],
      enableSkills: true,
    });
    expect(calls).toEqual([
      "start",
      "session",
      "skills.ensureLoaded",
      "skills.reload",
      "skills.enable:visual-plan",
      "skills.list",
      "send:/visual-plan Create a local plan.",
      "disconnect",
      "stop",
    ]);
  });

  it("emits Copilot SDK lifecycle errors thrown before a session exists", async () => {
    const logs: Array<{ phase: string; message?: string }> = [];
    const copilot = createCopilotSdkHarnessClient({
      model: "gpt-test",
      clientFactory: () => {
        throw new Error("client factory failed");
      },
      onLog(event) {
        logs.push({ phase: event.phase, message: event.message });
      },
    });

    await expect(
      copilot.run({
        cwd: "/tmp/project",
        prompt: "Research project",
        mode: "research",
      }),
    ).rejects.toThrow("client factory failed");

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "session-error",
          message: expect.stringContaining("client factory failed"),
        }),
      ]),
    );
  });

  it("emits Copilot SDK skill reload warnings before sending a skill-scoped prompt", async () => {
    const logs: Array<{ phase: string; message?: string; skillName?: string }> = [];
    const session = {
      rpc: {
        skills: {
          async ensureLoaded() {},
          async reload() {
            return { warnings: ["auth pending"], errors: [] };
          },
          async enable() {},
          async list() {
            return { skills: [{ name: "visual-plan", enabled: true }] };
          },
        },
      },
      async sendAndWait() {
        return { data: { content: "skill response" } };
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
      model: "gpt-test",
      clientFactory: () => client,
      onLog(event) {
        logs.push({ phase: event.phase, message: event.message, skillName: event.skillName });
      },
    });

    await expect(
      copilot.run({
        cwd: "/tmp/project",
        prompt: "Create a local plan.",
        mode: "plan",
        capabilityScope: {
          kind: "skill",
          skillName: "visual-plan",
          skillDirectories: ["/skills"],
        },
      }),
    ).resolves.toBe("skill response");

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "skills-warning",
          skillName: "visual-plan",
          message: "auth pending",
        }),
      ]),
    );
  });

  it("denies foreground visual-plan local serve commands so SDK runs do not hang", async () => {
    const decisions: unknown[] = [];
    const session = {
      rpc: {
        skills: {
          async ensureLoaded() {},
          async reload() {
            return { warnings: [], errors: [] };
          },
          async enable() {},
          async list() {
            return { skills: [{ name: "visual-plan", enabled: true }] };
          },
        },
      },
      async sendAndWait() {
        return { data: { content: "skill response" } };
      },
      async disconnect() {},
    };
    const client = {
      async start() {},
      async createSession(config: unknown) {
        const hook = (
          config as {
            hooks?: {
              onPreToolUse?: (input: { toolName?: string; toolArgs?: unknown }) => unknown;
            };
          }
        ).hooks?.onPreToolUse;
        decisions.push(
          hook?.({
            toolName: "shell",
            toolArgs: {
              command:
                "nubx @agent-native/core@latest plan local serve --dir plans/o3 --kind plan --open 2>&1 | tail -30",
            },
          }),
        );
        decisions.push(
          hook?.({
            toolName: "shell",
            toolArgs: {
              command:
                "nohup nubx @agent-native/core@latest plan local serve --dir plans/o3 --kind plan --open > /tmp/o3.log 2>&1 &",
            },
          }),
        );
        return session;
      },
      async stop() {
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({
      model: "gpt-test",
      clientFactory: () => client,
    });

    await expect(
      copilot.run({
        cwd: "/tmp/project",
        prompt: "/visual-plan Create a local plan.",
        mode: "plan",
        capabilityScope: {
          kind: "skill",
          skillName: "visual-plan",
          skillDirectories: ["/skills"],
        },
      }),
    ).resolves.toBe("skill response");

    expect(decisions[0]).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("keeps the tool call open"),
    });
    expect(decisions[1]).toBeUndefined();
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

  it("resolves the Copilot CLI binary from a Nub SDK package layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-copilot-cli-layout-"));
    try {
      const platformPackage =
        process.platform === "linux"
          ? `@github+copilot-linux-${process.arch}@1.0.65-b`
          : `@github+copilot-${process.platform}-${process.arch}@1.0.65-b`;
      const platformPackageName =
        process.platform === "linux"
          ? `copilot-linux-${process.arch}`
          : `copilot-${process.platform}-${process.arch}`;
      const sdkIndex = join(
        root,
        "node_modules",
        ".nub",
        "@github+copilot-sdk@1.0.4-a",
        "node_modules",
        "@github",
        "copilot-sdk",
        "dist",
        "index.js",
      );
      const copilotCli = join(
        root,
        "node_modules",
        ".nub",
        platformPackage,
        "node_modules",
        "@github",
        platformPackageName,
        "index.js",
      );
      await mkdir(dirname(sdkIndex), { recursive: true });
      await mkdir(dirname(copilotCli), { recursive: true });
      await writeFile(sdkIndex, "");
      await writeFile(copilotCli, "#!/usr/bin/env node\n");

      expect(resolveCopilotCliPathFromSdkModuleUrl(pathToFileURL(sdkIndex).href)).toBe(copilotCli);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    const copilot = createCopilotSdkHarnessClient({
      model: "gpt-default",
      clientFactory: () => client,
    });

    await copilot.run({ prompt: "Implement", mode: "implement", model: "gpt-5.3-codex" });

    expect(models).toEqual(["gpt-5.3-codex"]);
  });

  it("uses source-to-project config timeout for Copilot SDK calls", async () => {
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
    const copilot = createCopilotSdkHarnessClient({
      clientFactory: () => client,
      sourceToProject: {
        maxOpportunities: 1,
        thresholds: {
          minApplicability: 0.7,
          minConfidence: 0.65,
          minImpact: 0.5,
          minAcceptanceAverage: 0.85,
          maxRisk: 0.8,
        },
        mode: "advisory",
        offline: false,
        timeoutMs: 600000,
        prLauncher: {
          provider: "herdr",
          agentCommand: "codex",
          agentArgs: [],
          split: "right",
          agentOptions: [],
        },
        autoImplementOnReport: false,
      },
    });

    await copilot.run({ prompt: "Corroborate source", mode: "research" });

    expect(timeouts).toEqual([600000]);
  });

  it("uses source-reading max tool calls from source-to-project config", async () => {
    const maxToolCalls: Array<number | undefined> = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/post",
      project: projectFixture(),
      mode: "advisory",
      sourceToProject: {
        maxOpportunities: 1,
        thresholds: {
          minApplicability: 0.7,
          minConfidence: 0.65,
          minImpact: 0.5,
          minAcceptanceAverage: 0.85,
          maxRisk: 0.8,
        },
        mode: "advisory",
        offline: false,
        sourceReadingMaxToolCalls: 12,
        prLauncher: {
          provider: "herdr",
          agentCommand: "codex",
          agentArgs: [],
          split: "right",
          agentOptions: [],
        },
        autoImplementOnReport: false,
      },
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

    await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
        id: "source-reading",
        kind: "research",
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Read source",
        prompt: "Read",
        dependsOn: [],
        gates: ["output-contract"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      { payloads: new Map(), artifacts: new Map() },
    );

    expect(maxToolCalls).toEqual([12]);
  });

  it("passes prefetched X post markdown into source reading as the primary source artifact", async () => {
    const prompts: string[] = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://x.com/alice/status/12345",
      prefetchedSourceContent: "# Alice Post\n\nFetched source body.",
      project: projectFixture(),
      mode: "advisory",
      copilot: {
        async run(args) {
          prompts.push(args.prompt);
          return "raw source research";
        },
      },
      baml: {
        async DistillSourceAnalysis() {
          return sourceAnalysisFixture();
        },
      },
    });

    await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
        id: "source-reading",
        kind: "research",
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Read source",
        prompt: "Read",
        dependsOn: [],
        gates: ["output-contract"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      { payloads: new Map(), artifacts: new Map() },
    );

    expect(prompts[0]).toContain(
      "Use the prefetched X post markdown below as the primary Source artifact.",
    );
    expect(prompts[0]).toContain("Source URL: https://x.com/alice/status/12345");
    expect(prompts[0]).toContain("# Alice Post\n\nFetched source body.");
  });

  it("uses project-research max tool calls from source-to-project config", async () => {
    const maxToolCalls: Array<number | undefined> = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/post",
      project: projectFixture(),
      mode: "advisory",
      sourceToProject: {
        maxOpportunities: 1,
        thresholds: {
          minApplicability: 0.7,
          minConfidence: 0.65,
          minImpact: 0.5,
          minAcceptanceAverage: 0.85,
          maxRisk: 0.8,
        },
        mode: "advisory",
        offline: false,
        projectResearchMaxToolCalls: 24,
        prLauncher: {
          provider: "herdr",
          agentCommand: "codex",
          agentArgs: [],
          split: "right",
          agentOptions: [],
        },
        autoImplementOnReport: false,
      },
      copilot: {
        async run(args) {
          maxToolCalls.push(args.maxToolCalls);
          return "raw project research";
        },
      },
      baml: {
        async DistillProjectApplicability() {
          return applicabilityMatrixFixture();
        },
      },
    });

    await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
        id: "project-research",
        kind: "research",
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Research target project",
        prompt: "Research",
        dependsOn: ["source-corroboration"],
        gates: ["output-contract"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        payloads: new Map([
          [
            "source-reading",
            { sourceAnalysis: sourceAnalysisFixture(), practiceLedger: practiceLedgerFixture() },
          ],
        ]),
        artifacts: new Map(),
        objective: "Apply source",
      },
    );

    expect(maxToolCalls).toEqual([24]);
  });

  it("scopes project-research through its declared HVE task-research plugin command", async () => {
    const copilotCalls: Array<{ prompt: string; capabilityScope?: unknown }> = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/post",
      project: projectFixture(),
      mode: "advisory",
      plugins: {
        "hve-core": {
          directory: "/plugins/hve-core",
        },
      },
      copilot: {
        async run(args) {
          copilotCalls.push({ prompt: args.prompt, capabilityScope: args.capabilityScope });
          return "raw project research";
        },
      },
      baml: {
        async DistillProjectApplicability() {
          return applicabilityMatrixFixture();
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
        id: "project-research",
        kind: "research",
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Research target project",
        prompt: "Research",
        capabilities: {
          pluginCommands: [
            {
              plugin: "hve-core",
              command: "hve-core:task-research",
              promptInputName: "topic",
              args: { chat: "false", subagents: "false" },
            },
          ],
        },
        dependsOn: ["source-corroboration"],
        gates: ["output-contract"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        payloads: new Map([
          [
            "source-reading",
            { sourceAnalysis: sourceAnalysisFixture(), practiceLedger: practiceLedgerFixture() },
          ],
        ]),
        artifacts: new Map(),
        objective: "Apply source",
      },
    );

    expect(copilotCalls[0]?.capabilityScope).toEqual({
      kind: "plugin-command",
      pluginDirectory: "/plugins/hve-core",
      command: "hve-core:task-research",
      promptInputName: "topic",
      commandArgs: { chat: "false", subagents: "false" },
    });
    expect(result.execution?.calls?.[0]).toMatchObject({
      executor: "copilot-sdk",
      mode: "research",
      capabilityScope: "plugin-command:hve-core:task-research",
    });
    expect(result.execution?.calls?.[0]?.prompt).toContain("/hve-core:task-research topic=");
  });

  it("uses read-only tools for direct project-research without capability metadata", async () => {
    const copilotCalls: Array<{ capabilityScope?: unknown; toolPolicy?: unknown }> = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/post",
      project: projectFixture(),
      mode: "advisory",
      copilot: {
        async run(args) {
          copilotCalls.push({
            capabilityScope: args.capabilityScope,
            toolPolicy: args.toolPolicy,
          });
          return "raw project research";
        },
      },
      baml: {
        async DistillProjectApplicability() {
          return applicabilityMatrixFixture();
        },
      },
    });

    await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
        id: "project-research",
        kind: "research",
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Research target project",
        prompt: "Research",
        dependsOn: ["source-corroboration"],
        gates: ["output-contract"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        payloads: new Map([
          [
            "source-reading",
            { sourceAnalysis: sourceAnalysisFixture(), practiceLedger: practiceLedgerFixture() },
          ],
        ]),
        artifacts: new Map(),
        objective: "Apply source",
      },
    );

    expect(copilotCalls[0]?.capabilityScope).toBeUndefined();
    expect(copilotCalls[0]?.toolPolicy).toBe("read-only");
  });

  it("denies mutating Copilot SDK tools under the read-only policy", async () => {
    const decisions: unknown[] = [];
    const client = {
      async start() {},
      async createSession(config: unknown) {
        const hook = (
          config as {
            hooks?: { onPreToolUse?: (input: { toolName?: string }) => unknown };
          }
        ).hooks?.onPreToolUse;
        decisions.push(hook?.({ toolName: "view" }));
        decisions.push(hook?.({ toolName: "rg" }));
        decisions.push(hook?.({ toolName: "shell" }));
        decisions.push(hook?.({ toolName: "edit" }));
        return {
          async sendAndWait() {
            return { data: { content: "read-only response" } };
          },
          async disconnect() {},
        };
      },
      async stop() {
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({ clientFactory: () => client });

    await expect(
      copilot.run({ prompt: "Inspect project", mode: "research", toolPolicy: "read-only" }),
    ).resolves.toBe("read-only response");

    expect(decisions.slice(0, 2)).toEqual([undefined, undefined]);
    expect(decisions.slice(2)).toEqual([
      expect.objectContaining({
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("read-only"),
      }),
      expect.objectContaining({
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("read-only"),
      }),
    ]);
  });

  it("denies Copilot SDK tool calls after the configured tool-call budget", async () => {
    const logs: Array<{
      phase: string;
      toolCallCount?: number;
      maxToolCalls?: number;
      toolName?: string;
    }> = [];
    const decisions: unknown[] = [];
    const client = {
      async start() {},
      async createSession(config: unknown) {
        const hook = (
          config as {
            hooks?: { onPreToolUse?: (input: { toolName?: string }) => unknown };
          }
        ).hooks?.onPreToolUse;
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

    await expect(copilot.run({ prompt: "Read source", mode: "research" })).resolves.toBe(
      "live response",
    );

    expect(decisions.slice(0, 2)).toEqual([undefined, undefined]);
    expect(decisions[2]).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("2-tool research budget"),
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "tool-budget",
          toolName: "glob",
          toolCallCount: 3,
          maxToolCalls: 2,
        }),
      ]),
    );
  });

  it("uses the last assistant message when the SDK never emits session idle", async () => {
    const logs: Array<{
      phase: string;
      eventType?: string;
      contentLength?: number;
      timeoutMs?: number;
    }> = [];
    const session = {
      handlers: [] as Array<(event: { type: string; data?: { content?: string } }) => void>,
      async send(message: { prompt: string }) {
        queueMicrotask(() => {
          for (const handler of this.handlers) {
            handler({
              type: "assistant.message",
              data: { content: `partial for ${message.prompt}` },
            });
          }
        });
        return "message-1";
      },
      on(_eventHandler: unknown, maybeHandler?: unknown) {
        const handler = typeof maybeHandler === "function" ? maybeHandler : _eventHandler;
        this.handlers.push(
          handler as (event: { type: string; data?: { content?: string } }) => void,
        );
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

    await expect(copilot.run({ prompt: "Read source", mode: "research" })).resolves.toBe(
      "partial for Read source",
    );
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

  it("rejects the last assistant message on timeout when partial fallback is disabled", async () => {
    const logs: Array<{
      phase: string;
      contentLength?: number;
      elapsedMs?: number;
      timeoutMs?: number;
    }> = [];
    const session = {
      handlers: [] as Array<(event: { type: string; data?: { content?: string } }) => void>,
      async send(message: { prompt: string }) {
        queueMicrotask(() => {
          for (const handler of this.handlers) {
            handler({
              type: "assistant.message",
              data: { content: `partial for ${message.prompt}` },
            });
          }
        });
        return "message-1";
      },
      on(_eventHandler: unknown, maybeHandler?: unknown) {
        const handler = typeof maybeHandler === "function" ? maybeHandler : _eventHandler;
        this.handlers.push(
          handler as (event: { type: string; data?: { content?: string } }) => void,
        );
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
          contentLength: event.contentLength,
          elapsedMs: event.elapsedMs,
          timeoutMs: event.timeoutMs,
        });
      },
    });
    const prompt = "Plan portfolio";

    await expect(
      copilot.run({
        prompt,
        mode: "plan",
        acceptPartialOnTimeout: false,
      }),
    ).rejects.toThrow("Timeout after 10ms waiting for session.idle");
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "timeout-rejected-partial",
          timeoutMs: 10,
          contentLength: `partial for ${prompt}`.length,
          elapsedMs: expect.any(Number),
        }),
      ]),
    );
  });

  it("suppresses raw Copilot SDK session-event logs by default", async () => {
    const logs: Array<{ phase: string; eventType?: string; contentLength?: number }> = [];
    const session = {
      handlers: [] as Array<
        (event: { type: string; data?: { content?: string; toolName?: string } }) => void
      >,
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
        this.handlers.push(
          handler as (event: {
            type: string;
            data?: { content?: string; toolName?: string };
          }) => void,
        );
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

    await expect(copilot.run({ prompt: "Read source", mode: "research" })).resolves.toBe(
      "final answer",
    );
    expect(logs.some((log) => log.phase === "session-event")).toBe(false);
    expect(logs.map((log) => log.eventType)).not.toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(logs).toEqual(
      expect.arrayContaining([expect.objectContaining({ phase: "session-idle" })]),
    );
    expect(logs.some((log) => log.phase === "assistant-message")).toBe(false);
  });

  it("emits raw Copilot SDK session-event logs when verbose events are enabled", async () => {
    const logs: Array<{ eventType?: string }> = [];
    const session = {
      handlers: [] as Array<
        (event: { type: string; data?: { content?: string; toolName?: string } }) => void
      >,
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
        this.handlers.push(
          handler as (event: {
            type: string;
            data?: { content?: string; toolName?: string };
          }) => void,
        );
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

    await expect(copilot.run({ prompt: "Read source", mode: "research" })).resolves.toBe(
      "final answer",
    );
    expect(logs.map((log) => log.eventType)).toEqual(
      expect.arrayContaining([
        "tool.execution_start",
        "hook.start",
        "permission.requested",
        "assistant.streaming_delta",
        "assistant.message_delta",
        "assistant.message",
        "tool.execution_complete",
        "session.idle",
      ]),
    );
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
        this.handlers.push(
          handler as (event: { type: string; data?: Record<string, unknown> }) => void,
        );
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

    await expect(
      copilot.run({
        prompt: "Read source",
        mode: "research",
        operation: "source-reading",
      }),
    ).resolves.toBe("final answer");

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
        const handler = (
          config as {
            onUserInputRequest?: (request: { question: string }) => Promise<unknown>;
          }
        ).onUserInputRequest;
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

  it("restricts Copilot SDK review sessions to read-only permission requests", async () => {
    type PermissionHandler = (
      request: PermissionRequest,
      invocation: { sessionId: string },
    ) => Promise<PermissionRequestResult> | PermissionRequestResult;
    let onPermissionRequest: PermissionHandler | undefined;
    const client = {
      async start() {},
      async createSession(config: unknown) {
        onPermissionRequest = (config as { onPermissionRequest?: PermissionHandler })
          .onPermissionRequest;
        return {
          async sendAndWait() {
            return { data: { content: "review complete" } };
          },
          async disconnect() {},
        };
      },
      async stop() {
        return undefined;
      },
    };
    const copilot = createCopilotSdkHarnessClient({ clientFactory: () => client });

    await expect(copilot.run({ prompt: "Review implementation", mode: "review" })).resolves.toBe(
      "review complete",
    );
    expect(onPermissionRequest).toBeDefined();

    const decide = (request: PermissionRequest) =>
      Promise.resolve(onPermissionRequest!(request, { sessionId: "review-session" }));
    await expect(
      decide({
        kind: "write",
        canOfferSessionApproval: false,
        diff: "+ unsafe change",
        fileName: "src/index.ts",
        intention: "Modify production code",
      }),
    ).resolves.toMatchObject({ kind: "reject" });
    await expect(
      decide({ kind: "read", path: "src/index.ts", intention: "Inspect production code" }),
    ).resolves.toEqual({ kind: "approve-once" });
    await expect(
      decide({
        kind: "shell",
        canOfferSessionApproval: false,
        commands: [{ identifier: "rg", readOnly: true }],
        fullCommandText: "rg TODO src",
        hasWriteFileRedirection: false,
        intention: "Search production code",
        possiblePaths: ["src"],
        possibleUrls: [],
      }),
    ).resolves.toEqual({ kind: "approve-once" });
    await expect(
      decide({
        kind: "shell",
        canOfferSessionApproval: false,
        commands: [],
        fullCommandText: "unclassified-shell-command",
        hasWriteFileRedirection: false,
        intention: "Run an unclassified shell command",
        possiblePaths: [],
        possibleUrls: [],
      }),
    ).resolves.toMatchObject({ kind: "reject" });
    await expect(
      decide({
        kind: "shell",
        canOfferSessionApproval: false,
        commands: [{ identifier: "sed", readOnly: true }],
        fullCommandText: "sed -n '1,5p' src/index.ts > /tmp/excerpt",
        hasWriteFileRedirection: true,
        intention: "Write a command result",
        possiblePaths: ["src/index.ts", "/tmp/excerpt"],
        possibleUrls: [],
      }),
    ).resolves.toMatchObject({ kind: "reject" });
    await expect(
      decide({
        kind: "mcp",
        readOnly: true,
        serverName: "codebase-memory",
        toolName: "search_graph",
        toolTitle: "Search graph",
      }),
    ).resolves.toEqual({ kind: "approve-once" });
    await expect(
      decide({
        kind: "mcp",
        readOnly: false,
        serverName: "github",
        toolName: "create_pull_request",
        toolTitle: "Create pull request",
      }),
    ).resolves.toMatchObject({ kind: "reject" });
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

    expect(
      acceptances.filter((acceptance) => acceptance.accepted).map((acceptance) => acceptance.id),
    ).toEqual(["opp-1", "opp-3", "opp-4"]);
    expect(acceptances.find((acceptance) => acceptance.id === "opp-2")?.reason).toContain(
      "speculative",
    );
  });

  it("promotes the minimum opportunity set that preserves required behavior coverage", async () => {
    const fixture = latestRunCouncilReviewFixture();
    const requiredOpportunities = fixture.opportunities.slice(0, 2).map((opportunity, index) => ({
      ...opportunity,
      speculative: false,
      behaviorIds: [`practice-required/behavior-${index + 1}`],
      practiceIds: ["practice-required"],
      proofIds: ["practice-required/proof-1"],
      score:
        index === 0 ? opportunity.score : { ...opportunity.score, impact: 0.4, confidence: 0.6 },
    }));
    const councilReview: OpportunityCouncilReview = {
      opportunities: requiredOpportunities,
      nonApplicableLessons: [],
      bundles: [],
      rankingRationale: "Both behaviors are required.",
    };
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/required-practices",
      project: projectFixture(),
      mode: "advisory",
    });

    const result = await registry.get(WorkflowHarnessKind.DECISION_COUNCIL)!(
      {
        id: "council-review",
        kind: "deliberation",
        harness: WorkflowHarnessKind.DECISION_COUNCIL,
        title: "Rank opportunities",
        prompt: "Rank",
        dependsOn: ["opportunity-mapping"],
        gates: ["review-accepted"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        payloads: new Map([
          [
            "opportunity-mapping",
            {
              councilInputReview: councilReview,
              opportunityCoverage: {
                practiceIds: ["practice-required"],
                behaviorIds: ["practice-required/behavior-1", "practice-required/behavior-2"],
                proofIds: ["practice-required/proof-1"],
              },
            },
          ],
        ]),
        artifacts: new Map(),
      },
    );

    expect(result.payload?.opportunityAcceptances).toMatchObject([
      { id: requiredOpportunities[0]!.id, accepted: true },
      { id: requiredOpportunities[1]!.id, accepted: true },
    ]);
    const expander = createSourceToProjectDynamicExpander({
      source: "https://example.com/required-practices",
      project: projectFixture(),
      mode: "advisory",
      includeVisualDesign: false,
    });
    const nodes = await expander({
      node: {
        id: "council-review",
        kind: "deliberation",
        harness: WorkflowHarnessKind.DECISION_COUNCIL,
        title: "Rank opportunities",
        prompt: "Rank",
        dependsOn: ["opportunity-mapping"],
        gates: ["review-accepted"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      result: {
        nodeId: "council-review",
        status: "passed",
        output: result.output,
        payload: result.payload,
      },
      currentPlan: {
        id: "source-plan",
        objective: "Apply required practices",
        templateId: "source-to-project",
        maxReplans: 0,
        nodes: [],
      },
      payloads: new Map(),
      completedNodeIds: new Set(),
    });
    expect(nodes?.map((node) => node.id)).toContain(
      `plan-opportunity-${requiredOpportunities[1]!.id}`,
    );
  });

  it("verifies the visual-plan installer as a source-to-project preflight", async () => {
    const shellCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      tooling: {
        agentNativeSkillsPackage: "@agent-native/skills@0.2.249",
      },
      shell: {
        async run(command, args, options) {
          shellCalls.push({ command, args, cwd: options.cwd });
          return "visual-plan installed";
        },
      },
      copilot: {
        async run() {
          throw new Error("preflight should not invoke Copilot");
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
        id: "visual-plan-preflight",
        kind: WorkflowNodeKind.VERIFICATION,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Verify visual-plan capability",
        prompt: "Verify visual-plan",
        dependsOn: [],
        gates: ["verification"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      { payloads: new Map(), artifacts: new Map() },
    );

    expect(shellCalls).toEqual([
      {
        command: "nub",
        args: ["x", "@agent-native/skills@0.2.249", "add", "--skill", "visual-plan"],
        // The visual-plan installer intentionally uses the workflow runner's own
        // cwd (process.cwd()), not the target project's workingTree, so npm config
        // (.npmrc trust policy etc.) from the weavekit repo is respected. See the
        // comment on this behavior in the copilotAdapter's visual-plan-preflight
        // handling in src/macro-workflow/sourceToProject/harnesses.ts.
        cwd: process.cwd(),
      },
    ]);
    expect(result).toMatchObject({
      status: "passed",
      output: "visual-plan preflight complete.",
      payload: {
        visualPlanPreflight: {
          skill: "visual-plan",
          skillInstall: {
            command: "nub",
            args: ["x", "@agent-native/skills@0.2.249", "add", "--skill", "visual-plan"],
            output: "visual-plan installed",
          },
        },
      },
    });
  });

  it("continues source-to-project after warning when visual-plan hosted auth is pending", async () => {
    const plan = materializeWorkflowPlan("source-to-project", {
      objective: "Apply loops",
      source: "https://example.com/loops",
      project: "weavekit",
      mode: "advisory",
    });
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      shell: {
        async run() {
          return [
            "Skipped URL-only hosted MCP config for codex, cowork; run agent-native connect https://plan.agent-native.com --client codex,cowork --scope user to write bearer auth.",
            "Authentication skipped (non-interactive). To finish auth, run: npx @agent-native/core@latest connect https://plan.agent-native.com --client claude-code,codex,cowork,cursor,opencode,github-copilot --scope user",
            "Authentication pending",
          ].join("\n");
        },
      },
      copilot: {
        async run() {
          throw new Error("source-reading ran after non-fatal visual-plan preflight warning");
        },
      },
    });

    const state = await runMacroWorkflow(plan, { harnesses: registry });

    expect(state.status).toBe("failed");
    expect(state.nodeResults.map((result) => result.nodeId)).toEqual([
      "visual-plan-preflight",
      "source-reading",
    ]);
    expect(state.nodeResults[0]).toMatchObject({
      status: "passed",
    });
    expect(state.nodeResults[0]?.output).toContain("visual-plan preflight warning");
    const visualPlanPreflight = state.nodeResults[0]?.payload?.visualPlanPreflight as
      | { skillInstall?: unknown }
      | undefined;
    expect(visualPlanPreflight?.skillInstall).toMatchObject({
      usable: false,
      skipped: true,
    });
    expect(state.nodeResults[1]?.error).toContain(
      "source-reading ran after non-fatal visual-plan preflight warning",
    );
  });

  it("fails source-to-project before source reading when visual-plan preflight fails", async () => {
    const plan = materializeWorkflowPlan("source-to-project", {
      objective: "Apply loops",
      source: "https://example.com/loops",
      project: "weavekit",
      mode: "advisory",
    });
    const copilotCalls: string[] = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      shell: {
        async run() {
          // A generic, non-special-cased install failure — unlike
          // ERR_NUB_TRUST_DOWNGRADE or hosted-auth-pending, this is not
          // caught and downgraded to a warning by
          // ensureAgentNativeSkillInstalledForAdvisoryWorkflow, so it should
          // still fail the node and block source-reading.
          throw new Error("ENOENT: command not found: nub");
        },
      },
      copilot: {
        async run(args) {
          copilotCalls.push(args.operation ?? "unknown");
          throw new Error("source-reading should not run after preflight failure");
        },
      },
    });

    const state = await runMacroWorkflow(plan, { harnesses: registry });

    expect(state.status).toBe("failed");
    expect(state.nodeResults.map((result) => result.nodeId)).toEqual(["visual-plan-preflight"]);
    expect(state.nodeResults[0]).toMatchObject({
      status: "failed",
      error: "ENOENT: command not found: nub",
    });
    expect(copilotCalls).toEqual([]);
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
      "plan-opportunity-opp-3",
      "review-opportunity-opp-3",
      "report-opportunity-opp-3",
      "visual-design-opportunity-opp-3",
      "plan-opportunity-opp-4",
      "review-opportunity-opp-4",
      "report-opportunity-opp-4",
      "visual-design-opportunity-opp-4",
      "plan-opportunity-opp-1",
      "review-opportunity-opp-1",
      "report-opportunity-opp-1",
      "visual-design-opportunity-opp-1",
      "plan-portfolio",
      "audit-portfolio",
      "report-portfolio",
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
    expect(nodes?.filter((node) => node.kind === WorkflowNodeKind.REPORT)).toHaveLength(4);
  });

  it("omits visual design nodes when the caller requests plan-only fan-out", async () => {
    const expander = createSourceToProjectDynamicExpander({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      includeVisualDesign: false,
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

    expect(nodes?.some((node) => node.kind === WorkflowNodeKind.VISUALIZATION)).toBe(false);
    expect(nodes?.filter((node) => node.kind === WorkflowNodeKind.REPORT)).toHaveLength(4);
  });

  it("adds a canonical portfolio plan after multiple opportunity plans", async () => {
    const expander = createSourceToProjectDynamicExpander({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      includeVisualDesign: false,
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

    const opportunityReviewIds = [
      "review-opportunity-opp-3",
      "review-opportunity-opp-4",
      "review-opportunity-opp-1",
    ];
    expect(nodes?.find((node) => node.id === "plan-portfolio")).toMatchObject({
      kind: WorkflowNodeKind.PLANNING,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      dependsOn: opportunityReviewIds,
    });
    expect(nodes?.find((node) => node.id === "audit-portfolio")).toMatchObject({
      kind: WorkflowNodeKind.DELIBERATION,
      dependsOn: ["plan-portfolio"],
    });
    expect(nodes?.find((node) => node.id === "report-portfolio")).toMatchObject({
      kind: WorkflowNodeKind.REPORT,
      dependsOn: ["audit-portfolio"],
    });
    expect(nodes?.filter((node) => node.id.startsWith("report-opportunity-"))).toHaveLength(3);
  });

  it("plans multiple accepted opportunities directly when canonical-only planning is requested", async () => {
    const expander = createSourceToProjectDynamicExpander({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      includeVisualDesign: false,
      portfolioPlanningMode: "direct",
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
      "plan-portfolio",
      "audit-portfolio",
      "report-portfolio",
    ]);
    expect(nodes?.[0]?.input).toMatchObject({
      planningRoute: {
        kind: "direct",
        reason: "canonical-only planning requested by the caller",
      },
      portfolioCandidates: [
        { acceptance: { id: "opp-3" } },
        { acceptance: { id: "opp-4" } },
        { acceptance: { id: "opp-1" } },
      ],
    });
  });

  it("adds a canonical portfolio plan after a single promoted opportunity", async () => {
    const expander = createSourceToProjectDynamicExpander({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      includeVisualDesign: false,
      maxOpportunities: 1,
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
      "plan-portfolio",
      "audit-portfolio",
      "report-portfolio",
    ]);
    expect(nodes?.find((node) => node.id === "plan-portfolio")).toMatchObject({
      dependsOn: ["council-review"],
      input: {
        planningRoute: {
          kind: "direct",
          reason: "one accepted opportunity covers the required behavior set",
        },
        portfolioCandidates: [
          {
            acceptance: { id: "opp-3" },
          },
        ],
      },
    });
    expect(nodes?.find((node) => node.id === "audit-portfolio")).toMatchObject({
      dependsOn: ["plan-portfolio"],
    });
    expect(nodes?.find((node) => node.id === "report-portfolio")).toMatchObject({
      dependsOn: ["audit-portfolio"],
    });
  });

  it("creates one conditional implementation review cycle", async () => {
    const expander = createSourceToProjectDynamicExpander({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "autonomous-pr",
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

    expect(nodes?.slice(-8).map((node) => node.id)).toEqual([
      "prepare-worktree",
      "implement-selected-bundles",
      "verify-implementation",
      "review-implementation",
      "fix-review-findings",
      "verify-review-fixes",
      "re-review-implementation",
      "open-pr",
    ]);
    const expectedCondition = {
      nodeId: "review-implementation",
      key: "implementationReviewVerdict.status",
      equals: "needs_changes",
    };
    expect(nodes?.find((node) => node.id === "fix-review-findings")).toMatchObject({
      dependsOn: ["review-implementation"],
      runWhen: expectedCondition,
    });
    expect(nodes?.find((node) => node.id === "verify-review-fixes")).toMatchObject({
      dependsOn: ["fix-review-findings"],
      runWhen: expectedCondition,
    });
    expect(nodes?.find((node) => node.id === "re-review-implementation")).toMatchObject({
      dependsOn: ["verify-review-fixes"],
      runWhen: expectedCondition,
    });
    expect(nodes?.find((node) => node.id === "open-pr")?.dependsOn).toEqual([
      "review-implementation",
      "re-review-implementation",
    ]);
  });

  it("rejects malformed persisted review verdicts before opening a pull request", async () => {
    const shellCalls: string[] = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: { ...projectFixture(), autonomousPrAllowed: true },
      mode: "autonomous-pr",
      shell: {
        async run(command, args) {
          shellCalls.push([command, ...args].join(" "));
          return "https://example.com/pr/unsafe\n";
        },
      },
    });
    const reporter = registry.get(WorkflowHarnessKind.REPORTER)!;
    const openPrNode: RuntimeWorkflowNode = {
      id: "open-pr",
      kind: WorkflowNodeKind.REPORT,
      harness: WorkflowHarnessKind.REPORTER,
      title: "Open source-to-project pull request",
      prompt: "Open a pull request.",
      dependsOn: ["review-implementation", "re-review-implementation"],
      gates: [WorkflowGateKind.OUTPUT_CONTRACT],
      writeMode: "read-only",
      replanPolicy: "never",
    };
    const context: WorkflowExecutionContext = {
      payloads: new Map([
        ["review-implementation", { implementationReviewVerdict: { status: "accepted" } }],
        ["prepare-worktree", { worktreePreparation: { worktreePath: "/tmp/wt" } }],
      ]),
      artifacts: new Map(),
    };

    const outcome = await reporter(openPrNode, context).then(
      () => "resolved",
      () => "rejected",
    );

    expect({ outcome, shellCalls }).toEqual({ outcome: "rejected", shellCalls: [] });
  });

  it("promotes a valid bundle instead of overlapping accepted member opportunities", async () => {
    const expander = createSourceToProjectDynamicExpander({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
    });
    const review: OpportunityCouncilReview = {
      ...latestRunCouncilReviewFixture(),
      bundles: [
        {
          id: "bundle-loop-budgeting",
          opportunityIds: ["opp-1", "opp-3", "opp-4"],
          ...coverageFieldsFor("bundle-loop-budgeting"),
          rationale:
            "These accepted opportunities share one loop-budgeting change surface and should be planned together.",
          sharedChangeSurface: "workflow templates, runner, verifier",
          combinedUserValue:
            "A single coherent budgeting workflow improvement instead of three duplicate plans.",
          separationRisk:
            "Separate implementation plans would repeat the same score and budget plumbing.",
          maxPrScope: "Update the loop template, telemetry, and verifier rules together.",
        },
      ],
    };
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
        payload: { councilReview: review },
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
      "plan-portfolio",
      "audit-portfolio",
      "report-portfolio",
    ]);
    const planNode = nodes?.find((node) => node.id === "plan-portfolio");
    expect(planNode?.input).toMatchObject({
      planningRoute: { kind: "direct" },
      portfolioCandidates: [
        {
          selectedCandidate: {
            kind: "bundle",
            id: "bundle-loop-budgeting",
            opportunityIds: ["opp-1", "opp-3", "opp-4"],
          },
        },
      ],
    });
  });

  it("does not promote a bundle that includes rejected member opportunities", async () => {
    const expander = createSourceToProjectDynamicExpander({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
    });
    const review: OpportunityCouncilReview = {
      ...latestRunCouncilReviewFixture(),
      bundles: [
        {
          id: "bundle-with-rejected-member",
          opportunityIds: ["opp-1", "opp-2", "opp-3"],
          ...coverageFieldsFor("bundle-with-rejected-member"),
          rationale: "This bundle incorrectly includes a speculative opportunity.",
          sharedChangeSurface: "workflow templates and harnesses",
          combinedUserValue: "One joined change.",
          separationRisk: "Plans could overlap.",
          maxPrScope: "Update the accepted and speculative changes together.",
        },
      ],
    };
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
        payload: { councilReview: review },
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

    const nodeIds = nodes?.map((node) => node.id) ?? [];
    expect(nodeIds).not.toContain("plan-opportunity-bundle-with-rejected-member");
    expect(nodeIds).toContain("plan-opportunity-opp-1");
    expect(nodeIds).toContain("plan-opportunity-opp-3");
  });

  it("promotes a cohesive bundle with a directly evidenced near-threshold member", async () => {
    const expander = createSourceToProjectDynamicExpander({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
    });
    const fixture = latestRunCouncilReviewFixture();
    const recoveredMember = fixture.opportunities.find(
      (opportunity) => opportunity.id === "opp-2",
    )!;
    const review: OpportunityCouncilReview = {
      ...fixture,
      opportunities: fixture.opportunities.map((opportunity) =>
        opportunity.id === recoveredMember.id
          ? {
              ...opportunity,
              speculative: false,
              score: {
                ...opportunity.score,
                applicability: 0.84,
                impact: 0.83,
                confidence: 0.83,
                risk: 0.25,
              },
            }
          : opportunity,
      ),
      bundles: [
        {
          id: "bundle-cohesive-slice",
          opportunityIds: ["opp-1", "opp-2", "opp-3"],
          ...coverageFieldsFor("bundle-cohesive-slice"),
          rationale: "All three changes are required for one end-to-end improvement.",
          sharedChangeSurface: "workflow template, runner, and verification",
          combinedUserValue: "A complete source-derived workflow improvement.",
          separationRisk: "Splitting the work would leave an incomplete behavior path.",
          maxPrScope: "Implement and verify the three connected changes in one bounded PR.",
        },
      ],
    };

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
        payload: { councilReview: review },
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

    expect(nodes?.map((node) => node.id)).toContain("plan-opportunity-bundle-cohesive-slice");
    expect(nodes?.map((node) => node.id)).not.toContain("plan-opportunity-opp-2");
  });

  it("promotes an evidence-grounded cohesive bundle when decomposition lowers standalone averages", async () => {
    const expander = createSourceToProjectDynamicExpander({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      thresholds: {
        minApplicability: 0.9,
        minConfidence: 0.9,
        minImpact: 0.9,
        minAcceptanceAverage: 0.85,
        maxRisk: 0.8,
      },
    });
    const fixture = latestRunCouncilReviewFixture();
    const opportunityIds = ["opp-1", "opp-3", "opp-4", "opp-5", "opp-6"];
    const review: OpportunityCouncilReview = {
      ...fixture,
      opportunities: fixture.opportunities.filter((opportunity) =>
        opportunityIds.includes(opportunity.id),
      ),
      bundles: [
        {
          id: "bundle-complete-vertical-slice",
          opportunityIds,
          ...coverageFieldsFor("bundle-complete-vertical-slice"),
          rationale:
            "The mapper decomposed one end-to-end source practice into independently scored implementation slices.",
          sharedChangeSurface: "workflow template, runner, verifier, replay, and documentation",
          combinedUserValue: "One complete and verifiable source-derived workflow improvement.",
          separationRisk:
            "Promoting only the highest-scoring slices would omit required behavior and verification coverage.",
          maxPrScope: "Implement the five connected slices in one bounded PR.",
        },
      ],
    };

    const nodes = await expander({
      node: {
        id: "council-review",
        kind: WorkflowNodeKind.DELIBERATION,
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
        payload: { councilReview: review },
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

    const planNode = nodes?.find((node) => node.id === "plan-portfolio");
    expect(planNode?.input).toMatchObject({
      planningRoute: { kind: "direct" },
      portfolioCandidates: [
        {
          selectedCandidate: {
            kind: "bundle",
            opportunityIds,
            memberOpportunities: opportunityIds.map((id) => ({ id })),
          },
        },
      ],
    });
  });

  it("promotes a cohesive bundle when coverage requires lower-scoring accepted members", async () => {
    const expander = createSourceToProjectDynamicExpander({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
    });
    const fixture = latestRunCouncilReviewFixture();
    const opportunityIds = ["opp-1", "opp-3", "opp-4"];
    const opportunities = fixture.opportunities
      .filter((opportunity) => opportunityIds.includes(opportunity.id))
      .map((opportunity) => ({
        ...opportunity,
        score: {
          ...opportunity.score,
          applicability: 0.72,
          impact: 0.7,
          confidence: 0.71,
        },
      }));
    const requiredCoverage = {
      practiceIds: opportunities.flatMap((opportunity) => opportunity.practiceIds),
      behaviorIds: opportunities.flatMap((opportunity) => opportunity.behaviorIds),
      proofIds: opportunities.flatMap((opportunity) => opportunity.proofIds),
    };
    const review: OpportunityCouncilReview = {
      ...fixture,
      opportunities,
      bundles: [
        {
          id: "bundle-required-coverage",
          opportunityIds,
          ...requiredCoverage,
          targetLayers: ["workflow"],
          rationale: "All required behaviors implement one end-to-end workflow slice.",
          sharedChangeSurface: "workflow template, runner, and verifier",
          combinedUserValue: "One complete source-derived workflow improvement.",
          separationRisk: "Separate plans duplicate one implementation and proof path.",
          maxPrScope: "Implement the connected required coverage in one bounded PR.",
        },
      ],
    };
    const opportunityAcceptances = selectAcceptedOpportunities(review, {
      minApplicability: 0.9,
      minConfidence: 0.9,
      minImpact: 0.9,
      minAcceptanceAverage: 0.85,
      maxRisk: 0.8,
    }).map((acceptance) => ({
      ...acceptance,
      accepted: true,
      reason: "Accepted to preserve required source-practice coverage.",
    }));

    const nodes = await expander({
      node: {
        id: "council-review",
        kind: WorkflowNodeKind.DELIBERATION,
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
        payload: {
          councilReview: review,
          opportunityAcceptances,
          opportunityCoverage: requiredCoverage,
        },
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
      "plan-portfolio",
      "audit-portfolio",
      "report-portfolio",
    ]);
    expect(nodes?.find((node) => node.id === "plan-portfolio")?.input).toMatchObject({
      planningRoute: { kind: "direct" },
      portfolioCandidates: [{ selectedCandidate: { id: "bundle-required-coverage" } }],
    });
  });

  it("prepares the full execution prompt for dynamic opportunity plan nodes", async () => {
    const project = projectFixture();
    const councilReview = latestRunCouncilReviewFixture();
    const expander = createSourceToProjectDynamicExpander({
      source: "https://example.com/loops",
      project,
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
        payload: { councilReview },
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
    const planNode = nodes?.find((node) => node.id === "plan-opportunity-opp-1");
    expect(planNode?.prompt).toBe("Create a plan artifact for accepted opportunity opp-1.");
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project,
      mode: "advisory",
    });

    const execution = await registry
      .get(WorkflowHarnessKind.COPILOT_SDK)
      ?.prepareExecution?.(planNode!, {
        payloads: new Map([
          [
            "source-reading",
            {
              sourceAnalysis: sourceAnalysisFixture(),
              practiceLedger: practiceLedgerFixture(),
            },
          ],
          [
            "project-research",
            {
              projectBrief: projectBriefFixture(),
              applicabilityMatrix: applicabilityMatrixFixture(),
            },
          ],
          [
            "council-review",
            {
              councilReview,
              opportunityCoverage: requiredCoverage(
                practiceLedgerFixture(),
                applicabilityMatrixFixture(),
              ),
            },
          ],
        ]),
        artifacts: new Map(),
      });

    expect(execution?.prompt).toContain(
      "Create an implementation plan for this single selected source-to-project candidate.",
    );
    expect(execution?.prompt).toContain("Selected candidate JSON:");
    expect(execution?.prompt).toContain(
      "Add a conservative loop-engineering-starter advisory template",
    );
    expect(execution?.prompt).toContain("Project JSON:");
    expect(execution?.prompt).toContain("Assigned behavior IDs");
    expect(execution?.prompt).toContain("Canonical source practice ledger");
    expect(execution?.calls?.[0]?.prompt).toBe(execution?.prompt);
  });

  it("publishes a markdown report and feeds it into the visual-plan design node", async () => {
    const copilotCalls: Array<{
      cwd?: string;
      prompt: string;
      mode: string;
      model?: string;
      capabilityScope?: unknown;
    }> = [];
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
          return HOSTED_VISUAL_PLAN_ARTIFACT;
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
        [
          "review-opportunity-opp-1",
          {
            finalRecommendationReview: acceptedFinalRecommendationReviewFixture(),
            plan: planSummaryFixture("Loop init plan"),
          },
        ],
      ]),
      artifacts: new Map(),
    });

    expect(reportResult.status).toBe("passed");
    expect(reportResult.output).toContain("# Source-to-Project Report: opp-1");
    expect(reportResult.payload?.sourceToProjectReportMarkdown).toContain(
      "## Implementation Outline",
    );
    expect(reportResult.execution).toMatchObject({
      executor: WorkflowHarnessKind.REPORTER,
      mode: "report",
      prompt: "Report",
      model: "deterministic",
      calls: [
        {
          executor: WorkflowHarnessKind.REPORTER,
          mode: "report",
          prompt: "Report",
          model: "deterministic",
        },
      ],
    });

    const visualResult = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
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
      },
      {
        payloads: new Map([["report-opportunity-opp-1", reportResult.payload!]]),
        artifacts: new Map(),
      },
    );

    expect(shellCalls).toEqual([
      {
        command: "nub",
        args: ["x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
        cwd: "/tmp/secondbrain",
      },
    ]);
    expect(copilotCalls).toHaveLength(1);
    expect(copilotCalls[0]).toMatchObject({
      cwd: "/tmp/secondbrain",
      mode: "plan",
      model: "claude-opus-4.8",
    });
    expect(copilotCalls[0]?.capabilityScope).toMatchObject({
      kind: "skill",
      skillName: "visual-plan",
    });
    expect(copilotCalls[0]?.prompt).toContain(
      "/visual-plan Create an actual visual design artifact",
    );
    expect(copilotCalls[0]?.prompt).toContain("Use Agent-Native Plans local-files privacy mode.");
    expect(copilotCalls[0]?.prompt).toContain(
      "do not run `plan local serve` as a foreground command",
    );
    expect(copilotCalls[0]?.prompt).toContain("# Source-to-Project Report: opp-1");
    expect(visualResult.execution?.calls?.[1]).toMatchObject({
      executor: "copilot-sdk",
      capabilityScope: "skill:visual-plan",
    });
    expect(visualResult.payload?.sourceToProjectVisualPlan).toMatchObject({
      opportunityId: "opp-1",
      skill: "visual-plan",
      rawVisualPlan: HOSTED_VISUAL_PLAN_ARTIFACT,
      hostedArtifactUrl: HOSTED_VISUAL_PLAN_ARTIFACT_URL,
    });
  });

  it("auto-launches a Herdr implement agent when an opportunity report is accepted and auto-implement is enabled", async () => {
    const acceptance = selectAcceptedOpportunities(latestRunCouncilReviewFixture(), {
      minApplicability: 0.7,
      minConfidence: 0.65,
      minImpact: 0.5,
      minAcceptanceAverage: 0.85,
      maxRisk: 0.8,
    }).find((candidate) => candidate.id === "opp-1")!;
    const launchCalls: Array<
      Parameters<
        NonNullable<
          Parameters<typeof createSourceToProjectHarnessRegistry>[0]["prLauncher"]
        >["launch"]
      >[0]
    > = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: { ...projectFixture(), autonomousPrAllowed: true },
      mode: "advisory",
      budgetOverrideReason: "Approved emergency auto-implement run.",
      sourceToProject: {
        ...defaultSourceToProjectDefaultsFixture(),
        autoImplementOnReport: true,
        budgetGate: {
          enabled: true,
          mode: "block",
          ceilingUsd: 25,
          marginFactor: 2,
        },
      },
      prLauncher: {
        async launch(args) {
          launchCalls.push(args);
          return {
            provider: "herdr",
            worktreePath: "/Users/smendenhall/.herdr/worktrees/secondbrain/worktree-opp-1",
            branchName: "source-to-project/opp-1-run-1",
            agentName: "source-to-project-opp-1-run-1",
            startedCommand: "herdr agent start source-to-project-opp-1-run-1",
          };
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
        [
          "review-opportunity-opp-1",
          {
            finalRecommendationReview: acceptedFinalRecommendationReviewFixture(),
            plan: planSummaryFixture("Loop init plan"),
          },
        ],
      ]),
      artifacts: new Map(),
      outputDir: "/tmp/runs/run-1",
    });

    expect(reportResult.status).toBe("passed");
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0]?.context).toMatchObject({
      runId: "run-1",
      nodeId: "report-opportunity-opp-1",
      opportunityId: "opp-1",
      initialPromptMode: "implement",
    });
    expect(launchCalls[0]?.context.reportMarkdown).toBe(
      reportResult.payload?.sourceToProjectReportMarkdown,
    );
    expect(launchCalls[0]?.budgetGate).toMatchObject({
      config: {
        enabled: true,
        mode: "block",
        ceilingUsd: 25,
        marginFactor: 2,
      },
      projection: {
        projectedTokens: expect.any(Number),
        unpricedModels: [],
      },
      override: {
        reason: "Approved emergency auto-implement run.",
      },
    });
    expect(reportResult.payload?.autoImplementLaunch).toEqual({
      status: "launched",
      worktreePath: "/Users/smendenhall/.herdr/worktrees/secondbrain/worktree-opp-1",
      branchName: "source-to-project/opp-1-run-1",
      agentName: "source-to-project-opp-1-run-1",
      startedCommand: "herdr agent start source-to-project-opp-1-run-1",
    });
  });

  it("surfaces an auto-implement budget block before launch work proceeds", async () => {
    const acceptance = selectAcceptedOpportunities(latestRunCouncilReviewFixture(), {
      minApplicability: 0.7,
      minConfidence: 0.65,
      minImpact: 0.5,
      minAcceptanceAverage: 0.85,
      maxRisk: 0.8,
    }).find((candidate) => candidate.id === "opp-1")!;
    let launchWorkStarted = false;
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: { ...projectFixture(), autonomousPrAllowed: true },
      mode: "advisory",
      sourceToProject: {
        ...defaultSourceToProjectDefaultsFixture(),
        autoImplementOnReport: true,
        budgetGate: {
          enabled: true,
          mode: "block",
          ceilingUsd: 0.01,
          marginFactor: 1,
        },
      },
      prLauncher: {
        async launch(args) {
          const decision = evaluateBudgetGate(
            args.budgetGate!.projection,
            args.budgetGate!.config,
            args.budgetGate!.override,
          );
          if (decision.outcome === "block") {
            throw new BudgetGateBlockedError(decision);
          }
          launchWorkStarted = true;
          return {} as never;
        },
      },
    });

    const reportResult = await registry.get(WorkflowHarnessKind.REPORTER)!(
      {
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
      },
      {
        payloads: new Map([
          [
            "review-opportunity-opp-1",
            {
              finalRecommendationReview: acceptedFinalRecommendationReviewFixture(),
              plan: planSummaryFixture("Loop init plan"),
            },
          ],
        ]),
        artifacts: new Map(),
        outputDir: "/tmp/runs/run-1",
      },
    );

    expect(launchWorkStarted).toBe(false);
    expect(reportResult.payload?.autoImplementLaunch).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Budget gate blocked pre-run workflow"),
    });
  });

  it("does not auto-launch when auto-implement is disabled, the project disallows autonomous PRs, or the opportunity was rejected", async () => {
    const acceptance = selectAcceptedOpportunities(latestRunCouncilReviewFixture(), {
      minApplicability: 0.7,
      minConfidence: 0.65,
      minImpact: 0.5,
      minAcceptanceAverage: 0.85,
      maxRisk: 0.8,
    }).find((candidate) => candidate.id === "opp-1")!;
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
    const payloads = new Map([
      [
        "review-opportunity-opp-1",
        {
          finalRecommendationReview: acceptedFinalRecommendationReviewFixture(),
          plan: planSummaryFixture("Loop init plan"),
        },
      ],
    ]);

    // auto-implement disabled (default)
    let launched = false;
    let registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: { ...projectFixture(), autonomousPrAllowed: true },
      mode: "advisory",
      prLauncher: {
        async launch() {
          launched = true;
          return {} as never;
        },
      },
    });
    let reportResult = await registry.get(WorkflowHarnessKind.REPORTER)!(reportNode, {
      payloads,
      artifacts: new Map(),
      outputDir: "/tmp/runs/run-1",
    });
    expect(launched).toBe(false);
    expect(reportResult.payload?.autoImplementLaunch).toBeUndefined();

    // project disallows autonomous PRs
    registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: { ...projectFixture(), autonomousPrAllowed: false },
      mode: "advisory",
      sourceToProject: { ...defaultSourceToProjectDefaultsFixture(), autoImplementOnReport: true },
      prLauncher: {
        async launch() {
          launched = true;
          return {} as never;
        },
      },
    });
    reportResult = await registry.get(WorkflowHarnessKind.REPORTER)!(reportNode, {
      payloads,
      artifacts: new Map(),
      outputDir: "/tmp/runs/run-1",
    });
    expect(launched).toBe(false);
    expect(reportResult.payload?.autoImplementLaunch).toBeUndefined();

    // rejected opportunity
    registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: { ...projectFixture(), autonomousPrAllowed: true },
      mode: "advisory",
      sourceToProject: { ...defaultSourceToProjectDefaultsFixture(), autoImplementOnReport: true },
      prLauncher: {
        async launch() {
          launched = true;
          return {} as never;
        },
      },
    });
    reportResult = await registry.get(WorkflowHarnessKind.REPORTER)!(reportNode, {
      payloads: new Map([
        [
          "review-opportunity-opp-1",
          {
            finalRecommendationReview: {
              ...acceptedFinalRecommendationReviewFixture(),
              status: "rejected" as const,
            },
            plan: planSummaryFixture("Loop init plan"),
          },
        ],
      ]),
      artifacts: new Map(),
      outputDir: "/tmp/runs/run-1",
    });
    expect(launched).toBe(false);
    expect(reportResult.payload?.autoImplementLaunch).toBeUndefined();
  });

  it("executes optimized candidate multiple-opportunity branch nodes without unsupported fallbacks", async () => {
    const rawPlan = "# Plan\n\nAdapt the accepted loop-engineering opportunities.";
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      originalPrompt: "Adapt loops to weavekit",
      project: projectFixture(),
      mode: "advisory",
      copilot: {
        async run() {
          return rawPlan;
        },
      },
      baml: {
        async DistillPlanArtifact(_opportunityJson, _rawPlan, rawPlanArtifactPath) {
          return { ...planSummaryFixture("Candidate branch plan"), rawPlanArtifactPath };
        },
        async ReviewFinalRecommendation() {
          return acceptedFinalRecommendationReviewFixture();
        },
      },
    });
    const acceptance = selectAcceptedOpportunities(latestRunCouncilReviewFixture(), {
      minApplicability: 0.7,
      minConfidence: 0.65,
      minImpact: 0.5,
      minAcceptanceAverage: 0.85,
      maxRisk: 0.8,
    }).filter((candidate) => candidate.accepted)[0]!;
    const sharedInput = {
      opportunity: acceptance.opportunity,
      opportunityAcceptance: acceptance,
      opportunityAcceptances: [acceptance],
      acceptedOpportunityCount: 1,
      rejectedOpportunityCount: 0,
    };
    const payloads = new Map<string, Record<string, unknown>>([
      ["source-reading", { sourceAnalysis: sourceAnalysisFixture() }],
      ["source-corroboration", { corroboration: corroborationFixture() }],
      ["project-research", { projectBrief: projectBriefFixture() }],
      [
        "council-review",
        { councilReview: latestRunCouncilReviewFixture(), opportunityAcceptances: [acceptance] },
      ],
    ]);
    const artifacts = new Map();

    const planResult = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
        id: "plan-opportunity-branch-accepted-opportunity",
        kind: WorkflowNodeKind.PLANNING,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Plan candidate branch",
        prompt: "Plan",
        input: sharedInput,
        dependsOn: ["council-review"],
        gates: ["verification"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      { payloads, artifacts },
    );
    payloads.set("plan-opportunity-branch-accepted-opportunity", planResult.payload ?? {});

    const fanInResult = await registry.get(WorkflowHarnessKind.DECISION_COUNCIL)!(
      {
        id: "fan-in-opportunity-selection",
        kind: WorkflowNodeKind.DELIBERATION,
        harness: WorkflowHarnessKind.DECISION_COUNCIL,
        title: "Fan in",
        prompt: "Fan in",
        dependsOn: ["plan-opportunity-branch-accepted-opportunity"],
        gates: ["review-accepted"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      { payloads, artifacts },
    );
    payloads.set("fan-in-opportunity-selection", fanInResult.payload ?? {});

    const packageResult = await registry.get(WorkflowHarnessKind.RESEARCH)!(
      {
        id: "recommended-advisory-package",
        kind: WorkflowNodeKind.PLANNING,
        harness: WorkflowHarnessKind.RESEARCH,
        title: "Package",
        prompt: "Package",
        dependsOn: ["fan-in-opportunity-selection"],
        gates: ["output-contract"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      { payloads, artifacts },
    );
    payloads.set("recommended-advisory-package", packageResult.payload ?? {});

    const finalReviewResult = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
        id: "final-recommendation-review-multiple-opportunities",
        kind: WorkflowNodeKind.DELIBERATION,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Final review",
        prompt: "Review",
        dependsOn: ["recommended-advisory-package"],
        gates: ["review-accepted"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      { payloads, artifacts },
    );
    payloads.set(
      "final-recommendation-review-multiple-opportunities",
      finalReviewResult.payload ?? {},
    );

    const reportResult = await registry.get(WorkflowHarnessKind.REPORTER)!(
      {
        id: "report-multiple-opportunities",
        kind: WorkflowNodeKind.REPORT,
        harness: WorkflowHarnessKind.REPORTER,
        title: "Report multiple",
        prompt: "Report",
        dependsOn: ["final-recommendation-review-multiple-opportunities"],
        gates: ["output-contract"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      { payloads, artifacts },
    );

    expect(planResult.output).not.toContain("skipped unsupported node");
    expect(fanInResult.output).not.toContain("skipped unsupported node");
    expect(packageResult.output).not.toContain("skipped unsupported node");
    expect(finalReviewResult.output).not.toContain("skipped unsupported node");
    expect(reportResult.output).toContain("# Source-to-Project Report");
    expect(planResult.payload?.plan).toMatchObject({ title: "Candidate branch plan" });
    expect(fanInResult.payload?.plans).toHaveLength(1);
    expect(packageResult.payload?.plans).toHaveLength(1);
    expect(finalReviewResult.payload?.finalRecommendationReview).toMatchObject({
      status: "accepted",
    });
    expect(reportResult.payload?.sourceToProjectReportMarkdown).toContain("Candidate branch plan");
  });

  it("attaches a completed persona deliberation result and a second execution call with the real model", async () => {
    const deliberationCalls: Array<{ maxRounds?: number } | undefined> = [];
    const completedResult: CouncilDeliberationResult = {
      status: "completed",
      personas: [
        { id: "feynman", name: "Feynman", archetype: "critic" },
        { id: "musashi", name: "Musashi", archetype: "synthesist" },
      ],
      personaSelectionRationale: "Selected personas with strong critique fit.",
      recommendation: "Proceed with the top-ranked opportunities.",
      rationale: ["Evidence is strong for opp-1 and opp-3."],
      strongestObjections: ["opp-2 is speculative and under-evidenced."],
      confidence: 0.82,
      convergence: 0.75,
      nextExperiment: "Validate opp-2 with a small spike before committing.",
      finalReportMarkdown: "# Council Report\n\nProceed.",
      model: "claude-sonnet-5",
    };
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      sourceToProject: {
        ...defaultSourceToProjectDefaultsFixture(),
        councilDeliberation: { enabled: true, maxRounds: 1 },
      },
      councilDeliberation: async (_input, options) => {
        deliberationCalls.push(options);
        return completedResult;
      },
    });

    const result = await registry.get(WorkflowHarnessKind.DECISION_COUNCIL)!(
      {
        id: "council-review",
        kind: WorkflowNodeKind.DELIBERATION,
        harness: WorkflowHarnessKind.DECISION_COUNCIL,
        title: "Rank and bundle opportunities",
        prompt: "Rank",
        dependsOn: ["opportunity-mapping"],
        gates: ["review-accepted"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        payloads: new Map([
          ["opportunity-mapping", { councilInputReview: latestRunCouncilReviewFixture() }],
        ]),
        artifacts: new Map(),
      },
    );

    expect(result.status).toBe("passed");
    expect(result.payload?.councilDeliberation).toEqual(completedResult);
    expect(result.payload?.councilReview).toBeDefined();
    expect(result.payload?.opportunityAcceptances).toBeDefined();
    expect(deliberationCalls).toEqual([{ maxRounds: 1 }]);
    expect(result.execution?.calls).toHaveLength(2);
    expect(result.execution?.calls?.[1]).toMatchObject({
      operation: "CouncilDeliberation",
      model: "claude-sonnet-5",
    });
  });

  it("keeps the node passed and appends only one execution call when persona deliberation fails", async () => {
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      sourceToProject: {
        ...defaultSourceToProjectDefaultsFixture(),
        councilDeliberation: { enabled: true, maxRounds: 1 },
      },
      councilDeliberation: async () => ({
        status: "failed",
        error: "persona session timed out",
      }),
    });

    const result = await registry.get(WorkflowHarnessKind.DECISION_COUNCIL)!(
      {
        id: "council-review",
        kind: WorkflowNodeKind.DELIBERATION,
        harness: WorkflowHarnessKind.DECISION_COUNCIL,
        title: "Rank and bundle opportunities",
        prompt: "Rank",
        dependsOn: ["opportunity-mapping"],
        gates: ["review-accepted"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        payloads: new Map([
          ["opportunity-mapping", { councilInputReview: latestRunCouncilReviewFixture() }],
        ]),
        artifacts: new Map(),
      },
    );

    expect(result.status).toBe("passed");
    expect(result.payload?.councilDeliberation).toEqual({
      status: "failed",
      error: "persona session timed out",
    });
    expect(result.execution?.calls).toHaveLength(1);
  });

  it("skips persona deliberation entirely when council_deliberation.enabled is false", async () => {
    let deliberationCalled = false;
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      sourceToProject: {
        ...defaultSourceToProjectDefaultsFixture(),
        councilDeliberation: { enabled: false, maxRounds: 1 },
      },
      councilDeliberation: async () => {
        deliberationCalled = true;
        return { status: "failed", error: "should never run" };
      },
    });

    const result = await registry.get(WorkflowHarnessKind.DECISION_COUNCIL)!(
      {
        id: "council-review",
        kind: WorkflowNodeKind.DELIBERATION,
        harness: WorkflowHarnessKind.DECISION_COUNCIL,
        title: "Rank and bundle opportunities",
        prompt: "Rank",
        dependsOn: ["opportunity-mapping"],
        gates: ["review-accepted"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        payloads: new Map([
          ["opportunity-mapping", { councilInputReview: latestRunCouncilReviewFixture() }],
        ]),
        artifacts: new Map(),
      },
    );

    expect(deliberationCalled).toBe(false);
    expect(result.payload?.councilDeliberation).toBeUndefined();
    expect(result.execution?.calls).toHaveLength(1);
  });

  it("passes a configured maxRounds through to the persona deliberation runner", async () => {
    const deliberationCalls: Array<{ maxRounds?: number } | undefined> = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      sourceToProject: {
        ...defaultSourceToProjectDefaultsFixture(),
        councilDeliberation: { enabled: true, maxRounds: 3 },
      },
      councilDeliberation: async (_input, options) => {
        deliberationCalls.push(options);
        return {
          status: "completed",
          personas: [],
          personaSelectionRationale: "",
          recommendation: "",
          rationale: [],
          strongestObjections: [],
          confidence: 0,
          convergence: 0,
          nextExperiment: "",
          finalReportMarkdown: "",
          model: "claude-sonnet-5",
        };
      },
    });

    await registry.get(WorkflowHarnessKind.DECISION_COUNCIL)!(
      {
        id: "council-review",
        kind: WorkflowNodeKind.DELIBERATION,
        harness: WorkflowHarnessKind.DECISION_COUNCIL,
        title: "Rank and bundle opportunities",
        prompt: "Rank",
        dependsOn: ["opportunity-mapping"],
        gates: ["review-accepted"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        payloads: new Map([
          ["opportunity-mapping", { councilInputReview: latestRunCouncilReviewFixture() }],
        ]),
        artifacts: new Map(),
      },
    );

    expect(deliberationCalls).toEqual([{ maxRounds: 3 }]);
  });

  it("reuses the visual-plan preflight install for the final visual design node", async () => {
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
        async run() {
          throw new Error("visual design should reuse the preflight install");
        },
      },
      copilot: {
        async run(args) {
          copilotCalls.push(args);
          return HOSTED_VISUAL_PLAN_ARTIFACT;
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
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
      },
      {
        payloads: new Map([
          [
            "visual-plan-preflight",
            {
              visualPlanPreflight: {
                skill: "visual-plan",
                skillInstall: {
                  skill: "visual-plan",
                  command: "nub",
                  args: ["x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
                  output: "visual-plan installed during preflight",
                  skipped: false,
                },
              },
            },
          ],
          ["report-opportunity-opp-1", { sourceToProjectReportMarkdown: "# Report" }],
        ]),
        artifacts: new Map(),
      },
    );

    expect(copilotCalls).toHaveLength(1);
    expect(result.payload?.sourceToProjectVisualPlan).toMatchObject({
      skillInstall: {
        output: "visual-plan installed during preflight",
      },
      rawVisualPlan: HOSTED_VISUAL_PLAN_ARTIFACT,
      hostedArtifactUrl: HOSTED_VISUAL_PLAN_ARTIFACT_URL,
    });
  });

  it("still runs visual design when preflight only warned about hosted Agent-Native auth", async () => {
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
        async run() {
          throw new Error("visual design should not reinstall after preflight");
        },
      },
      copilot: {
        async run(args) {
          copilotCalls.push(args);
          return HOSTED_VISUAL_PLAN_ARTIFACT;
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
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
      },
      {
        payloads: new Map([
          [
            "visual-plan-preflight",
            {
              visualPlanPreflight: {
                skill: "visual-plan",
                skillInstall: {
                  skill: "visual-plan",
                  command: "nub",
                  args: ["x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
                  output:
                    "visual-plan hosted capability is not usable: Agent-Native Plan authentication is pending or was skipped.",
                  skipped: true,
                  usable: false,
                  warning:
                    "Agent-Native Plan authentication is pending or was skipped; local visual-plan mode will still be attempted for this advisory run.",
                },
              },
            },
          ],
          ["report-opportunity-opp-1", { sourceToProjectReportMarkdown: "# Report" }],
        ]),
        artifacts: new Map(),
      },
    );

    expect(copilotCalls).toHaveLength(1);
    expect(copilotCalls[0]).toMatchObject({
      cwd: "/tmp/secondbrain",
      mode: "plan",
      model: "claude-opus-4.8",
    });
    expect(copilotCalls[0]?.prompt).toContain("Use Agent-Native Plans local-files privacy mode.");
    expect(result.output).toBe("Visual design complete for opportunity opp-1.");
    expect(result.payload?.sourceToProjectVisualPlan).toMatchObject({
      skillInstall: {
        usable: false,
        warning:
          "Agent-Native Plan authentication is pending or was skipped; local visual-plan mode will still be attempted for this advisory run.",
      },
      rawVisualPlan: HOSTED_VISUAL_PLAN_ARTIFACT,
      hostedArtifactUrl: HOSTED_VISUAL_PLAN_ARTIFACT_URL,
    });
  });

  it("fails visual design when the visual-plan response is only a local HTML fallback", async () => {
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
        async run() {
          return "visual-plan installed";
        },
      },
      copilot: {
        async run() {
          return [
            "Created and opened the visual review artifact.",
            "File: `~/.copilot/session-state/example/files/o5-visual-plan.html` (self-contained, no dependencies)",
          ].join("\n");
        },
      },
    });

    await expect(
      registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
        {
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
        },
        {
          payloads: new Map([
            ["report-opportunity-opp-1", { sourceToProjectReportMarkdown: "# Report" }],
          ]),
          artifacts: new Map(),
        },
      ),
    ).rejects.toThrow("local HTML fallback");
  });

  it("schedules cleanup for local visual-plan bridge URLs", async () => {
    const acceptance = selectAcceptedOpportunities(latestRunCouncilReviewFixture(), {
      minApplicability: 0.7,
      minConfidence: 0.65,
      minImpact: 0.5,
      minAcceptanceAverage: 0.85,
      maxRisk: 0.8,
    }).find((candidate) => candidate.id === "opp-1")!;
    const cleanupCalls: Array<{ hostedArtifactUrl: string; cleanupAfterMs: number }> = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/loops",
      project: projectFixture(),
      mode: "advisory",
      visualPlanBridgeCleanupTtlMs: 60_000,
      visualPlanBridgeCleanup(args) {
        cleanupCalls.push(args);
        return {
          status: "scheduled",
          bridgeUrl: "http://127.0.0.1:57044/local-plan.json?token=fixture",
          port: 57044,
          cleanupAfterMs: args.cleanupAfterMs,
          cleanupCommand: "mock cleanup",
        };
      },
      shell: {
        async run() {
          return "visual-plan installed";
        },
      },
      copilot: {
        async run() {
          return [
            "The plan is live.",
            "https://plan.agent-native.com/local-plans/o3-run-readiness-scorer?bridge=http%3A%2F%2F127.0.0.1%3A57044%2Flocal-plan.json%3Ftoken%3Dfixture",
          ].join("\n");
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
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
      },
      {
        payloads: new Map([
          ["report-opportunity-opp-1", { sourceToProjectReportMarkdown: "# Report" }],
        ]),
        artifacts: new Map(),
      },
    );

    expect(cleanupCalls).toEqual([
      {
        hostedArtifactUrl:
          "https://plan.agent-native.com/local-plans/o3-run-readiness-scorer?bridge=http%3A%2F%2F127.0.0.1%3A57044%2Flocal-plan.json%3Ftoken%3Dfixture",
        cleanupAfterMs: 60_000,
      },
    ]);
    expect(result.payload?.sourceToProjectVisualPlan).toMatchObject({
      hostedArtifactUrl:
        "https://plan.agent-native.com/local-plans/o3-run-readiness-scorer?bridge=http%3A%2F%2F127.0.0.1%3A57044%2Flocal-plan.json%3Ftoken%3Dfixture",
      bridgeCleanup: {
        status: "scheduled",
        port: 57044,
        cleanupAfterMs: 60_000,
      },
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
          return HOSTED_VISUAL_PLAN_ARTIFACT;
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
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
      },
      {
        payloads: new Map([
          ["report-opportunity-opp-1", { sourceToProjectReportMarkdown: "# Report" }],
        ]),
        artifacts: new Map(),
      },
    );

    expect(shellCalls).toEqual([
      {
        command: "nub",
        args: ["x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
        cwd: "/tmp/secondbrain",
      },
      {
        command: "mise",
        args: [
          "exec",
          "--",
          "nub",
          "x",
          "@agent-native/skills@latest",
          "add",
          "--skill",
          "visual-plan",
        ],
        cwd: "/tmp/secondbrain",
      },
    ]);
    expect(copilotCalls).toHaveLength(1);
    expect(result.payload?.sourceToProjectVisualPlan).toMatchObject({
      skillInstall: {
        command: "mise",
        args: [
          "exec",
          "--",
          "nub",
          "x",
          "@agent-native/skills@latest",
          "add",
          "--skill",
          "visual-plan",
        ],
        output: "visual-plan installed through mise",
      },
      rawVisualPlan: HOSTED_VISUAL_PLAN_ARTIFACT,
      hostedArtifactUrl: HOSTED_VISUAL_PLAN_ARTIFACT_URL,
    });
  });

  it("falls back to an absolute mise path when neither nub nor mise are on PATH", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "weavekit-mise-absolute-"));
    const configuredMise = join(tempDir, "mise");

    await writeFile(configuredMise, "#!/bin/sh\nexit 0\n");
    await chmod(configuredMise, 0o755);

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
        tooling: { miseBin: configuredMise },
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
            return HOSTED_VISUAL_PLAN_ARTIFACT;
          },
        },
      });

      const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
        {
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
        },
        {
          payloads: new Map([
            ["report-opportunity-opp-1", { sourceToProjectReportMarkdown: "# Report" }],
          ]),
          artifacts: new Map(),
        },
      );

      expect(shellCalls).toEqual([
        {
          command: "nub",
          args: ["x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
          cwd: "/tmp/secondbrain",
        },
        {
          command: "mise",
          args: [
            "exec",
            "--",
            "nub",
            "x",
            "@agent-native/skills@latest",
            "add",
            "--skill",
            "visual-plan",
          ],
          cwd: "/tmp/secondbrain",
        },
        {
          command: configuredMise,
          args: [
            "exec",
            "--",
            "nub",
            "x",
            "@agent-native/skills@latest",
            "add",
            "--skill",
            "visual-plan",
          ],
          cwd: "/tmp/secondbrain",
        },
      ]);
      expect(copilotCalls).toHaveLength(1);
      expect(result.payload?.sourceToProjectVisualPlan).toMatchObject({
        skillInstall: {
          command: configuredMise,
          args: [
            "exec",
            "--",
            "nub",
            "x",
            "@agent-native/skills@latest",
            "add",
            "--skill",
            "visual-plan",
          ],
          output: "visual-plan installed through absolute mise",
        },
        rawVisualPlan: HOSTED_VISUAL_PLAN_ARTIFACT,
        hostedArtifactUrl: HOSTED_VISUAL_PLAN_ARTIFACT_URL,
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
      const staleConfiguredMise = join(tempDir, "missing", "mise");

      const shellCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
      const copilotCalls: Array<{ cwd?: string; prompt: string; mode: string; model?: string }> =
        [];
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
        tooling: { miseBin: staleConfiguredMise },
        shell: {
          async run(command, args, options) {
            shellCalls.push({ command, args, cwd: options.cwd });
            if (command === "nub") {
              throw Object.assign(new Error("spawn nub ENOENT"), { code: "ENOENT" });
            }
            if (command === "mise") {
              throw Object.assign(new Error("spawn mise ENOENT"), { code: "ENOENT" });
            }
            if (command === staleConfiguredMise) {
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
            return HOSTED_VISUAL_PLAN_ARTIFACT;
          },
        },
      });

      const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
        {
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
        },
        {
          payloads: new Map([
            ["report-opportunity-opp-1", { sourceToProjectReportMarkdown: "# Report" }],
          ]),
          artifacts: new Map(),
        },
      );

      expect(shellCalls).toEqual([
        {
          command: "nub",
          args: ["x", "@agent-native/skills@latest", "add", "--skill", "visual-plan"],
          cwd: "/tmp/secondbrain",
        },
        {
          command: "mise",
          args: [
            "exec",
            "--",
            "nub",
            "x",
            "@agent-native/skills@latest",
            "add",
            "--skill",
            "visual-plan",
          ],
          cwd: "/tmp/secondbrain",
        },
        {
          command: discoveredMise,
          args: [
            "exec",
            "--",
            "nub",
            "x",
            "@agent-native/skills@latest",
            "add",
            "--skill",
            "visual-plan",
          ],
          cwd: "/tmp/secondbrain",
        },
      ]);
      expect(copilotCalls).toHaveLength(1);
      expect(result.payload?.sourceToProjectVisualPlan).toMatchObject({
        skillInstall: {
          command: discoveredMise,
          args: [
            "exec",
            "--",
            "nub",
            "x",
            "@agent-native/skills@latest",
            "add",
            "--skill",
            "visual-plan",
          ],
          output: "visual-plan installed through discovered mise",
        },
        rawVisualPlan: HOSTED_VISUAL_PLAN_ARTIFACT,
        hostedArtifactUrl: HOSTED_VISUAL_PLAN_ARTIFACT_URL,
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
    const applicabilityCalls: unknown[][] = [];
    const practiceLedger = practiceLedgerFixture();
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/kg",
      project: projectFixture(),
      mode: "advisory",
      copilot: {
        async run(args) {
          copilotCalls.push({
            prompt: args.prompt,
            model: args.model,
            maxToolCalls: args.maxToolCalls,
          });
          return "raw project research";
        },
      },
      baml: {
        async DistillProjectApplicability(...args: unknown[]) {
          applicabilityCalls.push(args);
          const practice = practiceLedger.practices[0]!;
          return {
            projectId: "secondbrain",
            architecture: "Filesystem knowledge base",
            constraints: ["Sensitive content stays local"],
            validationCommands: ["scripts/vault-health-check.sh"],
            evidence: projectBriefFixture().evidence,
            assessments: [
              {
                practiceId: practice.id,
                status: "applicable",
                applicableBehaviorIds: practice.behaviorIds,
                excludedBehaviorIds: [],
                targetLayers: ["07-wiki"],
                projectEvidence: projectBriefFixture().evidence,
                contradictionEvidence: [],
                rationale: "The wiki layer synthesizes source relationships.",
              },
            ],
          };
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
        id: "project-research",
        kind: "research",
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Research target project",
        prompt: "Research target project in relation to source findings: secondbrain",
        dependsOn: ["source-corroboration"],
        gates: ["output-contract"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        objective: "Read KG source for how it applies to Second Brain",
        payloads: new Map([
          ["source-reading", { sourceAnalysis: sourceAnalysisFixture(), practiceLedger }],
          ["source-corroboration", { corroboration: corroborationFixture() }],
        ]),
        artifacts: new Map(),
      },
    );

    expect(result.status).toBe("passed");
    expect(copilotCalls[0]).toMatchObject({ model: "claude-sonnet-5", maxToolCalls: 60 });
    expect(copilotCalls[0]?.prompt).toContain("Do not produce a generic repository overview");
    expect(copilotCalls[0]?.prompt).toContain(
      "Hard budget: use at most 60 tool calls for target project research",
    );
    expect(copilotCalls[0]?.prompt).toContain(
      "Original objective:\nRead KG source for how it applies to Second Brain",
    );
    expect(copilotCalls[0]?.prompt).toContain("Source analysis so far:");
    expect(copilotCalls[0]?.prompt).toContain("chunk, extract triples, standardize entities");
    expect(copilotCalls[0]?.prompt).toContain("Corroboration so far:");
    expect(copilotCalls[0]?.prompt).toContain("disqualifying evidence");
    expect(applicabilityCalls).toHaveLength(1);
    expect(applicabilityCalls[0]?.[1]).toEqual(practiceLedger);
    expect(result.payload?.applicabilityMatrix).toMatchObject({
      assessments: [{ practiceId: "practice-knowledge-graph-pipeline", status: "applicable" }],
    });
  });

  it("repairs unknown applicability with one targeted project research call", async () => {
    const prompts: string[] = [];
    const practiceLedger = practiceLedgerFixture();
    const practice = practiceLedger.practices[0]!;
    const projectEvidence = projectBriefFixture().evidence;
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/kg",
      project: projectFixture(),
      mode: "advisory",
      copilot: {
        async run(args) {
          prompts.push(args.prompt);
          return prompts.length === 1 ? "initial project research" : "targeted project evidence";
        },
      },
      baml: {
        async DistillProjectApplicability() {
          return {
            projectId: "secondbrain",
            architecture: "Filesystem knowledge base",
            constraints: [],
            validationCommands: ["scripts/vault-health-check.sh"],
            evidence: [],
            assessments: [
              {
                practiceId: practice.id,
                status: "unknown",
                applicableBehaviorIds: [],
                excludedBehaviorIds: practice.behaviorIds,
                targetLayers: [],
                projectEvidence: [],
                contradictionEvidence: [],
                rationale: "The first pass did not inspect the wiki writer.",
              },
            ],
          };
        },
        async RepairProjectApplicability() {
          return {
            projectId: "secondbrain",
            architecture: "Filesystem knowledge base",
            constraints: [],
            validationCommands: ["scripts/vault-health-check.sh"],
            evidence: projectEvidence,
            assessments: [
              {
                practiceId: practice.id,
                status: "applicable",
                applicableBehaviorIds: practice.behaviorIds,
                excludedBehaviorIds: [],
                targetLayers: ["07-wiki"],
                projectEvidence,
                contradictionEvidence: [],
                rationale: "The targeted pass found the wiki synthesis boundary.",
              },
            ],
          };
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
        id: "project-research",
        kind: "research",
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Research target project",
        prompt: "Research",
        dependsOn: ["source-corroboration"],
        gates: ["output-contract"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        objective: "Apply the source practices",
        payloads: new Map([
          ["source-reading", { sourceAnalysis: sourceAnalysisFixture(), practiceLedger }],
          ["source-corroboration", { corroboration: corroborationFixture() }],
        ]),
        artifacts: new Map(),
      },
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Investigate only these unresolved source practices");
    expect(prompts[1]).toContain(practice.id);
    expect(result.payload?.applicabilityMatrix).toMatchObject({
      assessments: [{ practiceId: practice.id, status: "applicable" }],
    });
    expect(result.execution?.calls?.map((call) => [call.executor, call.operation])).toEqual([
      ["copilot-sdk", undefined],
      ["baml", "DistillProjectApplicability"],
      ["copilot-sdk", undefined],
      ["baml", "RepairProjectApplicability"],
    ]);
    expect(result.execution?.calls?.[3]?.model).toBe("gpt-5.5");
  });

  it("fails closed when applicability remains unknown after repair", async () => {
    const practiceLedger = practiceLedgerFixture();
    const practice = practiceLedger.practices[0]!;
    const unknownMatrix = {
      projectId: "secondbrain",
      architecture: "Filesystem knowledge base",
      constraints: [],
      validationCommands: ["scripts/vault-health-check.sh"],
      evidence: [],
      assessments: [
        {
          practiceId: practice.id,
          status: "unknown" as const,
          applicableBehaviorIds: [],
          excludedBehaviorIds: practice.behaviorIds,
          targetLayers: [],
          projectEvidence: [],
          contradictionEvidence: [],
          rationale: "The evidence remains insufficient.",
        },
      ],
    };
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/kg",
      project: projectFixture(),
      mode: "advisory",
      copilot: {
        async run() {
          return "insufficient research";
        },
      },
      baml: {
        async DistillProjectApplicability() {
          return unknownMatrix;
        },
        async RepairProjectApplicability() {
          return unknownMatrix;
        },
      },
    });

    await expect(
      registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
        {
          id: "project-research",
          kind: "research",
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Research target project",
          prompt: "Research",
          dependsOn: ["source-corroboration"],
          gates: ["output-contract"],
          writeMode: "read-only",
          replanPolicy: "never",
        },
        {
          objective: "Apply the source practices",
          payloads: new Map([
            ["source-reading", { sourceAnalysis: sourceAnalysisFixture(), practiceLedger }],
            ["source-corroboration", { corroboration: corroborationFixture() }],
          ]),
          artifacts: new Map(),
        },
      ),
    ).rejects.toThrow(/Unresolved applicability.*practice-knowledge-graph-pipeline/);
  });

  it("maps opportunities from the canonical ledger and exact applicability coverage", async () => {
    const practiceLedger = practiceLedgerFixture();
    const applicabilityMatrix = applicabilityMatrixFixture();
    const practice = practiceLedger.practices[0]!;
    const mappingCalls: unknown[][] = [];
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/kg",
      project: projectFixture(),
      mode: "advisory",
      baml: {
        async MapSourceToProject(...args: unknown[]) {
          mappingCalls.push(args);
          return {
            opportunities: [
              {
                id: "knowledge-graph-writer",
                title: "Add relationship synthesis",
                changeKind: "code-change",
                lesson: practice.behavior,
                projectChange: "Synthesize source relationships in the wiki writer.",
                changeSurface: "07-wiki",
                practiceIds: [practice.id],
                behaviorIds: practice.behaviorIds,
                targetLayers: ["07-wiki"],
                proofIds: practice.proofIds,
                score: opportunityScoreFixture(),
                evidence: applicabilityMatrix.evidence,
                speculative: false,
              },
            ],
            nonApplicableLessons: [],
            bundles: [],
            rankingRationale: "One applicable practice maps to one change surface.",
          };
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.RESEARCH)!(
      {
        id: "opportunity-mapping",
        kind: "planning",
        harness: WorkflowHarnessKind.RESEARCH,
        title: "Map opportunities",
        prompt: "Map",
        dependsOn: ["source-corroboration", "project-research"],
        gates: ["output-contract"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        payloads: new Map([
          ["source-reading", { sourceAnalysis: sourceAnalysisFixture(), practiceLedger }],
          ["source-corroboration", { corroboration: corroborationFixture() }],
          ["project-research", { projectBrief: projectBriefFixture(), applicabilityMatrix }],
        ]),
        artifacts: new Map(),
      },
    );

    expect(mappingCalls[0]?.[0]).toEqual(practiceLedger);
    expect(mappingCalls[0]?.[2]).toEqual(applicabilityMatrix);
    expect(result.payload?.opportunityCoverage).toEqual({
      practiceIds: [practice.id],
      behaviorIds: practice.behaviorIds,
      proofIds: practice.proofIds,
    });
  });

  it("repairs an invalid opportunity mapping exactly once with deterministic coverage feedback", async () => {
    const practiceLedger = practiceLedgerFixture();
    const applicabilityMatrix = applicabilityMatrixFixture();
    const practice = practiceLedger.practices[0]!;
    const mappingCalls: unknown[][] = [];
    const completeOpportunity = {
      id: "knowledge-graph-writer",
      title: "Add relationship synthesis",
      changeKind: "code-change" as const,
      lesson: practice.behavior,
      projectChange: "Synthesize source relationships in the wiki writer.",
      changeSurface: "07-wiki",
      practiceIds: [practice.id],
      behaviorIds: practice.behaviorIds,
      targetLayers: ["07-wiki"],
      proofIds: practice.proofIds,
      score: opportunityScoreFixture(),
      evidence: applicabilityMatrix.evidence,
      speculative: false,
    };
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/kg",
      project: projectFixture(),
      mode: "advisory",
      baml: {
        async MapSourceToProject(...args: unknown[]) {
          mappingCalls.push(args);
          return {
            opportunities: mappingCalls.length === 1 ? [] : [completeOpportunity],
            nonApplicableLessons: [],
            bundles: [],
            rankingRationale: "Repair preserves complete applicability coverage.",
          };
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.RESEARCH)!(
      {
        id: "opportunity-mapping",
        kind: "planning",
        harness: WorkflowHarnessKind.RESEARCH,
        title: "Map opportunities",
        prompt: "Map",
        dependsOn: ["source-corroboration", "project-research"],
        gates: ["output-contract"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        payloads: new Map([
          ["source-reading", { sourceAnalysis: sourceAnalysisFixture(), practiceLedger }],
          ["source-corroboration", { corroboration: corroborationFixture() }],
          ["project-research", { projectBrief: projectBriefFixture(), applicabilityMatrix }],
        ]),
        artifacts: new Map(),
      },
    );

    expect(mappingCalls).toHaveLength(2);
    expect(mappingCalls[0]?.[3]).toBe("");
    expect(mappingCalls[1]?.[3]).toMatch(/opportunity behavior coverage mismatch/);
    expect(result.payload?.mappingRepairAttempted).toBe(true);
    expect(result.execution?.calls).toHaveLength(2);
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
    expect(result.execution?.calls?.map((call) => call.model)).toEqual([
      "claude-opus-4.8",
      "gpt-5-mini",
    ]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("selected source-to-project candidate");
    expect(prompts[0]).toContain("knowledge graph");
    expect(prompts[0]).not.toContain("LLM adapter layer");
  });

  it("persists per-opportunity plan markdown and supplies its path to BAML", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "weavekit-plan-artifact-"));
    try {
      const councilReview = mixedCouncilReviewFixture();
      const acceptance = selectAcceptedOpportunities(councilReview, {
        minApplicability: 0.7,
        minConfidence: 0.65,
        minImpact: 0.5,
        minAcceptanceAverage: 0.85,
        maxRisk: 0.8,
      }).find((candidate) => candidate.id === "opp-1")!;
      const rawMarkdown = "# Plan\n\nImplement the KG pipeline.";
      const distillCalls: string[][] = [];
      const registry = createSourceToProjectHarnessRegistry({
        source: "https://example.com/kg",
        project: projectFixture(),
        mode: "advisory",
        copilot: {
          async run() {
            return rawMarkdown;
          },
        },
        baml: {
          async DistillPlanArtifact(...args: string[]) {
            distillCalls.push(args);
            const { rawPlanArtifactPath: _rawPlanArtifactPath, ...summary } =
              planSummaryFixture("KG pipeline plan");
            return summary;
          },
        },
      });

      const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
        {
          id: "plan-opportunity-opp-1",
          kind: WorkflowNodeKind.PLANNING,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Plan opp-1",
          prompt: "Plan",
          input: {
            opportunity: acceptance.opportunity,
            opportunityAcceptance: acceptance,
          },
          dependsOn: ["council-review"],
          gates: ["verification"],
          writeMode: "read-only",
          replanPolicy: "never",
        },
        {
          payloads: new Map([
            ["council-review", { councilReview }],
            ["project-research", { projectBrief: projectBriefFixture() }],
          ]),
          artifacts: new Map(),
          outputDir,
        },
      );

      expect(result.status).toBe("passed");
      expect(distillCalls).toHaveLength(1);
      expect(distillCalls[0]?.[1]).toBe(rawMarkdown);
      expect(distillCalls[0]?.[2]).toBe("raw-plans/plan-opportunity-opp-1.md");
      await expect(
        readFile(join(outputDir, "raw-plans", "plan-opportunity-opp-1.md"), "utf8"),
      ).resolves.toBe(rawMarkdown);
      expect(result.payload?.plan).toMatchObject({
        rawPlanArtifactPath: "raw-plans/plan-opportunity-opp-1.md",
      });
      expect(result.artifacts).toEqual([
        {
          kind: "markdown",
          path: "raw-plans/plan-opportunity-opp-1.md",
          description: "Raw Copilot plan markdown for plan-opportunity-opp-1.",
        },
      ]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("synthesizes and persists one canonical portfolio plan from opportunity plans", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "weavekit-portfolio-plan-"));
    const rawPlansDir = join(outputDir, "raw-plans");
    await mkdir(rawPlansDir, { recursive: true });
    try {
      await writeFile(
        join(rawPlansDir, "plan-opportunity-validation.md"),
        "# Validation plan\n\nAdd strict boundary parsing.",
      );
      await writeFile(
        join(rawPlansDir, "plan-opportunity-rendering.md"),
        "# Rendering plan\n\nReplace innerHTML with textContent.",
      );
      const copilotCalls: Array<{
        prompt: string;
        mode: string;
        operation?: string;
        acceptPartialOnTimeout?: boolean;
      }> = [];
      const councilReview = latestRunCouncilReviewFixture();
      const opportunityAcceptances = selectAcceptedOpportunities(councilReview, {
        minApplicability: 0.7,
        minConfidence: 0.65,
        minImpact: 0.5,
        minAcceptanceAverage: 0.85,
        maxRisk: 0.8,
      });
      const rejectedOpportunity = opportunityAcceptances.find((candidate) => !candidate.accepted)!;
      const registry = createSourceToProjectHarnessRegistry({
        source: "https://example.com/safe-todos",
        originalPrompt: "Apply the safe todo vertical slice",
        project: projectFixture(),
        mode: "advisory",
        copilot: {
          async run(args) {
            copilotCalls.push({
              prompt: args.prompt,
              mode: args.mode,
              operation: args.operation,
              acceptPartialOnTimeout: args.acceptPartialOnTimeout,
            });
            return "# Canonical implementation plan\n\nImplement the complete safe vertical slice.";
          },
        },
        baml: {
          async DistillPlanArtifact() {
            return planSummaryFixture("Canonical implementation plan");
          },
        },
      });

      const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
        {
          id: "plan-portfolio",
          kind: WorkflowNodeKind.PLANNING,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Synthesize portfolio",
          prompt: "Synthesize",
          input: { portfolioCandidates: [] },
          dependsOn: ["plan-opportunity-validation", "plan-opportunity-rendering"],
          gates: ["verification"],
          writeMode: "read-only",
          replanPolicy: "never",
        },
        {
          objective: "Apply the safe todo vertical slice",
          payloads: new Map([
            ["source-reading", { sourceAnalysis: sourceAnalysisFixture() }],
            ["source-corroboration", { corroboration: corroborationFixture() }],
            ["project-research", { projectBrief: projectBriefFixture() }],
            ["council-review", { councilReview, opportunityAcceptances }],
            [
              "plan-opportunity-validation",
              {
                plan: {
                  ...planSummaryFixture("Validation plan"),
                  rawPlanArtifactPath: "raw-plans/plan-opportunity-validation.md",
                },
              },
            ],
            [
              "plan-opportunity-rendering",
              {
                plan: {
                  ...planSummaryFixture("Rendering plan"),
                  rawPlanArtifactPath: "raw-plans/plan-opportunity-rendering.md",
                },
              },
            ],
          ]),
          artifacts: new Map(),
          outputDir,
        },
      );

      expect(copilotCalls).toHaveLength(1);
      expect(copilotCalls[0]).toMatchObject({
        mode: "plan",
        operation: "plan-portfolio",
        acceptPartialOnTimeout: false,
      });
      expect(copilotCalls[0]?.prompt).toContain("one cohesive implementation plan");
      expect(copilotCalls[0]?.prompt).toContain("Add strict boundary parsing");
      expect(copilotCalls[0]?.prompt).toContain("Replace innerHTML with textContent");
      expect(copilotCalls[0]?.prompt).toContain("remove duplicate or conflicting work");
      expect(copilotCalls[0]?.prompt).toContain(rejectedOpportunity.title);
      expect(copilotCalls[0]?.prompt).toContain(rejectedOpportunity.reason);
      expect(copilotCalls[0]?.prompt).toContain(
        "Restore a non-selected opportunity only when direct target-project evidence",
      );
      expect(copilotCalls[0]?.prompt).toContain("Source analysis and requirement evidence");
      expect(copilotCalls[0]?.prompt).toContain("Corroboration and competing views");
      expect(result.payload).toMatchObject({
        portfolioPlan: true,
        plan: { rawPlanArtifactPath: "raw-plans/plan-portfolio.md" },
      });
      await expect(readFile(join(rawPlansDir, "plan-portfolio.md"), "utf8")).resolves.toContain(
        "Canonical implementation plan",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("plans the canonical portfolio directly from one promoted opportunity", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "weavekit-single-portfolio-plan-"));
    const rawPlansDir = join(outputDir, "raw-plans");
    await mkdir(rawPlansDir, { recursive: true });
    try {
      const councilReview = latestRunCouncilReviewFixture();
      const opportunityAcceptances = selectAcceptedOpportunities(councilReview, {
        minApplicability: 0.7,
        minConfidence: 0.65,
        minImpact: 0.5,
        minAcceptanceAverage: 0.85,
        maxRisk: 0.8,
      });
      const acceptedOpportunity = opportunityAcceptances.find((candidate) => candidate.accepted)!;
      const practiceLedger = practiceLedgerFixture();
      const applicabilityMatrix = applicabilityMatrixFixture();
      const opportunityCoverage = requiredCoverage(practiceLedger, applicabilityMatrix);
      const prompts: string[] = [];
      const toolPolicies: unknown[] = [];
      const maxToolCalls: unknown[] = [];
      const registry = createSourceToProjectHarnessRegistry({
        source: "https://example.com/safe-todos",
        originalPrompt: "Apply the safe todo vertical slice",
        project: projectFixture(),
        mode: "advisory",
        copilot: {
          async run(args) {
            prompts.push(args.prompt);
            toolPolicies.push(args.toolPolicy);
            maxToolCalls.push(args.maxToolCalls);
            return "# Canonical implementation plan\n\nImplement the validation slice.";
          },
        },
        baml: {
          async DistillPlanArtifact() {
            return planSummaryFixture("Canonical implementation plan");
          },
        },
      });

      const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
        {
          id: "plan-portfolio",
          kind: WorkflowNodeKind.PLANNING,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Synthesize portfolio",
          prompt: "Synthesize",
          input: {
            planningRoute: {
              kind: "direct",
              reason: "one accepted opportunity covers the required behavior set",
            },
            portfolioCandidates: [{ acceptance: acceptedOpportunity }],
          },
          dependsOn: ["council-review"],
          gates: ["verification"],
          writeMode: "read-only",
          replanPolicy: "never",
        },
        {
          objective: "Apply the safe todo vertical slice",
          payloads: new Map([
            ["source-reading", { sourceAnalysis: sourceAnalysisFixture(), practiceLedger }],
            ["source-corroboration", { corroboration: corroborationFixture() }],
            ["project-research", { projectBrief: projectBriefFixture(), applicabilityMatrix }],
            ["council-review", { councilReview, opportunityAcceptances, opportunityCoverage }],
          ]),
          artifacts: new Map(),
          outputDir,
        },
      );

      expect(prompts[0]).toContain("This is the direct planning route");
      expect(prompts[0]).toContain("Canonical source practice ledger");
      expect(prompts[0]).not.toContain("Independent child plans");
      expect(result.payload).toMatchObject({
        portfolioPlan: true,
        plan: { rawPlanArtifactPath: "raw-plans/plan-portfolio.md" },
        sourcePlans: [],
      });
      expect(toolPolicies).toEqual(["read-only"]);
      expect(maxToolCalls).toEqual([12]);
      await expect(readFile(join(rawPlansDir, "plan-portfolio.md"), "utf8")).resolves.toContain(
        "Canonical implementation plan",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("distills and audits the canonical portfolio against exact compiler coverage", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "weavekit-audited-portfolio-"));
    try {
      const councilReview = latestRunCouncilReviewFixture();
      const opportunityAcceptances = selectAcceptedOpportunities(councilReview, {
        minApplicability: 0.7,
        minConfidence: 0.65,
        minImpact: 0.5,
        minAcceptanceAverage: 0.85,
        maxRisk: 0.8,
      });
      const acceptance = opportunityAcceptances.find((candidate) => candidate.accepted)!;
      const opportunityCoverage = {
        practiceIds: acceptance.opportunity.practiceIds,
        behaviorIds: acceptance.opportunity.behaviorIds,
        proofIds: acceptance.opportunity.proofIds,
      };
      const markdown =
        "# Canonical plan\n\nImplement the accepted behavior in the fixture layer and run its proof.";
      const draft = {
        title: "Canonical plan",
        summary: "Implement the accepted behavior.",
        markdown,
        coverageClaims: [
          {
            practiceId: opportunityCoverage.practiceIds[0]!,
            behaviorIds: opportunityCoverage.behaviorIds,
            proofIds: opportunityCoverage.proofIds,
            targetLayers: acceptance.opportunity.targetLayers,
            evidenceQuotes: ["Implement the accepted behavior in the fixture layer"],
          },
        ],
      };
      const audit = {
        behaviorAssessments: opportunityCoverage.behaviorIds.map((behaviorId) => ({
          behaviorId,
          status: "complete" as const,
          responsibleLayer: "fixture layer",
          evidenceQuotes: ["Implement the accepted behavior in the fixture layer"],
          gaps: [],
          rationale: "The plan assigns an action and proof.",
        })),
        specializedAssessments: ["layer-assignment", "behavior-contracts", "edge-case-proof"].map(
          (obligationId) => ({
            obligationId,
            status: "complete" as const,
            evidenceQuotes: ["Implement the accepted behavior in the fixture layer"],
            rationale: "The plan covers this code-change obligation.",
          }),
        ),
        unsupportedClaims: [],
        contradictions: [],
        summary: "Coverage complete.",
      };
      const bamlCalls: string[] = [];
      const registry = createSourceToProjectHarnessRegistry({
        source: "https://example.com/safe-todos",
        originalPrompt: "Apply the safe behavior",
        project: projectFixture(),
        mode: "advisory",
        copilot: {
          async run() {
            return markdown;
          },
        },
        baml: {
          async DistillPlanArtifact() {
            return planSummaryFixture("Canonical plan");
          },
          async DistillPortfolioPlanDraft() {
            bamlCalls.push("DistillPortfolioPlanDraft");
            return draft;
          },
          async AuditPortfolioCoverage() {
            bamlCalls.push("AuditPortfolioCoverage");
            return audit;
          },
        },
      });
      const sharedPayloads = new Map([
        [
          "source-reading",
          { sourceAnalysis: sourceAnalysisFixture(), practiceLedger: practiceLedgerFixture() },
        ],
        ["source-corroboration", { corroboration: corroborationFixture() }],
        [
          "project-research",
          {
            projectBrief: projectBriefFixture(),
            applicabilityMatrix: applicabilityMatrixFixture(),
          },
        ],
        ["council-review", { councilReview, opportunityAcceptances, opportunityCoverage }],
      ]);
      const planResult = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
        {
          id: "plan-portfolio",
          kind: WorkflowNodeKind.PLANNING,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Plan portfolio",
          prompt: "Plan",
          input: {
            planningRoute: { kind: "direct", reason: "one accepted opportunity" },
            portfolioCandidates: [{ acceptance }],
          },
          dependsOn: ["council-review"],
          gates: ["verification"],
          writeMode: "read-only",
          replanPolicy: "never",
        },
        {
          objective: "Apply the safe behavior",
          payloads: sharedPayloads,
          artifacts: new Map(),
          outputDir,
        },
      );
      const auditResult = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
        {
          id: "audit-portfolio",
          kind: WorkflowNodeKind.DELIBERATION,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Audit portfolio",
          prompt: "Audit",
          dependsOn: ["plan-portfolio"],
          gates: ["review-accepted"],
          writeMode: "read-only",
          replanPolicy: "never",
        },
        {
          objective: "Apply the safe behavior",
          payloads: new Map([...sharedPayloads, ["plan-portfolio", planResult.payload!]]),
          artifacts: new Map(),
          outputDir,
        },
      );

      expect(bamlCalls).toEqual(["DistillPortfolioPlanDraft", "AuditPortfolioCoverage"]);
      expect(auditResult.payload?.portfolioAudit).toMatchObject({
        passed: true,
        repairAttempted: false,
      });
      expect(auditResult.execution?.metadata).toMatchObject({
        practiceCounts: { applicable: 1, partial: 0, notApplicable: 0, unknown: 0 },
        requiredBehaviorCount: 1,
        planningRoute: "direct",
        portfolioRepairAttempted: false,
        finalAuditStatus: "passed",
      });
      const reportResult = await registry.get(WorkflowHarnessKind.REPORTER)!(
        {
          id: "report-portfolio",
          kind: WorkflowNodeKind.REPORT,
          harness: WorkflowHarnessKind.REPORTER,
          title: "Report portfolio",
          prompt: "Report",
          dependsOn: ["audit-portfolio"],
          gates: ["output-contract"],
          writeMode: "read-only",
          replanPolicy: "never",
        },
        {
          payloads: new Map([["audit-portfolio", auditResult.payload!]]),
          artifacts: new Map(),
          outputDir,
        },
      );
      expect(reportResult.payload?.rawPlanMarkdown).toBe(markdown);
      expect(reportResult.payload?.canonicalPlanPath).toBe("raw-plans/plan-portfolio-full.md");
      await expect(
        readFile(join(outputDir, "raw-plans/plan-portfolio-full.md"), "utf8"),
      ).resolves.toBe(markdown);
      await expect(
        readFile(join(outputDir, "portfolio-coverage-audit.final.json"), "utf8"),
      ).resolves.toContain("Coverage complete");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("repairs an incomplete portfolio once and accepts only the fresh passing audit", async () => {
    const coverage = {
      practiceIds: ["practice-boundaries"],
      behaviorIds: ["practice-boundaries/behavior-1"],
      proofIds: ["practice-boundaries/proof-1"],
    };
    const initialDraft = portfolioDraftFixture("Validate requests in the adapter.", coverage);
    const repairedDraft = portfolioDraftFixture(
      "Validate requests in the adapter and run the malformed-input integration proof.",
      coverage,
    );
    const calls: string[] = [];
    let auditAttempt = 0;
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/boundaries",
      project: projectFixture(),
      mode: "advisory",
      baml: {
        async AuditPortfolioCoverage() {
          calls.push("AuditPortfolioCoverage");
          auditAttempt += 1;
          return portfolioAuditFixture(
            coverage.behaviorIds[0]!,
            auditAttempt === 1 ? "partial" : "complete",
            auditAttempt === 1 ? initialDraft : repairedDraft,
          );
        },
        async RepairPortfolioPlan() {
          calls.push("RepairPortfolioPlan");
          return repairedDraft;
        },
      },
    });

    const result = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      portfolioAuditNodeFixture(),
      portfolioAuditContextFixture(coverage, initialDraft),
    );

    expect(calls).toEqual([
      "AuditPortfolioCoverage",
      "RepairPortfolioPlan",
      "AuditPortfolioCoverage",
    ]);
    expect(result.payload?.portfolioAudit).toMatchObject({
      passed: true,
      repairAttempted: true,
      attempts: 1,
    });
    expect(result.payload?.portfolioDraft).toEqual(repairedDraft);
  });

  it("fails closed when portfolio coverage remains incomplete after one repair", async () => {
    const coverage = {
      practiceIds: ["practice-boundaries"],
      behaviorIds: ["practice-boundaries/behavior-1"],
      proofIds: ["practice-boundaries/proof-1"],
    };
    const draft = portfolioDraftFixture("Validate requests in the adapter.", coverage);
    let repairCalls = 0;
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/boundaries",
      project: projectFixture(),
      mode: "advisory",
      baml: {
        async AuditPortfolioCoverage() {
          return portfolioAuditFixture(coverage.behaviorIds[0]!, "partial", draft);
        },
        async RepairPortfolioPlan() {
          repairCalls += 1;
          return draft;
        },
      },
    });

    await expect(
      registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
        portfolioAuditNodeFixture(),
        portfolioAuditContextFixture(coverage, draft),
      ),
    ).rejects.toThrow(/Portfolio coverage remains incomplete after one repair/);
    expect(repairCalls).toBe(1);
  });

  it("reviews an opportunity plan against its scoped contract instead of the whole portfolio", async () => {
    const acceptance = selectAcceptedOpportunities(latestRunCouncilReviewFixture(), {
      minApplicability: 0.7,
      minConfidence: 0.65,
      minImpact: 0.5,
      minAcceptanceAverage: 0.85,
      maxRisk: 0.8,
    }).find((candidate) => candidate.accepted)!;
    const plan = planSummaryFixture("Scoped backend plan");
    let reviewObjective = "";
    const registry = createSourceToProjectHarnessRegistry({
      source: "https://example.com/safe-todos",
      originalPrompt: "Implement the complete backend and frontend vertical slice.",
      project: projectFixture(),
      mode: "advisory",
      baml: {
        async ReviewFinalRecommendation(originalPrompt) {
          reviewObjective = originalPrompt;
          return acceptedFinalRecommendationReviewFixture();
        },
      },
    });

    await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
      {
        id: `review-opportunity-${acceptance.id}`,
        kind: WorkflowNodeKind.DELIBERATION,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Review scoped opportunity",
        prompt: "Review",
        input: {
          opportunity: acceptance.opportunity,
          opportunityAcceptance: acceptance,
        },
        dependsOn: [`plan-opportunity-${acceptance.id}`],
        gates: ["review-accepted"],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        objective: "Fallback objective",
        payloads: new Map([
          ["source-reading", { sourceAnalysis: sourceAnalysisFixture() }],
          ["source-corroboration", { corroboration: corroborationFixture() }],
          ["project-research", { projectBrief: projectBriefFixture() }],
          [`plan-opportunity-${acceptance.id}`, { plan }],
        ]),
        artifacts: new Map(),
      },
    );

    expect(reviewObjective).toContain("component of a larger source-to-project portfolio");
    expect(reviewObjective).toContain(acceptance.id);
    expect(reviewObjective).toContain(acceptance.opportunity.projectChange);
    expect(reviewObjective).toContain(
      "Do not reject this component merely because it omits other accepted opportunities",
    );
  });

  it("reviews and reports the canonical portfolio plan", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "weavekit-portfolio-report-"));
    const rawPlansDir = join(outputDir, "raw-plans");
    await mkdir(rawPlansDir, { recursive: true });
    try {
      const canonicalMarkdown =
        "# Canonical implementation plan\n\nImplement validation and safe rendering as one slice.";
      await writeFile(join(rawPlansDir, "plan-portfolio.md"), canonicalMarkdown);
      const plan = {
        ...planSummaryFixture("Canonical implementation plan"),
        rawPlanArtifactPath: "raw-plans/plan-portfolio.md",
      };
      const registry = createSourceToProjectHarnessRegistry({
        source: "https://example.com/safe-todos",
        originalPrompt: "Apply the safe todo vertical slice",
        project: projectFixture(),
        mode: "advisory",
        baml: {
          async ReviewFinalRecommendation(
            _originalPrompt,
            _source,
            _sourceAnalysis,
            _corroboration,
            _projectBrief,
            plans,
          ) {
            expect(plans).toEqual([plan]);
            return {
              status: "accepted",
              actionable: true,
              improvesProject: true,
              unnecessaryComplexity: false,
              benefitOutweighsCost: true,
              complexityAssessment: "One coherent vertical slice.",
              rationale: "The portfolio reconciles the accepted opportunities.",
              rejectionReason: null,
              telegramSummary: null,
            };
          },
        },
      });
      const sharedPayloads = new Map([
        ["source-reading", { sourceAnalysis: sourceAnalysisFixture() }],
        ["source-corroboration", { corroboration: corroborationFixture() }],
        ["project-research", { projectBrief: projectBriefFixture() }],
        ["plan-portfolio", { portfolioPlan: true, plan, plans: [plan] }],
      ]);
      const reviewResult = await registry.get(WorkflowHarnessKind.COPILOT_SDK)!(
        {
          id: "review-portfolio",
          kind: WorkflowNodeKind.DELIBERATION,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Review portfolio",
          prompt: "Review",
          dependsOn: ["plan-portfolio"],
          gates: ["review-accepted"],
          writeMode: "read-only",
          replanPolicy: "never",
        },
        {
          objective: "Apply the safe todo vertical slice",
          payloads: sharedPayloads,
          artifacts: new Map(),
          outputDir,
        },
      );

      expect(reviewResult.payload).toMatchObject({
        portfolioPlan: true,
        plan,
        finalRecommendationReview: { status: "accepted" },
      });
      const reportResult = await registry.get(WorkflowHarnessKind.REPORTER)!(
        {
          id: "report-portfolio",
          kind: WorkflowNodeKind.REPORT,
          harness: WorkflowHarnessKind.REPORTER,
          title: "Report portfolio",
          prompt: "Report",
          dependsOn: ["review-portfolio"],
          gates: ["output-contract"],
          writeMode: "read-only",
          replanPolicy: "never",
        },
        {
          payloads: new Map([...sharedPayloads, ["review-portfolio", reviewResult.payload!]]),
          artifacts: new Map(),
          outputDir,
        },
      );

      expect(reportResult.payload).toMatchObject({
        portfolioPlan: true,
        plan,
        finalRecommendationReview: { status: "accepted" },
      });
      expect(reportResult.payload?.sourceToProjectReportMarkdown).toContain(canonicalMarkdown);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
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
        async ReviewFinalRecommendation(
          originalPrompt,
          source,
          _sourceAnalysis,
          _corroboration,
          _projectBrief,
          plans,
        ) {
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
    expect(result.execution?.calls?.[0]).toMatchObject({
      executor: "baml",
      operation: "ReviewFinalRecommendation",
    });
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
        [
          "plan-selected-opportunities",
          {
            plans: [],
            planSelection: {
              status: "rejected",
              reason: "No opportunity met the quality gate.",
              candidatesConsidered: [],
            },
          },
        ],
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

describe("stripPlanningAgentPreamble", () => {
  it("strips the harness's persisted-path preamble and separator before the real plan heading", () => {
    const raw = [
      "Plan saved and todos tracked. Here is the final plan markdown (the harness will persist it to `raw-plans/plan-opportunity-opp-1.md`):",
      "",
      "---",
      "",
      "# Plan — opp-1: do the thing",
      "",
      "Body content.",
    ].join("\n");

    expect(stripPlanningAgentPreamble(raw)).toBe("# Plan — opp-1: do the thing\n\nBody content.");
  });

  it("strips a preamble variant with no explicit persisted path", () => {
    const raw =
      "Plan saved and todos tracked. Here is the final implementation plan.\n\n---\n\n# Implementation Plan — O1\n";

    expect(stripPlanningAgentPreamble(raw)).toBe("# Implementation Plan — O1\n");
  });

  it("leaves markdown untouched when there is no known preamble", () => {
    const raw = "# Plan — opp-1: do the thing\n\nBody content.";

    expect(stripPlanningAgentPreamble(raw)).toBe(raw);
  });
});

describe("report node exposes the exact plan markdown embedded in the herdr launch prompt", () => {
  it("includes the cleaned raw plan verbatim inside sourceToProjectReportMarkdown (the string sent to herdr)", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "weavekit-report-plan-"));
    try {
      const rawPlanArtifactPath = "raw-plans/plan-opportunity-opp-1.md";
      const persistedRawPlan = [
        "Plan saved and todos tracked. Here is the final plan markdown (the harness will persist it to `raw-plans/plan-opportunity-opp-1.md`):",
        "",
        "---",
        "",
        "# Plan — opp-1: do the thing",
        "",
        "Body content describing the change.",
      ].join("\n");
      await mkdir(join(outputDir, "raw-plans"), { recursive: true });
      await writeFile(join(outputDir, rawPlanArtifactPath), persistedRawPlan, "utf8");

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
          [
            "review-opportunity-opp-1",
            {
              finalRecommendationReview: acceptedFinalRecommendationReviewFixture(),
              plan: { ...planSummaryFixture("Loop init plan"), rawPlanArtifactPath },
            },
          ],
        ]),
        artifacts: new Map(),
        outputDir,
      });

      expect(reportResult.status).toBe("passed");
      // The UI's plan card renders payload.rawPlanMarkdown. Confirm it is the harness-preamble-free
      // plan text...
      expect(reportResult.payload?.rawPlanMarkdown).toBe(
        "# Plan — opp-1: do the thing\n\nBody content describing the change.",
      );
      // ...and that this exact string is embedded verbatim inside sourceToProjectReportMarkdown, which
      // is byte-identical to the report text a manual/auto PR launch sends to herdr as context.reportMarkdown
      // (see "auto-launches an implementation agent..." test asserting launchCalls[0].context.reportMarkdown
      // === reportResult.payload.sourceToProjectReportMarkdown).
      expect(reportResult.payload?.sourceToProjectReportMarkdown).toContain(
        reportResult.payload!.rawPlanMarkdown as string,
      );
      expect(reportResult.output).toBe(reportResult.payload?.sourceToProjectReportMarkdown);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
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

function defaultSourceToProjectDefaultsFixture() {
  return {
    maxOpportunities: 1,
    thresholds: {
      minApplicability: 0.7,
      minConfidence: 0.65,
      minImpact: 0.5,
      minAcceptanceAverage: 0.85,
      maxRisk: 0.8,
    },
    mode: "advisory" as const,
    offline: false,
    prLauncher: {
      provider: "herdr" as const,
      agentCommand: "codex",
      agentArgs: [],
      split: "right" as const,
      agentOptions: [],
    },
    autoImplementOnReport: false,
  };
}

function projectBriefFixture() {
  return {
    projectId: "secondbrain",
    displayName: "Second Brain",
    architecture:
      "Obsidian markdown vault with Copilot CLI agent harness, source ingest, synthesized wiki pages, action review, and output artifacts.",
    constraints: ["Do not process restricted notes."],
    goals: [
      "Create navigable wiki synthesis from source material.",
      "Surface reviewable actions and briefings.",
    ],
    changeSurfaces: ["07-wiki", "08-actions", "09-outputs"],
    validationCommands: ["scripts/vault-health-check.sh"],
    risks: ["Sensitive content must stay local."],
    evidence: [
      { id: "p1", source: "README.md", quote: "Copilot CLI is the supported agent harness." },
    ],
  };
}

function sourceAnalysisFixture() {
  return {
    sourceId: "https://example.com/kg",
    title: "KG source",
    accessLevel: "public",
    summary:
      "A source about chunk, extract triples, standardize entities, infer relationships, and visualize a knowledge graph.",
    claims: ["The source extracts SPO triples."],
    transferableLessons: ["Use a chunk, extract triples, standardize entities pipeline."],
    evidence: [{ id: "s1", source: "README.md", quote: "knowledge graph" }],
    practiceLedger: {
      sourceId: "https://example.com/kg",
      summary: "Transfer the source knowledge-graph pipeline.",
      claims: ["The source extracts SPO triples."],
      practices: [
        {
          id: "knowledge-graph-pipeline",
          title: "Knowledge graph pipeline",
          behavior: "Chunk sources, extract triples, and standardize entities.",
          rationale: "Preserve the source's core processing loop.",
          adoptionPreconditions: ["The project synthesizes source material."],
          requiredBehaviors: ["Extract standardized source relationships"],
          proofObligations: ["Verify the synthesized relationships"],
          evidence: [{ id: "s1", source: "README.md", quote: "knowledge graph" }],
        },
      ],
      evidence: [{ id: "s1", source: "README.md", quote: "knowledge graph" }],
    },
  };
}

function practiceLedgerFixture() {
  return compilePracticeLedger(sourceAnalysisFixture().practiceLedger);
}

function applicabilityMatrixFixture() {
  const practiceLedger = practiceLedgerFixture();
  const practice = practiceLedger.practices[0]!;
  const projectEvidence = projectBriefFixture().evidence;
  return {
    projectId: "secondbrain",
    architecture: "Filesystem knowledge base",
    constraints: ["Sensitive content stays local."],
    validationCommands: ["scripts/vault-health-check.sh"],
    evidence: projectEvidence,
    assessments: [
      {
        practiceId: practice.id,
        status: "applicable" as const,
        applicableBehaviorIds: practice.behaviorIds,
        excludedBehaviorIds: [],
        targetLayers: ["07-wiki"],
        projectEvidence,
        contradictionEvidence: [],
        rationale: "The wiki layer synthesizes source relationships.",
      },
    ],
  };
}

function opportunityScoreFixture() {
  return {
    applicability: 0.95,
    applicabilityReasoning: "The project evidence identifies the exact target layer.",
    impact: 0.9,
    impactReasoning: "The practice improves the source synthesis path.",
    confidence: 0.9,
    confidenceReasoning: "Source and project evidence agree.",
    implementationCost: 0.4,
    implementationCostReasoning: "The change is bounded to one writer.",
    risk: 0.2,
    riskReasoning: "Focused tests constrain regressions.",
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
    sourceLessonApplied:
      "Chunk, extract triples, standardize entities, infer relationships, and visualize.",
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

function portfolioDraftFixture(
  planLine: string,
  coverage: { practiceIds: string[]; behaviorIds: string[]; proofIds: string[] },
) {
  return {
    title: "Boundary plan",
    summary: "Validate requests at ingress.",
    markdown: `# Boundary plan\n\n${planLine}`,
    coverageClaims: [
      {
        practiceId: coverage.practiceIds[0]!,
        behaviorIds: coverage.behaviorIds,
        proofIds: coverage.proofIds,
        targetLayers: ["HTTP adapter"],
        evidenceQuotes: [planLine],
      },
    ],
  };
}

function portfolioAuditFixture(
  behaviorId: string,
  status: "complete" | "partial",
  draft: ReturnType<typeof portfolioDraftFixture>,
) {
  return {
    behaviorAssessments: [
      {
        behaviorId,
        status,
        responsibleLayer: "HTTP adapter",
        evidenceQuotes: [draft.coverageClaims[0]!.evidenceQuotes[0]!],
        gaps: status === "complete" ? [] : ["Missing integration proof."],
        rationale:
          status === "complete"
            ? "The action and proof are explicit."
            : "The behavior is present but proof is incomplete.",
      },
    ],
    specializedAssessments: [],
    unsupportedClaims: [],
    contradictions: [],
    summary: status === "complete" ? "Coverage complete." : "Coverage incomplete.",
  };
}

function portfolioAuditNodeFixture() {
  return {
    id: "audit-portfolio",
    kind: WorkflowNodeKind.DELIBERATION,
    harness: WorkflowHarnessKind.COPILOT_SDK,
    title: "Audit portfolio",
    prompt: "Audit",
    dependsOn: ["plan-portfolio"],
    gates: ["review-accepted" as const],
    writeMode: "read-only" as const,
    replanPolicy: "never" as const,
  };
}

function portfolioAuditContextFixture(
  coverage: { practiceIds: string[]; behaviorIds: string[]; proofIds: string[] },
  draft: ReturnType<typeof portfolioDraftFixture>,
) {
  return {
    payloads: new Map([
      [
        "plan-portfolio",
        {
          plan: planSummaryFixture("Boundary plan"),
          portfolioDraft: draft,
          portfolioCompilerJson: JSON.stringify({
            requiredCoverage: coverage,
            specializedObligations: [],
          }),
          portfolioCoverage: coverage,
          specializedObligations: [],
        },
      ],
    ]),
    artifacts: new Map(),
  };
}

function coverageFieldsFor(id: string) {
  const practiceId = `practice-${id.toLowerCase()}`;
  return {
    practiceIds: [practiceId],
    behaviorIds: [`${practiceId}/behavior-1`],
    targetLayers: ["fixture-layer"],
    proofIds: [`${practiceId}/proof-1`],
  };
}

function mixedCouncilReviewFixture() {
  return {
    opportunities: [
      {
        id: "opp-1",
        title: "Add source-to-wiki knowledge graph artifacts",
        lesson:
          "A practical pipeline pattern: chunk, extract SPO triples, standardize entities, infer, visualize.",
        projectChange:
          "Create a knowledge graph artifact from readable vault notes and link reviewable summaries into 07-wiki.",
        changeSurface: "07-wiki, 08-actions, 09-outputs",
        ...coverageFieldsFor("opp-1"),
        score: {
          applicability: 0.9,
          applicabilityReasoning: "Test fixture reasoning for applicability score 0.9.",
          impact: 0.9,
          impactReasoning: "Test fixture reasoning for impact score 0.9.",
          confidence: 0.82,
          confidenceReasoning: "Test fixture reasoning for confidence score 0.82.",
          implementationCost: 0.6,
          implementationCostReasoning: "Test fixture reasoning for implementation cost score 0.6.",
          risk: 0.35,
          riskReasoning: "Test fixture reasoning for risk score 0.35.",
        },
        evidence: [{ id: "e1", source: "README.md", quote: "knowledge graph" }],
        speculative: false,
      },
      {
        id: "opp-4",
        title: "Add entity deduplication review",
        lesson: "Combine rule-based entity standardization with optional LLM inference.",
        projectChange: "Write candidate entity merges to review notes before mutating wiki pages.",
        changeSurface: "08-actions, 09-outputs",
        ...coverageFieldsFor("opp-4"),
        score: {
          applicability: 0.9,
          applicabilityReasoning: "Test fixture reasoning for applicability score 0.9.",
          impact: 0.82,
          impactReasoning: "Test fixture reasoning for impact score 0.82.",
          confidence: 0.8,
          confidenceReasoning: "Test fixture reasoning for confidence score 0.8.",
          implementationCost: 0.5,
          implementationCostReasoning: "Test fixture reasoning for implementation cost score 0.5.",
          risk: 0.25,
          riskReasoning: "Test fixture reasoning for risk score 0.25.",
        },
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
        ...coverageFieldsFor("bundle-A"),
        rationale: "Build the knowledge graph pipeline and entity review together.",
        sharedChangeSurface: "source ingest, 07-wiki, 08-actions, 09-outputs",
        combinedUserValue: "A navigable knowledge graph with human-reviewed entity cleanup.",
        separationRisk: "Separate output formats could drift.",
        maxPrScope: "Add a knowledge graph artifact generator with review notes and validation.",
      },
      {
        id: "bundle-B",
        opportunityIds: ["opp-3"],
        ...coverageFieldsFor("bundle-B"),
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
    projectChange:
      "Implement an LLM adapter layer, response-shape parsing, local-only flags, and raw LLM logging.",
    changeSurface: "00-system LLM client plumbing",
    ...coverageFieldsFor("opp-3"),
    score: {
      applicability: 0.95,
      applicabilityReasoning: "Test fixture reasoning for applicability score 0.95.",
      impact: 0.8,
      impactReasoning: "Test fixture reasoning for impact score 0.8.",
      confidence: 0.9,
      confidenceReasoning: "Test fixture reasoning for confidence score 0.9.",
      implementationCost: 0.45,
      implementationCostReasoning: "Test fixture reasoning for implementation cost score 0.45.",
      risk: 0.25,
      riskReasoning: "Test fixture reasoning for risk score 0.25.",
    },
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
        ...coverageFieldsFor("opp-1"),
        score: {
          applicability: 0.95,
          applicabilityReasoning: "Test fixture reasoning for applicability score 0.95.",
          impact: 0.7,
          impactReasoning: "Test fixture reasoning for impact score 0.7.",
          confidence: 0.9,
          confidenceReasoning: "Test fixture reasoning for confidence score 0.9.",
          implementationCost: 0.3,
          implementationCostReasoning: "Test fixture reasoning for implementation cost score 0.3.",
          risk: 0.2,
          riskReasoning: "Test fixture reasoning for risk score 0.2.",
        },
        evidence,
        speculative: false,
      },
      {
        id: "opp-2",
        title: "Provide harness adapters for cost estimation",
        lesson: "Estimate loop costs.",
        projectChange: "Add cost estimation harness adapters.",
        changeSurface: "harnesses",
        ...coverageFieldsFor("opp-2"),
        score: {
          applicability: 0.9,
          applicabilityReasoning: "Test fixture reasoning for applicability score 0.9.",
          impact: 0.85,
          impactReasoning: "Test fixture reasoning for impact score 0.85.",
          confidence: 0.8,
          confidenceReasoning: "Test fixture reasoning for confidence score 0.8.",
          implementationCost: 0.5,
          implementationCostReasoning: "Test fixture reasoning for implementation cost score 0.5.",
          risk: 0.3,
          riskReasoning: "Test fixture reasoning for risk score 0.3.",
        },
        evidence,
        speculative: true,
      },
      {
        id: "opp-3",
        title: "Extend runner to record cost and telemetry",
        lesson: "Record budgets for loops.",
        projectChange: "Record cost telemetry and safe throttling budgets.",
        changeSurface: "runner",
        ...coverageFieldsFor("opp-3"),
        score: {
          applicability: 0.95,
          applicabilityReasoning: "Test fixture reasoning for applicability score 0.95.",
          impact: 0.9,
          impactReasoning: "Test fixture reasoning for impact score 0.9.",
          confidence: 0.85,
          confidenceReasoning: "Test fixture reasoning for confidence score 0.85.",
          implementationCost: 0.6,
          implementationCostReasoning: "Test fixture reasoning for implementation cost score 0.6.",
          risk: 0.5,
          riskReasoning: "Test fixture reasoning for risk score 0.5.",
        },
        evidence,
        speculative: false,
      },
      {
        id: "opp-4",
        title: "Add automated verifier rules for budgets",
        lesson: "Verify budget boundaries.",
        projectChange: "Add verifier rules for cost, iteration, and verification budgets.",
        changeSurface: "verifier",
        ...coverageFieldsFor("opp-4"),
        score: {
          applicability: 0.9,
          applicabilityReasoning: "Test fixture reasoning for applicability score 0.9.",
          impact: 0.9,
          impactReasoning: "Test fixture reasoning for impact score 0.9.",
          confidence: 0.8,
          confidenceReasoning: "Test fixture reasoning for confidence score 0.8.",
          implementationCost: 0.45,
          implementationCostReasoning: "Test fixture reasoning for implementation cost score 0.45.",
          risk: 0.35,
          riskReasoning: "Test fixture reasoning for risk score 0.35.",
        },
        evidence,
        speculative: false,
      },
      {
        id: "opp-5",
        title: "Ship starter checklists",
        lesson: "Document loop scenarios.",
        projectChange: "Add starter checklists and audit readiness docs.",
        changeSurface: "docs",
        ...coverageFieldsFor("opp-5"),
        score: {
          applicability: 0.85,
          applicabilityReasoning: "Test fixture reasoning for applicability score 0.85.",
          impact: 0.6,
          impactReasoning: "Test fixture reasoning for impact score 0.6.",
          confidence: 0.8,
          confidenceReasoning: "Test fixture reasoning for confidence score 0.8.",
          implementationCost: 0.3,
          implementationCostReasoning: "Test fixture reasoning for implementation cost score 0.3.",
          risk: 0.1,
          riskReasoning: "Test fixture reasoning for risk score 0.1.",
        },
        evidence,
        speculative: false,
      },
      {
        id: "opp-6",
        title: "Ensure snapshot-friendly replan boundaries",
        lesson: "Snapshot loops for replay.",
        projectChange: "Add snapshot-friendly replan boundaries and audit trails.",
        changeSurface: "replay",
        ...coverageFieldsFor("opp-6"),
        score: {
          applicability: 0.88,
          applicabilityReasoning: "Test fixture reasoning for applicability score 0.88.",
          impact: 0.75,
          impactReasoning: "Test fixture reasoning for impact score 0.75.",
          confidence: 0.75,
          confidenceReasoning: "Test fixture reasoning for confidence score 0.75.",
          implementationCost: 0.55,
          implementationCostReasoning: "Test fixture reasoning for implementation cost score 0.55.",
          risk: 0.25,
          riskReasoning: "Test fixture reasoning for risk score 0.25.",
        },
        evidence,
        speculative: false,
      },
    ],
    nonApplicableLessons: [],
    bundles: [],
    rankingRationale: "Ranked by source fit and impact.",
  };
}
