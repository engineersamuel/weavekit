#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runDecisionCouncil } from "./decision-council/runner.js";
import { DecisionCouncilRunFailedError } from "./decision-council/errors.js";
import { createSmokeModelRouter } from "./decision-council/modelRouter.js";
import { createConsoleDecisionCouncilLogger, createJsonDecisionCouncilLogger, createSilentDecisionCouncilLogger, type DecisionCouncilLogger } from "./decision-council/logger.js";
import type { DecisionCouncilInput } from "./decision-council/types.js";
import { startTelemetry } from "./telemetry/bootstrap.js";

export type LogFormat = "pretty" | "json" | "silent";

export type DecisionCouncilCliArgs = {
  inputPath: string;
  outputDir: string;
  logFormat: LogFormat;
  personaSetName?: string;
  maxRounds?: number;
  smoke: boolean;
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

async function main(): Promise<void> {
  const telemetry = await startTelemetry("weavekit");
  try {
    const args = parseDecisionCouncilCliArgs(process.argv.slice(2));
    const input = await readDecisionCouncilInputFile(args.inputPath);
    const report = await runDecisionCouncil(input, {
      outputDir: args.outputDir,
      inputPath: args.inputPath,
      personaSetName: args.personaSetName,
      maxRounds: args.maxRounds,
      router: args.smoke ? createSmokeModelRouter() : undefined,
      logger: createDecisionCouncilLogger(args.logFormat),
    });

    process.stdout.write(formatDecisionCouncilSuccessMessage({ recommendation: report.recommendation, outputDir: args.outputDir }));
  } finally {
    await telemetry.shutdown();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof DecisionCouncilRunFailedError ? error.exitCode : 1;
  });
}
