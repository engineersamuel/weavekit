import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dryRunApplyTemplateOptimizerPackage } from "../src/macro-workflow/templateOptimizer/apply.js";

type ApplyArgs = {
  runId?: string;
  candidateId?: string;
  dryRun: boolean;
  runsRoot: string;
};

export function parseApplyArgs(argv: string[]): ApplyArgs {
  const parsed: ApplyArgs = {
    dryRun: false,
    runsRoot: join("evals", "template-optimizer", "runs"),
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--candidate") {
      parsed.candidateId = readNext(argv, ++index, arg);
      continue;
    }
    if (arg === "--runs-root") {
      parsed.runsRoot = readNext(argv, ++index, arg);
      continue;
    }
    if (!arg.startsWith("--") && !parsed.runId) {
      parsed.runId = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!parsed.runId) {
    throw new Error("Missing run id.\nUsage: nub scripts/optimize-template-apply.ts <run-id> [--dry-run] [--candidate <id>]");
  }

  return parsed;
}

export async function runApply(args: ApplyArgs): Promise<{ summaryPath: string; dryRun: boolean }> {
  if (!args.dryRun) {
    throw new Error("Template optimizer live repository modification is not implemented, use --dry-run.");
  }

  const result = await dryRunApplyTemplateOptimizerPackage({
    runsRoot: args.runsRoot,
    runId: args.runId!,
    candidateId: args.candidateId,
  });
  return { summaryPath: result.summaryPath, dryRun: true };
}

function readNext(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  runApply(parseApplyArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`[weavekit] Template optimizer ${result.dryRun ? "dry-run" : "apply"} summary: ${result.summaryPath}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
