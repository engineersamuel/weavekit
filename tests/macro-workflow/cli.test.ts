import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    planWorkflow = workflowPlanner.planWorkflow;
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

beforeEach(() => {
  entityValidation.assertValidEntityCatalog.mockReset();
  entityValidation.assertValidEntityCatalog.mockImplementation(() => {});
  workflowPlanner.planWorkflow.mockClear();
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
