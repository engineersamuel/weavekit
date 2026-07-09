import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { defaultBudgetGateConfig, loadTypedWeavekitConfig } from "../src/config.js";
import { appendBudgetGateAuditLog, evaluateBudgetGate } from "../src/macro-workflow/budgetGate.js";
import { defaultWorkflowGrammar } from "../src/macro-workflow/grammar.js";
import { loadNodeCostHistory } from "../src/macro-workflow/nodeCostHistory.js";
import { createSourceToProjectTemplateAdapter } from "../src/macro-workflow/sourceToProject/templateAdapter.js";
import { writeTemplateOptimizerArtifacts } from "../src/macro-workflow/templateOptimizer/artifacts.js";
import { createTemplateOptimizerBamlAdapters } from "../src/macro-workflow/templateOptimizer/bamlAdapters.js";
import { renderTemplateOptimizerConstraints } from "../src/macro-workflow/templateOptimizer/constraints.js";
import { optimizeTemplate } from "../src/macro-workflow/templateOptimizer/engine.js";
import { loadTemplateOptimizationFixtures } from "../src/macro-workflow/templateOptimizer/fixtures.js";
import { projectWorkflowCostUsd } from "../src/macro-workflow/usage.js";

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
  maxLiveTrials: number;
  minLiveDelta: number;
  minLiveDecisionConfidence: number;
  budgetOverrideReason?: string;
  outputRoot: string;
};

const DEFAULT_ITERATIONS = 5;
const MAX_ITERATIONS = 10;
const DEFAULT_CANDIDATES_PER_ITERATION = 1;
const MAX_CANDIDATES_PER_ITERATION = 3;
const DEFAULT_JUDGE_MODEL = "gpt-5.5";
const DEFAULT_GENERATOR_MODEL = "gpt-5.5";
const DEFAULT_MAX_LIVE_TRIALS = 1;
const MAX_LIVE_TRIALS = 5;
const DEFAULT_MIN_LIVE_DELTA = 0.1;
const DEFAULT_MIN_LIVE_DECISION_CONFIDENCE = 0.6;

export function parseOptimizeTemplateArgs(argv: string[]): OptimizeTemplateArgs {
  const parsed: OptimizeTemplateArgs = {
    iterations: DEFAULT_ITERATIONS,
    candidatesPerIteration: DEFAULT_CANDIDATES_PER_ITERATION,
    judgeModel: DEFAULT_JUDGE_MODEL,
    generatorModel: DEFAULT_GENERATOR_MODEL,
    minDecisionConfidence: 0,
    maxLiveTrials: DEFAULT_MAX_LIVE_TRIALS,
    minLiveDelta: DEFAULT_MIN_LIVE_DELTA,
    minLiveDecisionConfidence: DEFAULT_MIN_LIVE_DECISION_CONFIDENCE,
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
      parsed.iterations = readBoundedInteger(
        readNext(argv, ++index, arg),
        "--iterations",
        1,
        MAX_ITERATIONS,
      );
      continue;
    }
    if (arg === "--candidates-per-iteration") {
      parsed.candidatesPerIteration = readBoundedInteger(
        readNext(argv, ++index, arg),
        "--candidates-per-iteration",
        1,
        MAX_CANDIDATES_PER_ITERATION,
      );
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
      parsed.minDecisionConfidence = readNumber(
        readNext(argv, ++index, arg),
        "--min-decision-confidence",
        0,
        1,
      );
      continue;
    }
    if (arg === "--max-live-trials") {
      parsed.maxLiveTrials = readBoundedInteger(
        readNext(argv, ++index, arg),
        "--max-live-trials",
        0,
        MAX_LIVE_TRIALS,
      );
      continue;
    }
    if (arg === "--min-live-delta") {
      parsed.minLiveDelta = readNumber(readNext(argv, ++index, arg), "--min-live-delta", -1, 1);
      continue;
    }
    if (arg === "--min-live-decision-confidence") {
      parsed.minLiveDecisionConfidence = readNumber(
        readNext(argv, ++index, arg),
        "--min-live-decision-confidence",
        0,
        1,
      );
      continue;
    }
    if (arg === "--output-root") {
      parsed.outputRoot = readNext(argv, ++index, arg);
      continue;
    }
    if (arg === "--budget-override") {
      parsed.budgetOverrideReason = readNext(argv, ++index, arg);
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
    throw new Error(
      "Autonomous PR template optimization is represented in the schema but not enabled until fixtures exist.",
    );
  }

  return parsed;
}

export async function runOptimizeTemplate(
  args: OptimizeTemplateArgs,
): Promise<{ runId: string; outputDir: string }> {
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
  const config = loadTypedWeavekitConfig();
  const nodeCostHistory = await loadNodeCostHistory();
  const budgetProjection = projectWorkflowCostUsd({
    nodeCostHistory,
    calls: buildTemplateOptimizerProjectionCalls({
      iterations: args.iterations,
      candidatesPerIteration: args.candidatesPerIteration,
      fixtureCount: fixtures.length,
      generatorModel: args.generatorModel,
      judgeModel: args.judgeModel,
    }),
  });
  const budgetOverrideReason =
    args.budgetOverrideReason ??
    (process.env.WEAVEKIT_BUDGET_OVERRIDE === "1"
      ? process.env.WEAVEKIT_BUDGET_OVERRIDE_REASON
      : undefined);
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
    preRunGate: async () => {
      const decision = evaluateBudgetGate(
        budgetProjection,
        config.sourceToProject.budgetGate ?? defaultBudgetGateConfig(),
        {
          reason: budgetOverrideReason,
        },
      );
      if (decision.outcome !== "allow" || decision.overrideApplied) {
        await appendBudgetGateAuditLog({
          decision,
          workflowPath: "template-optimizer",
          runId,
          source: `${args.template}:${args.mode}`,
        });
      }
      if (decision.overrideApplied) {
        process.stderr.write(`[weavekit] budget_gate override: ${decision.reason}\n`);
      } else if (decision.outcome === "warn") {
        process.stderr.write(`[weavekit] budget_gate warning: ${decision.reason}\n`);
      }
      return decision;
    },
    strategies: [
      "coverage-focused",
      "minimalist",
      "verification-focused",
      "report-quality-focused",
    ],
    deps: createTemplateOptimizerBamlAdapters(),
  });
  await writeTemplateOptimizerArtifacts({
    outputDir,
    runId,
    args,
    constraintsSummary,
    fixtures,
    result,
  });
  return { runId, outputDir };
}

function buildTemplateOptimizerProjectionCalls(args: {
  iterations: number;
  candidatesPerIteration: number;
  fixtureCount: number;
  generatorModel: string;
  judgeModel: string;
}) {
  const candidateCount = args.iterations * args.candidatesPerIteration;
  return [
    {
      nodeId: "template-optimizer.generate-challenger",
      harness: "baml",
      model: args.generatorModel,
      inputTokens: 12000,
      outputTokens: 4000,
      callCount: candidateCount,
    },
    {
      nodeId: "template-optimizer.judge-fixture",
      harness: "baml",
      model: args.judgeModel,
      inputTokens: 10000,
      outputTokens: 2500,
      callCount: candidateCount * args.fixtureCount,
    },
    {
      nodeId: "template-optimizer.aggregate-judgments",
      harness: "baml",
      model: args.judgeModel,
      inputTokens: 8000,
      outputTokens: 2000,
      callCount: candidateCount,
    },
  ];
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
): asserts args is OptimizeTemplateArgs & {
  template: OptimizeTemplateId;
  mode: OptimizeTemplateMode;
} {
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
    throw new Error(
      "Autonomous PR template optimization is represented in the schema but not enabled until fixtures exist.",
    );
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
    throw new Error(
      `${flag} only supports ${defaultModel} until BAML model override wiring exists.`,
    );
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
  return `${message}\nUsage: nub scripts/optimize-template.ts --template source-to-project --mode advisory [--iterations <1-10>] [--candidates-per-iteration <1-3>] [--max-live-trials <0-5>]`;
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
