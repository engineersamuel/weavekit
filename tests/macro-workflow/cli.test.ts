import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepResearchDefaults } from "../../src/config.js";
import {
  assertWorkflowRunSucceeded,
  createWorkflowProgressReporter,
  createWorkflowRunDescriptor,
  formatWorkflowCliSuccessMessage,
  formatWorkflowCopilotLog,
  formatWorkflowNodeCompletedMessage,
  formatWorkflowNodeFailureMessage,
  formatWorkflowNodeStartedMessage,
  formatWorkflowNodeWarningMessage,
  formatWorkflowRunCompletedMessage,
  formatWorkflowRunStartedMessage,
  inferSourceReferenceFromPrompt,
  parseWorkflowCliArgs,
  runWorkflowCli,
} from "../../src/cli.js";
import { createStaticHarnessRegistry } from "../../src/macro-workflow/harness.js";
import { MacroWorkflowStateStore } from "../../src/macro-workflow/stateStore.js";
import type { MacroWorkflowRunState } from "../../src/macro-workflow/types.js";
import { WorkflowHarnessKind } from "../../src/macro-workflow/types.js";

const entityValidation = vi.hoisted(() => ({
  assertValidEntityCatalog: vi.fn(),
}));

const deepResearchHarnesses = vi.hoisted(() => ({
  createDefaultDeepResearchExaMcpConnection: vi.fn(),
  createDeepResearchHarnessRegistry: vi.fn(),
  createBoundedDeepResearchRunner: vi.fn(),
}));

const sourceToProjectHarnesses = vi.hoisted(() => ({
  createCopilotSdkHarnessClient: vi.fn(),
  createSourceToProjectHarnessRegistry: vi.fn(),
}));

const verificationOptimizerHarnesses = vi.hoisted(() => ({
  createVerificationOptimizerHarnessRegistry: vi.fn(),
  createVerificationOptimizerDynamicExpander: vi.fn(),
}));

const workflowPlanner = vi.hoisted(() => ({
  planWorkflow: vi.fn(async (args: { objective: string; prompt: string; templateId: string }) => ({
    id: "mock-plan",
    objective: args.objective,
    templateId: args.templateId,
    maxReplans: 0,
    nodes: [],
  })),
}));

const nodeCostHistory = vi.hoisted(() => ({
  recordNodeCostHistoryFromUsage: vi.fn(async () => undefined),
}));

vi.mock("../../src/entities/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/entities/index.js")>(
    "../../src/entities/index.js",
  );
  return {
    ...actual,
    assertValidEntityCatalog: entityValidation.assertValidEntityCatalog,
  };
});

vi.mock("../../src/macro-workflow/bamlAdapters.js", () => ({
  GeneratedWorkflowPlannerAdapter: class {
    private readonly usageCollector?: {
      record(input: Record<string, unknown>): void;
    };

    constructor(
      options: { usageCollector?: { record(input: Record<string, unknown>): void } } = {},
    ) {
      this.usageCollector = options.usageCollector;
    }

    async planWorkflow(args: { objective: string; prompt: string; templateId: string }) {
      const plan = await workflowPlanner.planWorkflow(args);
      this.usageCollector?.record({
        executor: "baml",
        operation: "PlanWorkflow",
        model: "gpt-5.5",
        label: "BAML PlanWorkflow",
        inputTokens: 1000,
        cachedInputTokens: 100,
        outputTokens: 200,
      });
      return plan;
    }
  },
}));

vi.mock("../../src/macro-workflow/deepResearch/harnesses.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/macro-workflow/deepResearch/harnesses.js")
  >("../../src/macro-workflow/deepResearch/harnesses.js");
  return {
    ...actual,
    createDefaultDeepResearchExaMcpConnection:
      deepResearchHarnesses.createDefaultDeepResearchExaMcpConnection,
    createDeepResearchHarnessRegistry: deepResearchHarnesses.createDeepResearchHarnessRegistry,
    createBoundedDeepResearchRunner: deepResearchHarnesses.createBoundedDeepResearchRunner,
  };
});

vi.mock("../../src/macro-workflow/sourceToProject/harnesses.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/macro-workflow/sourceToProject/harnesses.js")
  >("../../src/macro-workflow/sourceToProject/harnesses.js");
  return {
    ...actual,
    createCopilotSdkHarnessClient: sourceToProjectHarnesses.createCopilotSdkHarnessClient,
    createSourceToProjectHarnessRegistry:
      sourceToProjectHarnesses.createSourceToProjectHarnessRegistry,
  };
});

vi.mock("../../src/macro-workflow/verificationOptimizer/harnesses.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/macro-workflow/verificationOptimizer/harnesses.js")
  >("../../src/macro-workflow/verificationOptimizer/harnesses.js");
  return {
    ...actual,
    createVerificationOptimizerHarnessRegistry:
      verificationOptimizerHarnesses.createVerificationOptimizerHarnessRegistry,
    createVerificationOptimizerDynamicExpander:
      verificationOptimizerHarnesses.createVerificationOptimizerDynamicExpander,
  };
});

vi.mock("../../src/macro-workflow/nodeCostHistory.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/macro-workflow/nodeCostHistory.js")
  >("../../src/macro-workflow/nodeCostHistory.js");
  return {
    ...actual,
    recordNodeCostHistoryFromUsage: nodeCostHistory.recordNodeCostHistoryFromUsage,
  };
});

beforeEach(() => {
  entityValidation.assertValidEntityCatalog.mockReset();
  entityValidation.assertValidEntityCatalog.mockImplementation(() => {});
  workflowPlanner.planWorkflow.mockClear();
  nodeCostHistory.recordNodeCostHistoryFromUsage.mockClear();
  deepResearchHarnesses.createDefaultDeepResearchExaMcpConnection.mockReset();
  deepResearchHarnesses.createDeepResearchHarnessRegistry.mockReset();
  deepResearchHarnesses.createBoundedDeepResearchRunner.mockReset();
  deepResearchHarnesses.createBoundedDeepResearchRunner.mockReturnValue({
    run: vi.fn(async () => ({
      objective: "mock",
      methodology: "mock",
      findings: [],
      evidenceMatrix: [],
      contradictions: [],
      gaps: [],
      confidence: "low",
      sources: [],
      markdown: "# Deep Research Report\n\nMock.",
    })),
  });
  sourceToProjectHarnesses.createCopilotSdkHarnessClient.mockReset();
  sourceToProjectHarnesses.createCopilotSdkHarnessClient.mockImplementation(() => ({
    model: "fake-copilot",
    run: vi.fn(async () => "fake copilot output"),
  }));
  sourceToProjectHarnesses.createSourceToProjectHarnessRegistry.mockReset();
  sourceToProjectHarnesses.createSourceToProjectHarnessRegistry.mockReturnValue(
    createStaticHarnessRegistry({
      [WorkflowHarnessKind.REPORTER]: async () => ({ status: "passed", output: "mock report" }),
    }),
  );
  verificationOptimizerHarnesses.createVerificationOptimizerHarnessRegistry.mockReset();
  verificationOptimizerHarnesses.createVerificationOptimizerHarnessRegistry.mockReturnValue(
    createStaticHarnessRegistry({
      [WorkflowHarnessKind.COPILOT_SDK]: async () => ({ status: "passed", output: "mock copilot" }),
      [WorkflowHarnessKind.RESEARCH]: async () => ({ status: "passed", output: "mock research" }),
      [WorkflowHarnessKind.DECISION_COUNCIL]: async () => ({
        status: "passed",
        output: "mock council",
      }),
      [WorkflowHarnessKind.REPORTER]: async () => ({ status: "passed", output: "mock report" }),
    }),
  );
  verificationOptimizerHarnesses.createVerificationOptimizerDynamicExpander.mockReset();
  verificationOptimizerHarnesses.createVerificationOptimizerDynamicExpander.mockReturnValue(
    undefined,
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("macro workflow CLI", () => {
  it("fails entity validation before workflow planning", async () => {
    entityValidation.assertValidEntityCatalog.mockImplementationOnce(() => {
      throw new Error("Entity catalog validation failed with 1 error(s).");
    });

    await expect(
      runWorkflowCli({
        command: "run",
        prompt: "Plan this",
        outputDir: "runs",
        staticTemplate: true,
        dryRun: false,
        template: "implementation-review",
      }),
    ).rejects.toThrow("Entity catalog validation failed");
  });

  it("formats live Copilot SDK harness diagnostics for stderr", () => {
    expect(
      formatWorkflowCopilotLog({
        phase: "session-event",
        mode: "research",
        model: "gpt-5.4",
        eventType: "tool.execution_start",
        toolName: "read_file",
        toolCallCount: 7,
        maxToolCalls: 40,
        elapsedMs: 1234,
      }),
    ).toBe(
      "[weavekit][copilot-sdk] session-event mode=research model=gpt-5.4 event=tool.execution_start tool=read_file toolCalls=7 maxToolCalls=40 elapsedMs=1234\n",
    );
    expect(
      formatWorkflowCopilotLog({
        phase: "session-error",
        mode: "plan",
        model: "claude-opus-4.8",
        message: "SDK crashed",
        elapsedMs: 99,
      }),
    ).toContain("[weavekit][error][copilot-sdk] session-error");
    expect(
      formatWorkflowCopilotLog({
        phase: "skills-warning",
        mode: "plan",
        model: "claude-opus-4.8",
        skillName: "visual-plan",
        message: "auth pending",
      }),
    ).toContain(
      "[weavekit][warn][copilot-sdk] skills-warning mode=plan model=claude-opus-4.8 skill=visual-plan",
    );
  });

  it("formats workflow node lifecycle diagnostics for terminal stderr", () => {
    expect(
      formatWorkflowNodeStartedMessage({
        nodeId: "deep-research-assess-1",
        title: "Assess research iteration 1",
        harness: "research",
        kind: "research",
      }),
    ).toBe(
      "[weavekit] Node started: Assess research iteration 1 (deep-research-assess-1) harness=research kind=research\n",
    );
    expect(
      formatWorkflowNodeCompletedMessage({
        nodeId: "deep-research-report",
        title: "Compile deep research report",
        status: "passed",
        output: "# Report\n\nDone",
        artifacts: [
          {
            kind: "markdown",
            path: "DeepResearchReport.md",
            description: "Deep research Markdown report.",
          },
        ],
      }),
    ).toContain("[weavekit] Node passed: Compile deep research report (deep-research-report)");
    expect(
      formatWorkflowNodeWarningMessage({
        nodeId: "plan-opportunity-o1",
        title: "Plan O1",
        warning:
          "Harness copilot-sdk prepareExecution failed for plan-opportunity-o1: preview resolver failed",
      }),
    ).toContain("[weavekit][warn] Workflow node warning: Plan O1 (plan-opportunity-o1)");
    expect(formatWorkflowRunCompletedMessage({ status: "passed", outputDir: "runs/run-1" })).toBe(
      "[weavekit] Workflow completed with status=passed output=runs/run-1\n",
    );
  });

  it("formats workflow node failures for terminal stderr", () => {
    expect(
      formatWorkflowNodeFailureMessage({
        nodeId: "visual-plan-preflight",
        title: "Verify visual-plan capability",
        status: "failed",
        error: "visual-plan hosted capability is not usable",
      }),
    ).toContain(
      "[weavekit][error] Workflow node failed: Verify visual-plan capability (visual-plan-preflight)",
    );
    expect(
      formatWorkflowNodeFailureMessage({
        nodeId: "visual-plan-preflight",
        title: "Verify visual-plan capability",
        status: "failed",
        error: "visual-plan hosted capability is not usable",
      }),
    ).toContain("[weavekit][error] Error: visual-plan hosted capability is not usable");
  });

  it("throws when a workflow run state finished failed", () => {
    expect(() =>
      assertWorkflowRunSucceeded({
        status: "failed",
        nodeResults: [
          {
            nodeId: "source-corroboration",
            status: "failed",
            output: "Source corroboration failed.",
            error: "Timeout after 300000ms waiting for session.idle",
          },
        ],
      }),
    ).toThrow(
      "Workflow failed at source-corroboration: Timeout after 300000ms waiting for session.idle",
    );
  });

  it("parses workflow plan arguments", () => {
    const parsed = parseWorkflowCliArgs([
      "workflow",
      "plan",
      "--input",
      "question.md",
      "--output",
      "runs/workflow",
    ]);

    expect(parsed).toEqual({
      command: "plan",
      inputPath: "question.md",
      outputDir: "runs/workflow",
      staticTemplate: false,
      dryRun: true,
      noCache: false,
    });
  });

  it("parses an inline workflow prompt", () => {
    const parsed = parseWorkflowCliArgs([
      "workflow",
      "run",
      "--prompt",
      "Ship prompt input",
      "--template",
      "implementation-review",
    ]);

    expect(parsed).toEqual({
      command: "run",
      prompt: "Ship prompt input",
      outputDir: "runs",
      staticTemplate: true,
      dryRun: false,
      noCache: false,
      template: "implementation-review",
    });
  });

  it("parses an explicit resume run without requiring a new prompt", () => {
    expect(
      parseWorkflowCliArgs(["workflow", "run", "--resume", "run-123", "--output", "saved-runs"]),
    ).toEqual({
      command: "run",
      outputDir: "saved-runs",
      staticTemplate: false,
      dryRun: false,
      noCache: false,
      resumeRunId: "run-123",
    });
    expect(() => parseWorkflowCliArgs(["workflow", "run", "--resume"])).toThrow(
      "Missing value for --resume <run-id>.",
    );
  });

  it("rejects ambiguous workflow prompt sources", () => {
    expect(() =>
      parseWorkflowCliArgs(["workflow", "run", "--input", "question.md", "--prompt", "Question"]),
    ).toThrow("Use either --input <path> or --prompt <text>, not both.");
  });

  it("parses a workflow template override", () => {
    const parsed = parseWorkflowCliArgs([
      "workflow",
      "run",
      "--input",
      "question.md",
      "--template",
      "implementation-review",
    ]);

    expect(parsed).toEqual({
      command: "run",
      inputPath: "question.md",
      outputDir: "runs",
      staticTemplate: true,
      dryRun: false,
      noCache: false,
      template: "implementation-review",
    });
  });

  it("parses deep-research template controls", () => {
    const parsed = parseWorkflowCliArgs([
      "workflow",
      "run",
      "--template",
      "deep-research",
      "--prompt",
      "Research current agent workflow tools",
      "--providers",
      "exa,grok,copilot-last30days",
      "--max-iterations",
      "4",
      "--questions-per-iteration",
      "6",
      "--max-results-per-question",
      "7",
      "--visualize",
    ]);

    expect(parsed).toEqual({
      command: "run",
      template: "deep-research",
      prompt: "Research current agent workflow tools",
      outputDir: "runs",
      staticTemplate: true,
      dryRun: false,
      noCache: false,
      deepResearch: {
        providers: ["exa", "grok", "copilot-last30days"],
        maxIterations: 4,
        questionsPerIteration: 6,
        maxResultsPerQuestion: 7,
        visualize: true,
      },
    });
  });

  it("parses every deep-research setting required for legacy resume reconstruction", () => {
    const parsed = parseWorkflowCliArgs([
      "workflow",
      "run",
      "--resume",
      "legacy-deep",
      "--providers",
      "grok",
      "--max-iterations",
      "3",
      "--questions-per-iteration",
      "4",
      "--max-results-per-question",
      "5",
      "--provider-retry-attempts",
      "2",
      "--no-visualize",
    ]);

    expect(parsed.deepResearch).toEqual({
      providers: ["grok"],
      maxIterations: 3,
      questionsPerIteration: 4,
      maxResultsPerQuestion: 5,
      providerRetryAttempts: 2,
      visualize: false,
    });
  });

  it("rejects invalid deep-research numeric controls", () => {
    expect(() =>
      parseWorkflowCliArgs([
        "workflow",
        "run",
        "--template",
        "deep-research",
        "--prompt",
        "Research",
        "--max-iterations",
        "0",
      ]),
    ).toThrow("Invalid --max-iterations value. Expected a positive integer.");
  });

  it("rejects invalid deep-research providers with all accepted provider names", () => {
    expect(() =>
      parseWorkflowCliArgs([
        "workflow",
        "run",
        "--template",
        "deep-research",
        "--prompt",
        "Research",
        "--providers",
        "invalid-provider",
      ]),
    ).toThrow("Expected exa, grok, tavily, perplexity, or copilot-last30days.");
  });

  it("connects the default Exa MCP client for deep-research workflow runs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-deep-research-"));
    const outputRoot = join(rootDir, "runs");
    const exaMcp = {
      web_search_exa: vi.fn(),
    };
    const close = vi.fn(async () => {});
    deepResearchHarnesses.createDefaultDeepResearchExaMcpConnection.mockResolvedValueOnce({
      client: exaMcp,
      close,
    });
    deepResearchHarnesses.createDeepResearchHarnessRegistry.mockReturnValueOnce(
      createStaticHarnessRegistry({
        [WorkflowHarnessKind.RESEARCH]: async () => ({
          status: "passed",
          output: "Generated seed research questions.",
        }),
      }),
    );

    try {
      await runWorkflowCli({
        command: "run",
        prompt: "Research current agent workflow tools",
        outputDir: outputRoot,
        configPath: join(rootDir, "missing-config.toml"),
        staticTemplate: true,
        dryRun: false,
        template: "deep-research",
      });

      expect(deepResearchHarnesses.createDefaultDeepResearchExaMcpConnection).toHaveBeenCalledTimes(
        1,
      );
      expect(deepResearchHarnesses.createDeepResearchHarnessRegistry).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            providers: ["grok", "exa", "copilot-last30days"],
          }),
          exaMcp,
          copilot: expect.any(Object),
        }),
      );
      expect(sourceToProjectHarnesses.createCopilotSdkHarnessClient).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("wires deep research dependencies into verification-optimizer when external research is enabled", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-verification-research-"));
    const outputRoot = join(rootDir, "runs");
    const projectDir = join(rootDir, "project");
    const configPath = join(rootDir, "config.toml");
    const exaMcp = {
      web_search_exa: vi.fn(),
    };
    const close = vi.fn(async () => {});
    deepResearchHarnesses.createDefaultDeepResearchExaMcpConnection.mockResolvedValueOnce({
      client: exaMcp,
      close,
    });
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      configPath,
      `
[verification_optimizer]
external_research = true
mode = "advisory"

[projects.weavekit]
display_name = "Weavekit"
working_tree = "${projectDir}"
mainline = "origin main"
remote = "origin"
context_docs = ["CONTEXT.md"]
validation_commands = ["nub run typecheck"]
autonomous_pr_allowed = false
`,
      "utf8",
    );

    try {
      await runWorkflowCli({
        command: "run",
        prompt: "Optimize verification",
        outputDir: outputRoot,
        configPath,
        staticTemplate: true,
        dryRun: false,
        template: "verification-optimizer",
        project: "weavekit",
        mode: "advisory",
      });

      expect(deepResearchHarnesses.createDefaultDeepResearchExaMcpConnection).toHaveBeenCalledTimes(
        1,
      );
      expect(deepResearchHarnesses.createBoundedDeepResearchRunner).not.toHaveBeenCalled();
      expect(
        verificationOptimizerHarnesses.createVerificationOptimizerHarnessRegistry,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          verificationOptimizer: expect.objectContaining({ externalResearch: true }),
          deepResearch: expect.objectContaining({
            config: expect.objectContaining({
              providers: ["grok", "exa", "copilot-last30days"],
            }),
            exaMcp,
            copilot: expect.any(Object),
            baml: expect.any(Object),
          }),
        }),
      );
      expect(sourceToProjectHarnesses.createCopilotSdkHarnessClient).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("parses source-to-project workflow selectors", () => {
    const parsed = parseWorkflowCliArgs([
      "workflow",
      "run",
      "--template",
      "source-to-project",
      "--prompt",
      "Read source for secondbrain",
      "--source",
      "https://example.com/post",
      "--project",
      "weavekit",
      "--mode",
      "autonomous-pr",
      "--config",
      "config.toml",
    ]);

    expect(parsed).toMatchObject({
      command: "run",
      template: "source-to-project",
      staticTemplate: true,
      prompt: "Read source for secondbrain",
      source: "https://example.com/post",
      project: "weavekit",
      mode: "autonomous-pr",
      configPath: "config.toml",
      dryRun: false,
    });
  });

  it("parses verification-optimizer project selectors without an explicit prompt", () => {
    const parsed = parseWorkflowCliArgs([
      "workflow",
      "run",
      "--template",
      "verification-optimizer",
      "--project",
      "weavekit",
      "--mode",
      "advisory",
      "--config",
      "config.toml",
    ]);

    expect(parsed).toMatchObject({
      command: "run",
      template: "verification-optimizer",
      staticTemplate: true,
      project: "weavekit",
      mode: "advisory",
      configPath: "config.toml",
      dryRun: false,
    });
  });

  it("requires verification-optimizer project selectors", () => {
    expect(() =>
      parseWorkflowCliArgs(["workflow", "run", "--template", "verification-optimizer"]),
    ).toThrow("Missing required --project <id> or --project-path <path> argument.");
  });

  it("allows verification-optimizer project-path selectors in advisory plan mode", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-verification-optimizer-path-"));
    const outputRoot = join(rootDir, "runs");

    try {
      await expect(
        runWorkflowCli({
          command: "plan",
          outputDir: outputRoot,
          staticTemplate: true,
          dryRun: true,
          template: "verification-optimizer",
          projectPath: rootDir,
          mode: "advisory",
        }),
      ).resolves.toContain("Macro workflow plan:");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("blocks verification-optimizer autonomous PR mode for project-path selectors", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-verification-optimizer-path-"));

    try {
      await expect(
        runWorkflowCli({
          command: "run",
          outputDir: join(rootDir, "runs"),
          staticTemplate: true,
          dryRun: false,
          template: "verification-optimizer",
          projectPath: rootDir,
          mode: "autonomous-pr",
        }),
      ).rejects.toThrow("Autonomous PR mode is disabled for project path-override.");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("requires source-to-project project selectors", () => {
    expect(() =>
      parseWorkflowCliArgs([
        "workflow",
        "run",
        "--template",
        "source-to-project",
        "--source",
        "https://example.com/post",
      ]),
    ).toThrow("Missing required --project <id> or --project-path <path> argument.");
  });

  it("infers source-to-project sources from prompt URLs or source lines", () => {
    expect(inferSourceReferenceFromPrompt("Read https://example.com/post, then apply it.")).toBe(
      "https://example.com/post",
    );
    expect(inferSourceReferenceFromPrompt("Blog: ./docs/source-post.md\nProject: weavekit")).toBe(
      "./docs/source-post.md",
    );
  });

  it("parses dashboard subcommand args for a standalone viewer", () => {
    const parsed = parseWorkflowCliArgs([
      "workflow",
      "dashboard",
      "--port",
      "4321",
      "--watch-dir",
      "runs",
    ]);

    expect(parsed).toEqual({
      command: "dashboard",
      outputDir: "runs",
      staticTemplate: false,
      dryRun: false,
      noCache: false,
      dashboardPort: 4321,
      watchDir: "runs",
    });
  });

  it("parses a run that should publish to a separate dashboard server", () => {
    const parsed = parseWorkflowCliArgs([
      "workflow",
      "run",
      "--input",
      "question.md",
      "--dashboard-url",
      "http://127.0.0.1:4321",
    ]);

    expect(parsed).toEqual({
      command: "run",
      inputPath: "question.md",
      outputDir: "runs",
      staticTemplate: false,
      dryRun: false,
      noCache: false,
      dashboardUrl: "http://127.0.0.1:4321",
    });
  });

  it("treats dashboard-port as enabling a local run dashboard", () => {
    const parsed = parseWorkflowCliArgs([
      "workflow",
      "run",
      "--input",
      "question.md",
      "--dashboard-port",
      "4321",
    ]);

    expect(parsed).toEqual({
      command: "run",
      inputPath: "question.md",
      outputDir: "runs",
      staticTemplate: false,
      dryRun: false,
      noCache: false,
      dashboard: true,
      dashboardPort: 4321,
    });
  });

  it("formats a dry-run success message", () => {
    const message = formatWorkflowCliSuccessMessage({ outputDir: "runs/workflow" });
    expect(message).toContain("Macro workflow plan:");
    expect(message).toContain("runs/workflow");
  });

  it("prints token usage for dry-run planning calls", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-plan-usage-"));
    const outputRoot = join(rootDir, "runs");
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    try {
      await runWorkflowCli({
        command: "plan",
        prompt: "Plan model usage reporting",
        outputDir: outputRoot,
        staticTemplate: false,
        dryRun: true,
      });

      expect(stderrWrites.join("")).toContain(
        "Token usage: total 1,200 tokens, input 1,000, cached 100, output 200, estimated cost $0.01",
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("formats an initial run id message", () => {
    const message = formatWorkflowRunStartedMessage({
      runId: "run-123",
      outputDir: "runs/run-123",
    });

    expect(message).toContain("Workflow run id: run-123");
    expect(message).toContain("Workflow output: runs/run-123");
  });

  it("creates a friendly run descriptor under the output root", () => {
    const descriptor = createWorkflowRunDescriptor(
      "runs/latest",
      "ship replay dashboard follow mode",
    );

    expect(descriptor.outputDir).toMatch(/^runs\/[0-9a-f-]+$/);
    expect(descriptor.runName).toBe("Ship Replay Dashboard Follow Mode");
  });

  it("creates a resume descriptor that reuses the requested run directory", () => {
    expect(createWorkflowRunDescriptor("runs", "Persisted objective", "run-123")).toEqual({
      runId: "run-123",
      runName: "Persisted Objective",
      outputDir: join("runs", "run-123"),
    });
    expect(() => createWorkflowRunDescriptor("runs", "Objective", "../escape")).toThrow(
      "Invalid workflow run id",
    );
  });

  it("emits progress updates while a long-running workflow action is in flight", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const reporter = createWorkflowProgressReporter({
      write(chunk: string | Uint8Array) {
        writes.push(String(chunk));
        return true;
      },
    } as NodeJS.WritableStream);

    reporter.start("Planning workflow DAG", 10);
    vi.advanceTimersByTime(10);
    reporter.stop();

    expect(writes[0]).toContain("Planning workflow DAG");
    expect(writes.some((message) => message.includes("still working"))).toBe(true);
  });

  it("preprocesses X status URLs before workflow planning", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-x-preprocess-"));
    const outputRoot = join(rootDir, "runs");
    const binDir = join(rootDir, "bin");
    const grokPath = join(binDir, "grok");
    await mkdir(binDir);
    await writeFile(
      grokPath,
      "#!/bin/sh\nprintf '# X Post\\n\\nFetched planner content.\\n'\n",
      "utf8",
    );
    await chmod(grokPath, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = originalPath ? `${binDir}${delimiter}${originalPath}` : binDir;

    try {
      await runWorkflowCli({
        command: "plan",
        prompt: "Plan from https://x.com/alice/status/12345.",
        outputDir: outputRoot,
        staticTemplate: false,
        dryRun: true,
        noCache: true,
      });

      const call = workflowPlanner.planWorkflow.mock.calls[0]?.[0];
      expect(call?.prompt).toContain("## Resolved X Post Sources");
      expect(call?.prompt).toContain("### https://x.com/alice/status/12345");
      expect(call?.prompt).toContain("Fetched planner content.");
      expect(call?.objective).toContain("Fetched planner content.");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("prints progress while resolving X post URLs before the workflow run starts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-x-progress-"));
    const outputRoot = join(rootDir, "runs");
    const binDir = join(rootDir, "bin");
    const grokPath = join(binDir, "grok");
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    await mkdir(binDir);
    await writeFile(grokPath, "#!/bin/sh\nprintf '# X Post\\n\\nFetched content.\\n'\n", "utf8");
    await chmod(grokPath, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = originalPath ? `${binDir}${delimiter}${originalPath}` : binDir;

    try {
      await runWorkflowCli({
        command: "plan",
        prompt: "Summarize https://x.com/alice/status/12345",
        outputDir: outputRoot,
        staticTemplate: false,
        dryRun: true,
        noCache: true,
      });

      expect(stderrWrites[0]).toContain("Resolving 1 X post source with grok");
      expect(stderrWrites.some((message) => message.includes("X post source resolved."))).toBe(
        true,
      );
      expect(
        stderrWrites.findIndex((message) => message.includes("Resolving 1 X post source")),
      ).toBeLessThan(stderrWrites.findIndex((message) => message.includes("Workflow run id:")));
      expect(
        stderrWrites.findIndex((message) => message.includes("X post source resolved.")),
      ).toBeLessThan(stderrWrites.findIndex((message) => message.includes("Workflow run id:")));
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("runs a minimal X article summary workflow using preprocessed post content", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-x-summary-"));
    const outputRoot = join(rootDir, "runs");
    const binDir = join(rootDir, "bin");
    const grokPath = join(binDir, "grok");
    await mkdir(binDir);
    await writeFile(
      grokPath,
      [
        "#!/bin/sh",
        "printf '**Full article from the X post**\\n\\n**Author:** Henrikh (@henrikhinai)\\n\\n---\\n\\nThis X article argues for smaller workflow tests. It recommends one-node demos.\\n'",
      ].join("\n"),
      "utf8",
    );
    await chmod(grokPath, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = originalPath ? `${binDir}${delimiter}${originalPath}` : binDir;

    try {
      await runWorkflowCli({
        command: "run",
        prompt:
          "Summarize this X article https://x.com/henrikhinai/status/2065471716093010128?s=51",
        outputDir: outputRoot,
        staticTemplate: true,
        dryRun: false,
        template: "x-article-summary",
        noCache: true,
      });

      const [runDir] = await readdir(outputRoot);
      const state = await readFile(join(outputRoot, runDir!, "workflow-state.json"), "utf8");
      expect(state).toContain('"templateId": "x-article-summary"');
      expect(state).toContain('"id": "summarize-x-article"');
      expect(state).toContain("## Resolved X Post Sources");
      expect(state).toContain("https://x.com/henrikhinai/status/2065471716093010128?s=51");
      expect(state).toContain("Summary:");
      expect(state).toContain("Summary: This X article argues for smaller workflow tests");
      expect(state).not.toContain("Summary: **Full article from the X post**");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("writes state and replay artifacts for a plain static workflow run", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-"));
    const inputPath = join(rootDir, "question.md");
    const outputRoot = join(rootDir, "runs");
    await writeFile(inputPath, "Ship replay dashboard follow mode", "utf8");

    try {
      await runWorkflowCli({
        command: "run",
        inputPath,
        outputDir: outputRoot,
        staticTemplate: true,
        dryRun: false,
        template: "implementation-review",
      });

      const runDirs = await readdir(outputRoot);
      expect(runDirs).toHaveLength(1);
      const outputDir = join(outputRoot, runDirs[0]!);
      const state = await readFile(join(outputDir, "workflow-state.json"), "utf8");
      const events = await readFile(join(outputDir, "workflow-events.jsonl"), "utf8");

      expect(state).toContain('"status": "passed"');
      expect(state).toContain('"runName": "Ship Replay Dashboard Follow Mode"');
      expect(events).toContain('"kind":"planning-started"');
      expect(events).toContain('"kind":"run-completed"');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("resumes from persisted objective and current plan in the same run directory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-resume-"));
    const outputRoot = join(rootDir, "runs");
    const runId = "run-123";
    const outputDir = join(outputRoot, runId);
    const startedAt = new Date("2026-07-10T10:00:00.000Z");
    const currentPlan = {
      id: "persisted-plan",
      objective: "Persisted objective",
      templateId: "implementation-review",
      maxReplans: 0,
      nodes: [
        {
          id: "completed-research",
          kind: "research" as const,
          harness: WorkflowHarnessKind.RESEARCH,
          title: "Completed research",
          prompt: "Research",
          dependsOn: [],
          gates: ["output-contract" as const],
          writeMode: "read-only" as const,
          replanPolicy: "never" as const,
        },
        {
          id: "remaining-report",
          kind: "report" as const,
          harness: WorkflowHarnessKind.REPORTER,
          title: "Remaining report",
          prompt: "Report",
          dependsOn: ["completed-research"],
          gates: ["output-contract" as const],
          writeMode: "read-only" as const,
          replanPolicy: "never" as const,
        },
      ],
    };
    const initialState: MacroWorkflowRunState = {
      runId,
      runName: "Persisted Run",
      planId: currentPlan.id,
      objective: currentPlan.objective,
      templateId: currentPlan.templateId,
      status: "running",
      startedAt,
      plan: currentPlan,
      currentPlan,
      nodeResults: [
        {
          nodeId: "completed-research",
          status: "passed",
          output: "already complete",
          payload: { evidence: true },
        },
        {
          nodeId: "remaining-report",
          status: "failed",
          output: "interrupted",
          error: "process exited",
        },
      ],
      replans: [],
    };
    await new MacroWorkflowStateStore(outputDir).write(initialState);
    const priorReplayEvents = [
      {
        seq: 7,
        ts: "2026-07-10T10:00:00.000Z",
        kind: "planning-started",
        phase: "planning",
      },
      {
        seq: 8,
        ts: "2026-07-10T10:00:01.000Z",
        kind: "planning-complete",
        phase: "running",
      },
    ];
    await writeFile(
      join(outputDir, "workflow-events.jsonl"),
      `${priorReplayEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    try {
      await runWorkflowCli({
        command: "run",
        outputDir: outputRoot,
        staticTemplate: false,
        dryRun: false,
        resumeRunId: runId,
      });

      expect(workflowPlanner.planWorkflow).not.toHaveBeenCalled();
      expect(await readdir(outputRoot)).toEqual([runId]);
      const resumed = await new MacroWorkflowStateStore(outputDir).read();
      expect(resumed.runId).toBe(runId);
      expect(resumed.runName).toBe("Persisted Run");
      expect(resumed.objective).toBe("Persisted objective");
      expect(resumed.startedAt).toEqual(startedAt);
      expect(resumed.status).toBe("passed");
      expect(resumed.nodeResults.map((result) => [result.nodeId, result.status])).toEqual([
        ["completed-research", "passed"],
        ["remaining-report", "passed"],
      ]);
      const replayEvents = (await readFile(join(outputDir, "workflow-events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { seq: number; kind: string });
      expect(replayEvents.slice(0, priorReplayEvents.length)).toEqual(priorReplayEvents);
      expect(replayEvents[priorReplayEvents.length]?.seq).toBe(9);
      expect(replayEvents.at(-1)?.kind).toBe("run-completed");
      const replaySeqs = replayEvents.map((event) => event.seq);
      expect(replaySeqs).toEqual([...replaySeqs].sort((left, right) => left - right));
      expect(new Set(replaySeqs).size).toBe(replaySeqs.length);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reconstructs source-to-project runtime context and rejects conflicting resume flags", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-source-resume-"));
    const outputRoot = join(rootDir, "runs");
    const runId = "source-run";
    const outputDir = join(outputRoot, runId);
    const currentPlan = createResumePlan("source-to-project", WorkflowHarnessKind.REPORTER);
    const project = createResumeProject(rootDir);
    const state: MacroWorkflowRunState = {
      runId,
      runName: "Source Resume",
      planId: currentPlan.id,
      objective: currentPlan.objective,
      templateId: currentPlan.templateId,
      status: "running",
      startedAt: new Date("2026-07-10T10:00:00.000Z"),
      plan: currentPlan,
      currentPlan,
      nodeResults: [
        {
          nodeId: "remaining-node",
          status: "failed",
          output: "interrupted",
          error: "process exited",
        },
      ],
      replans: [],
      resumeContext: {
        version: 1,
        templateId: "source-to-project",
        source: "https://example.com/source",
        project: "weavekit",
        mode: "advisory",
        resolvedProject: project,
        sourceToProject: {
          maxOpportunities: 2,
          thresholds: {
            minApplicability: 0.81,
            minConfidence: 0.82,
            minImpact: 0.83,
            minAcceptanceAverage: 0.84,
            maxRisk: 0.25,
          },
          offline: true,
          autoImplementOnReport: false,
        },
      },
    };
    await new MacroWorkflowStateStore(outputDir).write(state);

    try {
      await runWorkflowCli({
        command: "run",
        outputDir: outputRoot,
        staticTemplate: false,
        dryRun: false,
        resumeRunId: runId,
      });

      expect(sourceToProjectHarnesses.createSourceToProjectHarnessRegistry).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "https://example.com/source",
          project,
          mode: "advisory",
          maxOpportunities: 2,
          thresholds: expect.objectContaining({ minApplicability: 0.81, maxRisk: 0.25 }),
          sourceToProject: expect.objectContaining({ offline: true }),
        }),
      );

      await expect(
        runWorkflowCli({
          command: "run",
          outputDir: outputRoot,
          staticTemplate: true,
          dryRun: false,
          resumeRunId: runId,
          template: "source-to-project",
          project: "different-project",
        }),
      ).rejects.toThrow(
        "Resume flag --project conflicts with persisted workflow context: expected weavekit",
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reconstructs deep-research settings and rejects conflicting resume overrides", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-deep-resume-"));
    const outputRoot = join(rootDir, "runs");
    const runId = "deep-run";
    const outputDir = join(outputRoot, runId);
    const currentPlan = createResumePlan("deep-research", WorkflowHarnessKind.RESEARCH);
    const persistedDeepResearch: DeepResearchDefaults = {
      providers: ["grok", "copilot-last30days"],
      maxIterations: 4,
      questionsPerIteration: 5,
      maxResultsPerQuestion: 6,
      providerRetryAttempts: 2,
      visualize: false,
    };
    const state: MacroWorkflowRunState = {
      runId,
      runName: "Deep Resume",
      planId: currentPlan.id,
      objective: currentPlan.objective,
      templateId: currentPlan.templateId,
      status: "running",
      startedAt: new Date("2026-07-10T10:00:00.000Z"),
      plan: currentPlan,
      currentPlan,
      nodeResults: [
        {
          nodeId: "remaining-node",
          status: "failed",
          output: "interrupted",
          error: "process exited",
        },
      ],
      replans: [],
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        estimatedCostUsd: 0.0011,
        unpricedModels: [],
        records: [
          {
            id: "usage-1",
            executor: "copilot-sdk",
            label: "Persisted research",
            model: "gpt-5.5",
            nodeId: "completed-node",
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            estimatedCostUsd: 0.0011,
          },
        ],
      },
      resumeContext: {
        version: 1,
        templateId: "deep-research",
        deepResearch: persistedDeepResearch,
      },
    };
    await new MacroWorkflowStateStore(outputDir).write(state);
    deepResearchHarnesses.createDefaultDeepResearchExaMcpConnection.mockResolvedValue({
      client: { web_search_exa: vi.fn() },
      close: vi.fn(async () => {}),
    });
    deepResearchHarnesses.createDeepResearchHarnessRegistry.mockReturnValue(
      createStaticHarnessRegistry({
        [WorkflowHarnessKind.RESEARCH]: async () => ({ status: "passed", output: "resumed" }),
      }),
    );
    sourceToProjectHarnesses.createCopilotSdkHarnessClient.mockImplementationOnce(
      (options: {
        onUsage?: (event: {
          operation: string;
          mode: string;
          model: string;
          cwd: string;
          nodeId: string;
          label: string;
          usage: { inputTokens: number; outputTokens: number };
        }) => void;
      }) => {
        options.onUsage?.({
          operation: "resume-research",
          mode: "research",
          model: "gpt-5.5",
          cwd: rootDir,
          nodeId: "remaining-node",
          label: "Resumed research",
          usage: { inputTokens: 200, outputTokens: 40 },
        });
        return { model: "fake-copilot", run: vi.fn(async () => "fake copilot output") };
      },
    );

    try {
      await runWorkflowCli({
        command: "run",
        outputDir: outputRoot,
        staticTemplate: false,
        dryRun: false,
        resumeRunId: runId,
      });

      expect(deepResearchHarnesses.createDeepResearchHarnessRegistry).toHaveBeenCalledWith(
        expect.objectContaining({ config: persistedDeepResearch }),
      );
      const resumed = await new MacroWorkflowStateStore(outputDir).read();
      expect(resumed.usage).toMatchObject({
        inputTokens: 300,
        outputTokens: 60,
        totalTokens: 360,
        estimatedCostUsd: 0.0033,
        records: [
          { id: "usage-1", label: "Persisted research" },
          { id: "usage-2", label: "Resumed research" },
        ],
      });
      expect(nodeCostHistory.recordNodeCostHistoryFromUsage).toHaveBeenCalledWith({
        summary: resumed.usage,
      });

      await expect(
        runWorkflowCli({
          command: "run",
          outputDir: outputRoot,
          staticTemplate: false,
          dryRun: false,
          resumeRunId: runId,
          deepResearch: { providers: ["exa"] },
        }),
      ).rejects.toThrow(
        "Resume flag --providers conflicts with persisted workflow context: expected grok,copilot-last30days",
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("persists the effective deep-research context when a run is created", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-deep-context-"));
    const outputRoot = join(rootDir, "runs");
    const deepResearch: DeepResearchDefaults = {
      providers: ["grok"],
      maxIterations: 3,
      questionsPerIteration: 4,
      maxResultsPerQuestion: 5,
      providerRetryAttempts: 2,
      visualize: false,
    };
    try {
      await runWorkflowCli({
        command: "run",
        prompt: "Research durable contexts",
        outputDir: outputRoot,
        staticTemplate: true,
        dryRun: true,
        template: "deep-research",
        deepResearch,
      });

      const [runId] = await readdir(outputRoot);
      const state = await new MacroWorkflowStateStore(join(outputRoot, runId!)).read();
      expect(state.resumeContext).toEqual({
        version: 1,
        templateId: "deep-research",
        deepResearch,
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("requires explicit legacy source context and upgrades it after a safe resume", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-source-legacy-"));
    const outputRoot = join(rootDir, "runs");
    const runId = "legacy-source";
    const outputDir = join(outputRoot, runId);
    const currentPlan = createResumePlan("source-to-project", WorkflowHarnessKind.REPORTER);
    await new MacroWorkflowStateStore(outputDir).write({
      runId,
      planId: currentPlan.id,
      objective: currentPlan.objective,
      templateId: currentPlan.templateId,
      status: "running",
      startedAt: new Date("2026-07-10T10:00:00.000Z"),
      plan: currentPlan,
      currentPlan,
      nodeResults: [],
      replans: [],
    });

    try {
      await expect(
        runWorkflowCli({
          command: "run",
          outputDir: outputRoot,
          staticTemplate: false,
          dryRun: false,
          resumeRunId: runId,
        }),
      ).rejects.toThrow(
        "Required flags: --source <url-or-path>, --project <id> or --project-path <path>, --mode <advisory|autonomous-pr>",
      );

      await runWorkflowCli({
        command: "run",
        outputDir: outputRoot,
        staticTemplate: false,
        dryRun: false,
        resumeRunId: runId,
        source: "https://example.com/legacy-source",
        projectPath: rootDir,
        mode: "advisory",
      });

      const upgraded = await new MacroWorkflowStateStore(outputDir).read();
      expect(upgraded.resumeContext).toMatchObject({
        version: 1,
        templateId: "source-to-project",
        source: "https://example.com/legacy-source",
        projectPath: rootDir,
        mode: "advisory",
        resolvedProject: { workingTree: rootDir },
        sourceToProject: expect.any(Object),
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("requires all effective deep-research flags to resume a legacy snapshot", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-deep-legacy-"));
    const outputRoot = join(rootDir, "runs");
    const runId = "legacy-deep";
    const outputDir = join(outputRoot, runId);
    const currentPlan = createResumePlan("deep-research", WorkflowHarnessKind.RESEARCH);
    await new MacroWorkflowStateStore(outputDir).write({
      runId,
      planId: currentPlan.id,
      objective: currentPlan.objective,
      templateId: currentPlan.templateId,
      status: "running",
      startedAt: new Date("2026-07-10T10:00:00.000Z"),
      plan: currentPlan,
      currentPlan,
      nodeResults: [],
      replans: [],
    });
    deepResearchHarnesses.createDefaultDeepResearchExaMcpConnection.mockResolvedValue({
      client: { web_search_exa: vi.fn() },
      close: vi.fn(async () => {}),
    });
    deepResearchHarnesses.createDeepResearchHarnessRegistry.mockReturnValue(
      createStaticHarnessRegistry({
        [WorkflowHarnessKind.RESEARCH]: async () => ({ status: "passed", output: "resumed" }),
      }),
    );
    const deepResearch: DeepResearchDefaults = {
      providers: ["grok"],
      maxIterations: 3,
      questionsPerIteration: 4,
      maxResultsPerQuestion: 5,
      providerRetryAttempts: 2,
      visualize: false,
    };

    try {
      await expect(
        runWorkflowCli({
          command: "run",
          outputDir: outputRoot,
          staticTemplate: false,
          dryRun: false,
          resumeRunId: runId,
          deepResearch: { providers: ["grok"] },
        }),
      ).rejects.toThrow("Required deep-research flags: --max-iterations");

      await runWorkflowCli({
        command: "run",
        outputDir: outputRoot,
        staticTemplate: false,
        dryRun: false,
        resumeRunId: runId,
        deepResearch,
      });
      const upgraded = await new MacroWorkflowStateStore(outputDir).read();
      expect(upgraded.resumeContext?.deepResearch).toEqual(deepResearch);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports a useful error when the requested resume snapshot is unavailable", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-resume-missing-"));
    try {
      await expect(
        runWorkflowCli({
          command: "run",
          outputDir: join(rootDir, "runs"),
          staticTemplate: false,
          dryRun: false,
          resumeRunId: "missing-run",
        }),
      ).rejects.toThrow("Cannot resume workflow missing-run: failed to read workflow-state.json");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("writes final token usage into state for a planned workflow run", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-run-usage-"));
    const outputRoot = join(rootDir, "runs");

    try {
      await runWorkflowCli({
        command: "run",
        prompt: "Ship usage state",
        outputDir: outputRoot,
        staticTemplate: false,
        dryRun: false,
      });

      const runDirs = await readdir(outputRoot);
      const state = await readFile(join(outputRoot, runDirs[0]!, "workflow-state.json"), "utf8");

      expect(state).toContain('"totalTokens": 1200');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("prints the workflow run id before planning progress", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-"));
    const inputPath = join(rootDir, "question.md");
    const outputRoot = join(rootDir, "runs");
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    await writeFile(inputPath, "Ship visible run id", "utf8");

    try {
      await runWorkflowCli({
        command: "run",
        inputPath,
        outputDir: outputRoot,
        staticTemplate: true,
        dryRun: false,
        template: "implementation-review",
      });

      expect(stderrWrites[0]).toContain("[weavekit] Workflow run id:");
      expect(stderrWrites[0]).toContain("[weavekit] Workflow output:");
      expect(
        stderrWrites.findIndex((message) => message.includes("Workflow run id:")),
      ).toBeLessThan(
        stderrWrites.findIndex((message) => message.includes("Planning workflow DAG")),
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

function createResumePlan(
  templateId: "source-to-project" | "deep-research",
  harness: typeof WorkflowHarnessKind.REPORTER | typeof WorkflowHarnessKind.RESEARCH,
) {
  return {
    id: `${templateId}-resume-plan`,
    objective: `Resume ${templateId}`,
    templateId,
    maxReplans: 0,
    nodes: [
      {
        id: "remaining-node",
        kind:
          harness === WorkflowHarnessKind.REPORTER ? ("report" as const) : ("research" as const),
        harness,
        title: "Remaining node",
        prompt: "Continue",
        dependsOn: [],
        gates: ["output-contract" as const],
        writeMode: "read-only" as const,
        replanPolicy: "never" as const,
      },
    ],
  };
}

function createResumeProject(workingTree: string) {
  return {
    id: "weavekit",
    displayName: "Weavekit",
    workingTree,
    mainline: "origin main",
    remote: "origin",
    contextDocs: ["CONTEXT.md"],
    validationCommands: ["nub run test"],
    autonomousPrAllowed: false,
    notification: "cli" as const,
    knowledgeExport: "off" as const,
  };
}
