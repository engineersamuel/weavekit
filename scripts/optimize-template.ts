import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

type OptimizeTemplateMode = "advisory" | "autonomous-pr";

type OptimizeTemplateArgs = {
  template?: string;
  mode?: OptimizeTemplateMode;
  iterations: number;
  candidatesPerIteration: number;
  judgeModel: string;
  generatorModel: string;
  minDecisionConfidence: number;
  outputRoot: string;
};

const DEFAULT_ITERATIONS = 5;
const MAX_ITERATIONS = 10;
const DEFAULT_CANDIDATES_PER_ITERATION = 1;
const MAX_CANDIDATES_PER_ITERATION = 3;

export function parseOptimizeTemplateArgs(argv: string[]): OptimizeTemplateArgs {
  const parsed: OptimizeTemplateArgs = {
    iterations: DEFAULT_ITERATIONS,
    candidatesPerIteration: DEFAULT_CANDIDATES_PER_ITERATION,
    judgeModel: "gpt-5.5",
    generatorModel: "claude-opus-4.8",
    minDecisionConfidence: 0,
    outputRoot: join("evals", "template-optimizer", "runs"),
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--template") {
      parsed.template = readNext(argv, ++index, arg);
      continue;
    }
    if (arg === "--mode") {
      const mode = readNext(argv, ++index, arg);
      if (mode !== "advisory" && mode !== "autonomous-pr") {
        throw new Error("Invalid --mode value. Expected advisory or autonomous-pr.");
      }
      parsed.mode = mode;
      continue;
    }
    if (arg === "--iterations") {
      parsed.iterations = readBoundedInteger(readNext(argv, ++index, arg), "--iterations", 1, MAX_ITERATIONS);
      continue;
    }
    if (arg === "--candidates-per-iteration") {
      parsed.candidatesPerIteration = readBoundedInteger(readNext(argv, ++index, arg), "--candidates-per-iteration", 1, MAX_CANDIDATES_PER_ITERATION);
      continue;
    }
    if (arg === "--judge-model") {
      parsed.judgeModel = readNext(argv, ++index, arg);
      continue;
    }
    if (arg === "--generator-model") {
      parsed.generatorModel = readNext(argv, ++index, arg);
      continue;
    }
    if (arg === "--min-decision-confidence") {
      parsed.minDecisionConfidence = readNumber(readNext(argv, ++index, arg), "--min-decision-confidence", 0, 1);
      continue;
    }
    if (arg === "--output-root") {
      parsed.outputRoot = readNext(argv, ++index, arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!parsed.template) {
    throw new Error(usage("Missing required --template <id>."));
  }
  if (!parsed.mode) {
    throw new Error(usage("Missing required --mode <advisory|autonomous-pr>."));
  }
  if (parsed.template !== "source-to-project") {
    throw new Error(`Unsupported template "${parsed.template}". V1 supports source-to-project.`);
  }
  if (parsed.mode !== "advisory") {
    throw new Error("Autonomous PR template optimization is represented in the schema but not enabled until fixtures exist.");
  }

  return parsed;
}

export async function runOptimizeTemplate(args: OptimizeTemplateArgs): Promise<{ runId: string; outputDir: string }> {
  await execFileAsync("mise", ["run", "doctor"], { cwd: process.cwd() });

  const runId = `template-optimizer-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outputDir = join(args.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });

  const packageJson = {
    status: "keep-current-template",
    note: "Template optimizer command scaffold is installed. Live BAML candidate generation/judging is the next implementation slice.",
    templateId: args.template,
    mode: args.mode,
    options: {
      iterations: args.iterations,
      candidatesPerIteration: args.candidatesPerIteration,
      judgeModel: args.judgeModel,
      generatorModel: args.generatorModel,
      minDecisionConfidence: args.minDecisionConfidence,
    },
    finalRecommendation: {
      candidateId: "checked-in-baseline",
      recommendation: "keep-current-template",
      rationale: "No live optimizer loop has been implemented yet, so the checked-in template remains the incumbent.",
    },
    generatedAt: new Date().toISOString(),
  };
  await writeFile(join(outputDir, "optimizer-run.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(join(outputDir, "summary.md"), renderSummary(packageJson), "utf8");
  return { runId, outputDir };
}

function renderSummary(run: {
  status: string;
  templateId?: string;
  mode?: string;
  note: string;
  finalRecommendation: { recommendation: string; rationale: string };
}): string {
  return [
    "# Template Optimizer Run",
    "",
    `- Template: ${run.templateId}`,
    `- Mode: ${run.mode}`,
    `- Status: ${run.status}`,
    "",
    run.note,
    "",
    "## Final Recommendation",
    "",
    `- Recommendation: ${run.finalRecommendation.recommendation}`,
    `- Rationale: ${run.finalRecommendation.rationale}`,
    "",
  ].join("\n");
}

function readNext(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function readBoundedInteger(value: string, flag: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function readNumber(value: string, flag: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be a number between ${min} and ${max}.`);
  }
  return parsed;
}

function usage(message: string): string {
  return `${message}\nUsage: nub scripts/optimize-template.ts --template source-to-project --mode advisory [--iterations <1-10>] [--candidates-per-iteration <1-3>]`;
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  runOptimizeTemplate(parseOptimizeTemplateArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`[weavekit] Template optimizer run: ${result.runId}\n`);
      process.stdout.write(`[weavekit] Output: ${result.outputDir}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
