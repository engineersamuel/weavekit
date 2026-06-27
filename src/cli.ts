#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runDecisionCouncil } from "./decision-council/runner.js";
import { DecisionCouncilRunFailedError } from "./decision-council/errors.js";
import { createSmokeModelRouter } from "./decision-council/modelRouter.js";
import { createConsoleDecisionCouncilLogger, createJsonDecisionCouncilLogger, createSilentDecisionCouncilLogger, type DecisionCouncilLogger } from "./decision-council/logger.js";
import type { DecisionCouncilInput } from "./decision-council/types.js";
import { startTelemetry, type TelemetryHandle } from "./telemetry/bootstrap.js";
import { runWorkQueueCli } from "./work-queue/cli.js";
import { BeadsCliWorkQueue } from "./work-queue/beads.js";
import { WorkQueueBackendError } from "./work-queue/backend.js";
import { createDecisionCouncilBeadsWorkflow } from "./work-queue/decisionCouncilWorkflow.js";
import { serializeWorkItemWorkflowDag } from "./work-queue/telemetry.js";

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
  workItemId?: string;
  claimWorkItem: boolean;
  closeWorkItem: boolean;
  createFollowUpWorkItem: boolean;
  syncWorkQueue: boolean;
  createBeadsWorkflow: boolean;
};

export function parseDecisionCouncilCliArgs(argv: string[]): DecisionCouncilCliArgs {
  if (argv[0] !== "decision-council" || argv[1] !== "run") {
    throw new Error(
      "Usage: weavekit decision-council run --input <path> [--output <dir>] [--persona-set <name>] [--max-rounds <n>] [--smoke] [--work-item <id>] [--claim-work-item] [--close-work-item] [--create-follow-up-work-item] [--sync-work-queue] [--create-beads-workflow] [--log-format <pretty|json|silent>] (omit --persona-set for dynamic persona selection; provide --persona-set <name> for deterministic static selection.)",
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

  const workItemIndex = argv.indexOf("--work-item");
  if (workItemIndex !== -1 && !argv[workItemIndex + 1]) {
    throw new Error("Missing value for --work-item <id>.");
  }
  const workItemId = workItemIndex === -1 ? undefined : argv[workItemIndex + 1];

  const claimWorkItem = argv.includes("--claim-work-item");
  const closeWorkItem = argv.includes("--close-work-item");
  const createFollowUpWorkItem = argv.includes("--create-follow-up-work-item");
  const syncWorkQueue = argv.includes("--sync-work-queue");
  const createBeadsWorkflow = argv.includes("--create-beads-workflow");

  if ((claimWorkItem || closeWorkItem || createFollowUpWorkItem) && !workItemId) {
    throw new Error("--claim-work-item, --close-work-item, and --create-follow-up-work-item require --work-item <id>.");
  }

  if (syncWorkQueue && !workItemId && !createBeadsWorkflow) {
    throw new Error("--sync-work-queue requires --work-item <id> or --create-beads-workflow.");
  }

  if (createBeadsWorkflow && workItemId) {
    throw new Error("--work-item <id> and --create-beads-workflow are mutually exclusive.");
  }

  return {
    inputPath: argv[inputIndex + 1]!,
    outputDir: outputIndex === -1 ? "runs/latest" : argv[outputIndex + 1] ?? "runs/latest",
    logFormat,
    personaSetName,
    maxRounds,
    smoke,
    workItemId,
    claimWorkItem,
    closeWorkItem,
    createFollowUpWorkItem,
    syncWorkQueue,
    createBeadsWorkflow,
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

export function createDecisionCouncilLogger(format: LogFormat): DecisionCouncilLogger {
  if (format === "json") return createJsonDecisionCouncilLogger();
  if (format === "silent") return createSilentDecisionCouncilLogger();
  return createConsoleDecisionCouncilLogger();
}

export function formatWorkQueueBackendError(error: WorkQueueBackendError): string {
  const lines: string[] = [error.message];
  const details = error.causeDetails as Record<string, unknown> | undefined;
  if (details !== null && typeof details === "object") {
    if (typeof details["exitCode"] === "number") {
      lines.push(`exit code: ${details["exitCode"]}`);
    }
    if (typeof details["stdout"] === "string" && details["stdout"]) {
      lines.push(`stdout: ${details["stdout"]}`);
    }
    if (typeof details["stderr"] === "string" && details["stderr"]) {
      lines.push(`stderr: ${details["stderr"]}`);
    }
  }
  return lines.join("\n");
}

export async function main(): Promise<void> {
  let telemetry: TelemetryHandle = noopTelemetryHandle;
  try {
    telemetry = await startTelemetry("weavekit");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Telemetry startup failed: ${message}\n`);
  }

  try {
    const argv = process.argv.slice(2);
    if (argv[0] === "work") {
      await runWorkQueueCli(argv.slice(1));
      return;
    }

    const args = parseDecisionCouncilCliArgs(argv);
    const input = await readDecisionCouncilInputFile(args.inputPath);
    const backend = args.workItemId || args.createBeadsWorkflow
      ? new BeadsCliWorkQueue({ cwd: process.cwd() })
      : undefined;
    const generatedWorkflow = args.createBeadsWorkflow && backend
      ? await createDecisionCouncilBeadsWorkflow({
          backend,
          title: input.prompt.split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "").slice(0, 80) ?? "Decision Council run",
          inputPath: args.inputPath,
          outputDir: args.outputDir,
        })
      : undefined;
    const activeWorkItemId = args.workItemId ?? generatedWorkflow?.runItem.id;
    const workQueue = backend && activeWorkItemId
      ? {
          backend,
          workItemId: activeWorkItemId,
          claimOnStart: args.claimWorkItem || args.createBeadsWorkflow,
          closeOnSuccess: args.closeWorkItem || args.createBeadsWorkflow,
          createFollowUp: args.workItemId ? args.createFollowUpWorkItem : false,
          syncOnComplete: args.syncWorkQueue,
        }
      : undefined;
    const workQueueWorkflowDag = generatedWorkflow
      ? serializeWorkItemWorkflowDag({
          rootItemId: generatedWorkflow.rootItem.id,
          activeItemId: generatedWorkflow.runItem.id,
          items: generatedWorkflow.items,
        })
      : undefined;
    const report = await runDecisionCouncil(input, {
      outputDir: args.outputDir,
      inputPath: args.inputPath,
      personaSetName: args.personaSetName,
      maxRounds: args.maxRounds,
      router: args.smoke ? createSmokeModelRouter() : undefined,
      logger: createDecisionCouncilLogger(args.logFormat),
      workQueue,
      workQueueWorkflowDag,
    });

    process.stdout.write(formatDecisionCouncilSuccessMessage({ recommendation: report.recommendation, outputDir: args.outputDir }));
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
    const message =
      error instanceof WorkQueueBackendError
        ? formatWorkQueueBackendError(error)
        : error instanceof Error
          ? error.message
          : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof DecisionCouncilRunFailedError ? error.exitCode : 1;
  });
}
