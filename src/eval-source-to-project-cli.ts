import { pathToFileURL } from "node:url";
import {
  ProjectVerificationProviderId,
  type ProjectVerificationProviderId as ProjectVerificationProviderIdValue,
} from "./eval/sourceToProjectVerification/scorecard.js";

export type ParsedSourceToProjectVerificationArgs = {
  matrixPath?: string;
  trials?: number;
  casePath?: string;
  resultsDir?: string;
  providerIds?: ProjectVerificationProviderIdValue[];
  baselinePath?: string;
  minimumWeavekitDelta?: number;
  maxConcurrency?: number;
  rejudgeFrom?: string;
};

export function formatSourceToProjectVerificationCliOutput(result: {
  outputDir: string;
  promptfoo: { generationEvaluationId: string; judgeEvaluationId: string };
}): string {
  return [
    `Source-to-project verification complete: ${result.outputDir}`,
    `Generation evaluation ID: ${result.promptfoo.generationEvaluationId}`,
    `Judge evaluation ID: ${result.promptfoo.judgeEvaluationId}`,
    "View persisted evaluations: nubx promptfoo view",
    "",
  ].join("\n");
}

export function formatSourceToProjectMatrixCliOutput(result: { outputDir: string }): string {
  return [
    `Source-to-project reliability matrix complete: ${result.outputDir}`,
    "View persisted evaluations: nubx promptfoo view",
    "",
  ].join("\n");
}

export function parseSourceToProjectVerificationArgs(
  argv: string[],
): ParsedSourceToProjectVerificationArgs {
  const parsed: ParsedSourceToProjectVerificationArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--matrix") {
      parsed.matrixPath = readNext(argv, ++index, flag);
      continue;
    }
    if (flag === "--trials") {
      parsed.trials = readPositiveInteger(readNext(argv, ++index, flag), flag);
      continue;
    }
    if (flag === "--case") {
      parsed.casePath = readNext(argv, ++index, flag);
      continue;
    }
    if (flag === "--output") {
      parsed.resultsDir = readNext(argv, ++index, flag);
      continue;
    }
    if (flag === "--providers") {
      parsed.providerIds = readProviders(readNext(argv, ++index, flag));
      continue;
    }
    if (flag === "--baseline") {
      parsed.baselinePath = readNext(argv, ++index, flag);
      continue;
    }
    if (flag === "--minimum-weavekit-delta") {
      parsed.minimumWeavekitDelta = readNormalizedDelta(readNext(argv, ++index, flag), flag);
      continue;
    }
    if (flag === "--max-concurrency") {
      parsed.maxConcurrency = readPositiveInteger(readNext(argv, ++index, flag), flag);
      continue;
    }
    if (flag === "--rejudge-from") {
      parsed.rejudgeFrom = readNext(argv, ++index, flag);
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  if (parsed.minimumWeavekitDelta !== undefined && !parsed.baselinePath) {
    throw new Error("--minimum-weavekit-delta requires --baseline.");
  }
  if (parsed.rejudgeFrom && (parsed.providerIds || parsed.resultsDir || parsed.maxConcurrency)) {
    throw new Error(
      "--rejudge-from cannot be combined with --providers, --output, or --max-concurrency.",
    );
  }
  if (parsed.trials !== undefined && !parsed.matrixPath) {
    throw new Error("--trials requires --matrix.");
  }
  if (parsed.matrixPath) {
    const conflictingFlag = [
      parsed.casePath ? "--case" : undefined,
      parsed.rejudgeFrom ? "--rejudge-from" : undefined,
      parsed.providerIds ? "--providers" : undefined,
      parsed.baselinePath ? "--baseline" : undefined,
      parsed.minimumWeavekitDelta !== undefined ? "--minimum-weavekit-delta" : undefined,
      parsed.resultsDir ? "--output" : undefined,
    ].find(Boolean);
    if (conflictingFlag) {
      throw new Error(`--matrix cannot be combined with ${conflictingFlag}.`);
    }
  }
  return parsed;
}

async function runCli(): Promise<void> {
  const args = parseSourceToProjectVerificationArgs(process.argv.slice(2));
  if (args.matrixPath) {
    const { runProjectVerificationMatrix } =
      await import("./eval/sourceToProjectVerification/matrix.js");
    const result = await runProjectVerificationMatrix({
      matrixPath: args.matrixPath,
      trials: args.trials,
      maxConcurrency: args.maxConcurrency,
    });
    process.stdout.write(formatSourceToProjectMatrixCliOutput(result));
    if (!result.passed) {
      process.exitCode = 1;
    }
    return;
  }
  const { runSourceToProjectVerification } =
    await import("./eval/sourceToProjectVerification/run.js");
  const result = await runSourceToProjectVerification(args);
  process.stdout.write(formatSourceToProjectVerificationCliOutput(result));
  if (!result.passed) {
    process.exitCode = 1;
  }
}

function readProviders(value: string): ProjectVerificationProviderIdValue[] {
  const aliases: Record<string, ProjectVerificationProviderIdValue> = {
    weavekit: ProjectVerificationProviderId.WEAVEKIT,
    copilot: ProjectVerificationProviderId.COPILOT,
    codex: ProjectVerificationProviderId.CODEX,
  };
  const providers = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (providers.length === 0) {
    throw new Error("--providers requires at least one provider.");
  }
  return providers.map((provider) => {
    const id = aliases[provider];
    if (!id) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    return id;
  });
}

function readNext(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function readNormalizedDelta(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a number.`);
  }
  if (parsed < -1 || parsed > 1) {
    throw new Error(`${flag} must be between -1 and 1.`);
  }
  return parsed;
}

function readPositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be an integer >= 1.`);
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
