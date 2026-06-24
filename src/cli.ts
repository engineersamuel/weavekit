#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCouncil } from "./council/runner.js";
import { CouncilRunFailedError } from "./council/errors.js";
import { createConsoleCouncilLogger, createJsonCouncilLogger, createSilentCouncilLogger, type CouncilLogger } from "./council/logger.js";
import type { CouncilInput } from "./council/types.js";

export type LogFormat = "pretty" | "json" | "silent";

export type CouncilCliArgs = {
  inputPath: string;
  outputDir: string;
  logFormat: LogFormat;
};

export function parseCouncilCliArgs(argv: string[]): CouncilCliArgs {
  if (argv[0] !== "council" || argv[1] !== "run") {
    throw new Error("Usage: weavekit council run --input <path> [--output <dir>]");
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

  return {
    inputPath: argv[inputIndex + 1]!,
    outputDir: outputIndex === -1 ? "runs/latest" : argv[outputIndex + 1] ?? "runs/latest",
    logFormat,
  };
}

export async function readCouncilInputFile(inputPath: string): Promise<CouncilInput> {
  const prompt = await readFile(inputPath, "utf8");
  return { prompt, context: [], constraints: [] };
}

export function formatCouncilSuccessMessage(args: { recommendation: string; outputDir: string }): string {
  return [
    args.recommendation,
    `Markdown report: ${join(args.outputDir, "CouncilReport.md")}`,
    `Artifacts written to ${args.outputDir}`,
    "",
  ].join("\n");
}

export function createCouncilLogger(format: LogFormat): CouncilLogger {
  if (format === "json") return createJsonCouncilLogger();
  if (format === "silent") return createSilentCouncilLogger();
  return createConsoleCouncilLogger();
}

async function main(): Promise<void> {
  const args = parseCouncilCliArgs(process.argv.slice(2));
  const input = await readCouncilInputFile(args.inputPath);
  const report = await runCouncil(input, {
    outputDir: args.outputDir,
    inputPath: args.inputPath,
    logger: createCouncilLogger(args.logFormat),
  });

  process.stdout.write(formatCouncilSuccessMessage({ recommendation: report.recommendation, outputDir: args.outputDir }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof CouncilRunFailedError ? error.exitCode : 1;
  });
}
