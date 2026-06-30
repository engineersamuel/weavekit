#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadWeavekitConfig } from "./config.js";
import { DecisionCouncilRunFailedError } from "./decision-council/errors.js";
import type { DecisionCouncilInput } from "./decision-council/types.js";
import type { DecisionCouncilLogger } from "./decision-council/logger.js";
import type { TelemetryHandle } from "./telemetry/bootstrap.js";
import type { WorkflowPlanTemplateId } from "./macro-workflow/types.js";

export type LogFormat = "pretty" | "json" | "silent";

const noopTelemetryHandle: TelemetryHandle = {
  async shutdown() {},
};

export type DecisionCouncilCliArgs = {
  inputPath: string;
  outputDir: string;
  logFormat: LogFormat;
  personaSetName?: string;
  maxRounds?: number;
  smoke: boolean;
};

export type WorkflowCliArgs = {
  command: "plan" | "run";
  inputPath: string;
  outputDir: string;
  staticTemplate: boolean;
  dryRun: boolean;
  template?: string;
};

export function parseDecisionCouncilCliArgs(argv: string[]): DecisionCouncilCliArgs {
  if (argv[0] !== "decision-council" || argv[1] !== "run") {
    throw new Error(
      "Usage: weavekit decision-council run --input <path> [--output <dir>] [--persona-set <name>] [--max-rounds <n>] [--smoke] [--log-format <pretty|json|silent>] (omit --persona-set for dynamic persona selection; provide --persona-set <name> for deterministic static selection.)",
    );
  }

  const inputIndex = argv.indexOf("--input");
  if (inputIndex === -1 || !argv[inputIndex + 1]) {
    throw new Error("Missing required --input <path> argument.");
  }

  const outputIndex = argv.indexOf("--output");
  const logFormatIndex = argv.indexOf("--log-format");
  const logFormat = logFormatIndex === -1 ? "pretty" : argv[logFormatIndex + 1];

  if (logFormat !== "pretty" && logFormat !== "json" && logFormat !== "silent") {
    throw new Error("Invalid --log-format value. Expected pretty, json, or silent.");
  }

  const personaSetIndex = argv.indexOf("--persona-set");
  if (personaSetIndex !== -1 && !argv[personaSetIndex + 1]) {
    throw new Error("Missing value for --persona-set <name>.");
  }

  const smoke = argv.includes("--smoke");

  const maxRoundsIndex = argv.indexOf("--max-rounds");
  if (maxRoundsIndex !== -1 && !argv[maxRoundsIndex + 1]) {
    throw new Error("Missing value for --max-rounds <n>.");
  }
  let maxRounds = maxRoundsIndex === -1 ? undefined : Number(argv[maxRoundsIndex + 1]);
  if (maxRounds !== undefined && (!Number.isInteger(maxRounds) || maxRounds < 1)) {
    throw new Error("Invalid --max-rounds value. Expected a positive integer.");
  }

  // --smoke is a preset: default to the lightweight 2-persona smoke set and a single round.
  const personaSetName = personaSetIndex !== -1 ? argv[personaSetIndex + 1] : smoke ? "smoke" : undefined;
  if (smoke && maxRounds === undefined) {
    maxRounds = 1;
  }

  return {
    inputPath: argv[inputIndex + 1]!,
    outputDir: outputIndex === -1 ? "runs/latest" : argv[outputIndex + 1] ?? "runs/latest",
    logFormat,
    personaSetName,
    maxRounds,
    smoke,
  };
}

export function parseWorkflowCliArgs(argv: string[]): WorkflowCliArgs {
  if (argv[0] !== "workflow") {
    throw new Error("Usage: weavekit workflow <plan|run> --input <path> [--output <dir>] [--template <id>] [--dry-run]");
  }

  const command = argv[1];
  if (command !== "plan" && command !== "run") {
    throw new Error("Usage: weavekit workflow <plan|run> --input <path> [--output <dir>] [--template <id>] [--dry-run]");
  }

  const inputIndex = argv.indexOf("--input");
  if (inputIndex === -1 || !argv[inputIndex + 1]) {
    throw new Error("Missing required --input <path> argument.");
  }

  const outputIndex = argv.indexOf("--output");
  const templateIndex = argv.indexOf("--template");
  if (templateIndex !== -1 && !argv[templateIndex + 1]) {
    throw new Error("Missing value for --template <id>.");
  }
  const template = templateIndex === -1 ? undefined : argv[templateIndex + 1];
  const dryRun = command === "plan" || argv.includes("--dry-run");

  return {
    command,
    inputPath: argv[inputIndex + 1]!,
    outputDir: outputIndex === -1 ? "runs/latest" : argv[outputIndex + 1] ?? "runs/latest",
    staticTemplate: template !== undefined,
    dryRun,
    ...(template !== undefined ? { template } : {}),
  };
}

export async function readDecisionCouncilInputFile(inputPath: string): Promise<DecisionCouncilInput> {
  const prompt = await readFile(inputPath, "utf8");
  return { prompt, context: [], constraints: [] };
}

export function formatDecisionCouncilSuccessMessage(args: { recommendation: string; outputDir: string }): string {
  return [
    args.recommendation,
    `Markdown report: ${join(args.outputDir, "DecisionCouncilReport.md")}`,
    `Artifacts written to ${args.outputDir}`,
    "",
  ].join("\n");
}

export async function createDecisionCouncilLogger(format: LogFormat): Promise<DecisionCouncilLogger> {
  const { createConsoleDecisionCouncilLogger, createJsonDecisionCouncilLogger, createSilentDecisionCouncilLogger } = await import("./decision-council/logger.js");
  if (format === "json") return createJsonDecisionCouncilLogger();
  if (format === "silent") return createSilentDecisionCouncilLogger();
  return createConsoleDecisionCouncilLogger();
}

export function formatWorkflowCliSuccessMessage(args: { outputDir: string }): string {
  return [`Macro workflow plan: ${args.outputDir}`, ""].join("\n");
}

function resolveWorkflowTemplateId(template: string | undefined): WorkflowPlanTemplateId | undefined {
  if (template === undefined) {
    return undefined;
  }
  if (template !== "implementation-review") {
    throw new Error(`Unknown workflow template: ${template}`);
  }
  return template;
}

export function createWorkflowProgressReporter(stream: Pick<NodeJS.WritableStream, "write"> = process.stderr) {
  let timer: NodeJS.Timeout | undefined;

  return {
    start(message: string, intervalMs = 10000) {
      if (timer) {
        clearInterval(timer);
      }
      stream.write(`[weavekit] ${message}\n`);
      timer = setInterval(() => {
        stream.write(`[weavekit] still working... ${message}\n`);
      }, intervalMs);
    },
    stop(finalMessage?: string) {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (finalMessage) {
        stream.write(`[weavekit] ${finalMessage}\n`);
      }
    },
  };
}

export async function runWorkflowCli(args: WorkflowCliArgs): Promise<string> {
  loadWeavekitConfig();
  const prompt = await readFile(args.inputPath, "utf8");
  const objective = prompt.trim() || "Macro workflow";
  const [workflowArtifactsModule, workflowBamlAdapterModule, workflowHarnessModule, workflowLoggerModule, workflowRunnerModule, workflowTemplatesModule] = await Promise.all([
    import("./macro-workflow/artifacts.js"),
    import("./macro-workflow/bamlAdapters.js"),
    import("./macro-workflow/harness.js"),
    import("./macro-workflow/logger.js"),
    import("./macro-workflow/runner.js"),
    import("./macro-workflow/templates.js"),
  ]);
  const planner = new workflowBamlAdapterModule.GeneratedWorkflowPlannerAdapter();
  const templateId = resolveWorkflowTemplateId(args.template);
  const progress = createWorkflowProgressReporter();
  let plan;

  progress.start("Planning workflow DAG with the BAML planner...");
  try {
    plan = templateId
      ? workflowTemplatesModule.materializeWorkflowPlan(templateId, { objective })
      : await planner.planWorkflow({ objective, prompt, templateId: "implementation-review" });
    progress.stop("Workflow plan generated.");
  } catch (error) {
    progress.stop();
    throw error;
  }

  if (args.command === "plan" || args.dryRun) {
    await workflowArtifactsModule.writeMacroWorkflowArtifacts({ outputDir: args.outputDir, state: {
      planId: plan.id,
      objective: plan.objective,
      templateId: plan.templateId,
      status: "passed",
      startedAt: new Date(),
      completedAt: new Date(),
      plan,
      currentPlan: plan,
      nodeResults: [],
      replans: [],
    }});
    return formatWorkflowCliSuccessMessage({ outputDir: args.outputDir });
  }

  const state = await workflowRunnerModule.runMacroWorkflow(plan, {
    harnesses: workflowHarnessModule.createStaticHarnessRegistry(),
    logger: workflowLoggerModule.createInMemoryMacroWorkflowLogger(),
  });
  await workflowArtifactsModule.writeMacroWorkflowArtifacts({ outputDir: args.outputDir, state });
  return formatWorkflowCliSuccessMessage({ outputDir: args.outputDir });
}

export async function main(): Promise<void> {
  loadWeavekitConfig();

  let telemetry: TelemetryHandle = noopTelemetryHandle;
  try {
    const { startTelemetry } = await import("./telemetry/bootstrap.js");
    telemetry = await startTelemetry("weavekit");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Telemetry startup failed: ${message}\n`);
  }

  try {
    const argv = process.argv.slice(2);
    if (argv[0] === "workflow") {
      const workflowArgs = parseWorkflowCliArgs(argv);
      const message = await runWorkflowCli(workflowArgs);
      process.stdout.write(message);
    } else {
      const { DecisionCouncilRunFailedError } = await import("./decision-council/errors.js");
      const { createSmokeModelRouter } = await import("./decision-council/modelRouter.js");
      const { runDecisionCouncil } = await import("./decision-council/runner.js");
      const args = parseDecisionCouncilCliArgs(argv);
      const input = await readDecisionCouncilInputFile(args.inputPath);
      const report = await runDecisionCouncil(input, {
        outputDir: args.outputDir,
        inputPath: args.inputPath,
        personaSetName: args.personaSetName,
        maxRounds: args.maxRounds,
        router: args.smoke ? createSmokeModelRouter() : undefined,
        logger: await createDecisionCouncilLogger(args.logFormat),
      });

      process.stdout.write(formatDecisionCouncilSuccessMessage({ recommendation: report.recommendation, outputDir: args.outputDir }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof DecisionCouncilRunFailedError ? error.exitCode : 1;
  } finally {
    try {
      await telemetry.shutdown();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Telemetry shutdown failed: ${message}\n`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof DecisionCouncilRunFailedError ? error.exitCode : 1;
  });
}
