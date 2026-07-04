import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { TemplateCandidate } from "../src/generated/baml_client/index.js";
import { defaultWorkflowGrammar } from "../src/macro-workflow/grammar.js";
import { createSourceToProjectTemplateAdapter } from "../src/macro-workflow/sourceToProject/templateAdapter.js";
import { createTemplateOptimizerBamlAdapters } from "../src/macro-workflow/templateOptimizer/bamlAdapters.js";
import { renderTemplateOptimizerConstraints } from "../src/macro-workflow/templateOptimizer/constraints.js";
import { optimizeTemplate } from "../src/macro-workflow/templateOptimizer/engine.js";
import type { TemplateOptimizerResult } from "../src/macro-workflow/templateOptimizer/engine.js";
import { loadTemplateOptimizationFixtures } from "../src/macro-workflow/templateOptimizer/fixtures.js";

const execFileAsync = promisify(execFile);

type OptimizeTemplateId = "source-to-project";
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
const DEFAULT_JUDGE_MODEL = "gpt-5.5";
const DEFAULT_GENERATOR_MODEL = "claude-opus-4.8";

export function parseOptimizeTemplateArgs(argv: string[]): OptimizeTemplateArgs {
  const parsed: OptimizeTemplateArgs = {
    iterations: DEFAULT_ITERATIONS,
    candidatesPerIteration: DEFAULT_CANDIDATES_PER_ITERATION,
    judgeModel: DEFAULT_JUDGE_MODEL,
    generatorModel: DEFAULT_GENERATOR_MODEL,
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
      parsed.judgeModel = readDefaultModelFlag(
        readNext(argv, ++index, arg),
        "--judge-model",
        DEFAULT_JUDGE_MODEL,
      );
      continue;
    }
    if (arg === "--generator-model") {
      parsed.generatorModel = readDefaultModelFlag(
        readNext(argv, ++index, arg),
        "--generator-model",
        DEFAULT_GENERATOR_MODEL,
      );
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
  assertRunnableOptimizeTemplateArgs(args);

  const runId = `template-optimizer-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outputDir = join(args.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });

  const baseline = createSourceToProjectTemplateAdapter().getBaselineCandidate(args.mode);
  const fixtures = await loadTemplateOptimizationFixtures({
    templateId: args.template,
    mode: args.mode,
  });
  const constraintsSummary = renderTemplateOptimizerConstraints({
    grammar: defaultWorkflowGrammar,
    templateId: args.template,
    mode: args.mode,
  });
  const result = await optimizeTemplate({
    objective: `Optimize ${args.template} ${args.mode} Static template quality.`,
    constraintsSummary,
    baseline,
    fixtures,
    iterations: args.iterations,
    candidatesPerIteration: args.candidatesPerIteration,
    minimumDelta: 0.03,
    minimumDecisionConfidence: args.minDecisionConfidence,
    strategies: [
      "coverage-focused",
      "minimalist",
      "verification-focused",
      "report-quality-focused",
    ],
    deps: createTemplateOptimizerBamlAdapters(),
  });
  const packageJson: OptimizerRunArtifact = {
    status: result.finalIncumbent.id === baseline.id ? "keep-current-template" : "candidate-ready",
    note: "Template optimizer completed with live BAML candidate generation and judging.",
    runId,
    templateId: args.template,
    mode: args.mode,
    options: {
      iterations: args.iterations,
      candidatesPerIteration: args.candidatesPerIteration,
      judgeModel: args.judgeModel,
      generatorModel: args.generatorModel,
      minDecisionConfidence: args.minDecisionConfidence,
    },
    fixtureIds: fixtures.map((fixture) => fixture.id),
    baselineCandidateId: baseline.id,
    finalIncumbent: result.finalIncumbent,
    leaderboardIds: result.leaderboard.map((candidate) => candidate.id),
    rejectedMoves: result.rejectedMoves,
    iterations: result.iterations.map((iteration) => ({
      index: iteration.index,
      candidateIndex: iteration.candidateIndex,
      strategy: iteration.strategy,
      challengerId: iteration.challenger.id,
      replacedIncumbent: iteration.replacedIncumbent,
      aggregateJudgment: iteration.aggregateJudgment,
      fixtureJudgmentIds: iteration.fixtureJudgments.map((judgment) => judgment.fixtureId),
    })),
    finalRecommendation: {
      candidateId: result.finalIncumbent.id,
      recommendation: result.finalIncumbent.id === baseline.id ? "keep-current-template" : "adopt-candidate",
      rationale: renderFinalRecommendationRationale(result, baseline),
    },
    generatedAt: new Date().toISOString(),
  };
  await writeFile(join(outputDir, "optimizer-run.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(join(outputDir, "summary.md"), renderSummary(packageJson), "utf8");
  return { runId, outputDir };
}

function renderSummary(run: {
  status: string;
  runId: string;
  templateId?: string;
  mode?: string;
  note: string;
  fixtureIds: string[];
  leaderboardIds: string[];
  iterations: Array<{ challengerId: string; replacedIncumbent: boolean }>;
  finalRecommendation: { candidateId: string; recommendation: string; rationale: string };
}): string {
  return [
    "# Template Optimizer Run",
    "",
    `- Run: ${run.runId}`,
    `- Template: ${run.templateId}`,
    `- Mode: ${run.mode}`,
    `- Status: ${run.status}`,
    `- Fixtures: ${run.fixtureIds.join(", ")}`,
    `- Leaderboard: ${run.leaderboardIds.join(" -> ")}`,
    "",
    run.note,
    "",
    "## Iterations",
    "",
    ...renderIterationSummary(run.iterations),
    "",
    "## Final Recommendation",
    "",
    `- Candidate: ${run.finalRecommendation.candidateId}`,
    `- Recommendation: ${run.finalRecommendation.recommendation}`,
    `- Rationale: ${run.finalRecommendation.rationale}`,
    "",
  ].join("\n");
}

type OptimizerRunArtifact = {
  status: "keep-current-template" | "candidate-ready";
  note: string;
  runId: string;
  templateId?: OptimizeTemplateId;
  mode?: OptimizeTemplateMode;
  options: {
    iterations: number;
    candidatesPerIteration: number;
    judgeModel: string;
    generatorModel: string;
    minDecisionConfidence: number;
  };
  fixtureIds: string[];
  baselineCandidateId: string;
  finalIncumbent: TemplateCandidate;
  leaderboardIds: string[];
  rejectedMoves: string[];
  iterations: Array<{
    index: number;
    candidateIndex: number;
    strategy: string;
    challengerId: string;
    replacedIncumbent: boolean;
    aggregateJudgment: TemplateOptimizerResult["iterations"][number]["aggregateJudgment"];
    fixtureJudgmentIds: string[];
  }>;
  finalRecommendation: {
    candidateId: string;
    recommendation: "keep-current-template" | "adopt-candidate";
    rationale: string;
  };
  generatedAt: string;
};

function renderIterationSummary(
  iterations: Array<{ challengerId: string; replacedIncumbent: boolean }>,
): string[] {
  if (iterations.length === 0) {
    return ["No iterations ran."];
  }
  return iterations.map((iteration, index) => {
    const decision = iteration.replacedIncumbent ? "replaced incumbent" : "kept incumbent";
    return `- ${index + 1}. ${iteration.challengerId}: ${decision}`;
  });
}

function renderFinalRecommendationRationale(
  result: TemplateOptimizerResult,
  baseline: TemplateCandidate,
): string {
  if (result.finalIncumbent.id === baseline.id) {
    return result.rejectedMoves.length > 0
      ? `The checked-in baseline remains incumbent after ${result.rejectedMoves.length} rejected move(s).`
      : "The checked-in baseline remains incumbent.";
  }
  return result.finalIncumbent.rationale;
}

function readNext(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function assertRunnableOptimizeTemplateArgs(
  args: OptimizeTemplateArgs,
): asserts args is OptimizeTemplateArgs & { template: OptimizeTemplateId; mode: OptimizeTemplateMode } {
  if (!args.template) {
    throw new Error(usage("Missing required --template <id>."));
  }
  if (!args.mode) {
    throw new Error(usage("Missing required --mode <advisory|autonomous-pr>."));
  }
  if (args.template !== "source-to-project") {
    throw new Error(`Unsupported template "${args.template}". V1 supports source-to-project.`);
  }
  if (args.mode !== "advisory") {
    throw new Error("Autonomous PR template optimization is represented in the schema but not enabled until fixtures exist.");
  }
  validateDefaultModelFlag(args.judgeModel, "--judge-model", DEFAULT_JUDGE_MODEL);
  validateDefaultModelFlag(args.generatorModel, "--generator-model", DEFAULT_GENERATOR_MODEL);
}

function readBoundedInteger(value: string, flag: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function readDefaultModelFlag(value: string, flag: string, defaultModel: string): string {
  validateDefaultModelFlag(value, flag, defaultModel);
  return value;
}

function validateDefaultModelFlag(value: string, flag: string, defaultModel: string): void {
  if (value !== defaultModel) {
    throw new Error(`${flag} only supports ${defaultModel} until BAML model override wiring exists.`);
  }
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
