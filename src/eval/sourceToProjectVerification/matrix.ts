import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  runSourceToProjectVerification,
  type SourceToProjectVerificationRunResult,
} from "./run.js";
import {
  ProjectVerificationProviderId,
  type ProjectVerificationProviderScore,
  type ProjectVerificationScorecard,
} from "./scorecard.js";

export type BaselineReliability = {
  wins: number;
  losses: number;
  disputed: number;
  meanQualityMargin: number;
  worstCaseMeanMargin: number;
  reliableWins: number;
  reliableLosses: number;
};

export type ReliabilityGateInput = {
  codex: BaselineReliability;
  copilot: BaselineReliability;
  invalidProviderRuns: number;
  invalidJudgePanels: number;
  unauditedWeavekitPlans: number;
};

export type ReliabilityGateResult = {
  passed: boolean;
  checks: Record<string, boolean>;
};

export type ProjectVerificationMatrix = {
  version: 1;
  trials: number;
  resultsDir: string;
  cases: Array<{ id: string; path: string }>;
};

export type ProjectVerificationMatrixResult = {
  outputDir: string;
  matrixRunId: string;
  scorecard: ProjectVerificationMatrixScorecard;
  passed: boolean;
};

export type ProjectVerificationMatrixScorecard = ReliabilityGateInput & {
  version: 1;
  createdAt: string;
  matrixRunId: string;
  trialCount: number;
  cases: Array<{ id: string; trials: number }>;
  gate: ReliabilityGateResult;
  trials: Array<{
    caseId: string;
    trial: number;
    outputDir: string;
    passed: boolean;
    promptfoo: SourceToProjectVerificationRunResult["promptfoo"];
  }>;
  efficiency: Record<
    string,
    {
      latencyMs: { median?: number; p95?: number };
      tokens: { median?: number; p95?: number };
      costUsd: { median?: number; p95?: number };
    }
  >;
};

const MatrixSchema = z
  .object({
    version: z.literal(1).default(1),
    trials: z.number().int().positive(),
    resultsDir: z.string().min(1).default("results"),
    cases: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9-]+$/),
          path: z.string().min(1),
        }),
      )
      .min(1),
  })
  .superRefine((matrix, context) => {
    const ids = new Set<string>();
    for (const [index, item] of matrix.cases.entries()) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "id"],
          message: "duplicate case id",
        });
      }
      ids.add(item.id);
    }
  });

const MATRIX_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function evaluateReliabilityGate(input: ReliabilityGateInput): ReliabilityGateResult {
  const checks = {
    codexMajorityWins: input.codex.wins > input.codex.losses,
    copilotMajorityWins: input.copilot.wins > input.copilot.losses,
    codexPositiveMeanMargin: input.codex.meanQualityMargin > 0,
    copilotPositiveMeanMargin: input.copilot.meanQualityMargin > 0,
    codexWorstCaseWithinTolerance: input.codex.worstCaseMeanMargin >= -0.02,
    copilotWorstCaseWithinTolerance: input.copilot.worstCaseMeanMargin >= -0.02,
    codexReliableWinsExceedLosses: input.codex.reliableWins > input.codex.reliableLosses,
    copilotReliableWinsExceedLosses: input.copilot.reliableWins > input.copilot.reliableLosses,
    noInvalidProviderRuns: input.invalidProviderRuns === 0,
    noInvalidJudgePanels: input.invalidJudgePanels === 0,
    allWeavekitPlansAudited: input.unauditedWeavekitPlans === 0,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export function loadProjectVerificationMatrix(path: string): ProjectVerificationMatrix {
  const absolutePath = resolve(path);
  const parsed = MatrixSchema.parse(parseYaml(readFileSync(absolutePath, "utf8")));
  const baseDir = dirname(absolutePath);
  return {
    ...parsed,
    resultsDir: resolve(baseDir, parsed.resultsDir),
    cases: parsed.cases.map((item) => ({ ...item, path: resolve(baseDir, item.path) })),
  };
}

export async function runProjectVerificationMatrix(
  options: {
    matrixPath: string;
    trials?: number;
    maxConcurrency?: number;
  },
  deps: {
    runTrial?: typeof runSourceToProjectVerification;
    now?: () => Date;
    createMatrixRunId?: () => string;
  } = {},
): Promise<ProjectVerificationMatrixResult> {
  const matrix = loadProjectVerificationMatrix(options.matrixPath);
  const trialsPerCase = options.trials ?? matrix.trials;
  const createdAt = (deps.now?.() ?? new Date()).toISOString();
  const matrixRunId = (deps.createMatrixRunId ?? randomUUID)();
  assertMatrixRunId(matrixRunId);
  const outputDir = join(matrix.resultsDir, `${createdAt.replace(/[:.]/g, "-")}--${matrixRunId}`);
  await mkdir(matrix.resultsDir, { recursive: true });
  await mkdir(outputDir);
  const trialResults: Array<{
    caseId: string;
    trial: number;
    result: SourceToProjectVerificationRunResult;
  }> = [];
  for (const matrixCase of matrix.cases) {
    for (let trial = 1; trial <= trialsPerCase; trial += 1) {
      const result = await (deps.runTrial ?? runSourceToProjectVerification)({
        casePath: matrixCase.path,
        resultsDir: join(outputDir, matrixCase.id, `trial-${trial}`),
        maxConcurrency: options.maxConcurrency ?? 1,
        matrixRunId,
        trial,
      });
      trialResults.push({ caseId: matrixCase.id, trial, result });
    }
  }
  const gateInput = aggregateReliability(trialResults);
  const gate = evaluateReliabilityGate(gateInput);
  const scorecard: ProjectVerificationMatrixScorecard = {
    version: 1,
    createdAt,
    matrixRunId,
    trialCount: trialResults.length,
    cases: matrix.cases.map((item) => ({ id: item.id, trials: trialsPerCase })),
    trials: trialResults.map((item) => ({
      caseId: item.caseId,
      trial: item.trial,
      outputDir: item.result.outputDir,
      passed: item.result.passed,
      promptfoo: item.result.promptfoo,
    })),
    ...gateInput,
    gate,
    efficiency: aggregateEfficiency(trialResults.map((item) => item.result.scorecard)),
  };
  await Promise.all([
    writeFile(join(outputDir, "matrix-scorecard.json"), JSON.stringify(scorecard, null, 2), "utf8"),
    writeFile(
      join(outputDir, "matrix-summary.md"),
      renderProjectVerificationMatrixSummary(scorecard),
      "utf8",
    ),
  ]);
  return { outputDir, matrixRunId, scorecard, passed: gate.passed };
}

function assertMatrixRunId(matrixRunId: unknown): asserts matrixRunId is string {
  if (typeof matrixRunId !== "string" || !MATRIX_RUN_ID_PATTERN.test(matrixRunId)) {
    throw new Error(
      "matrixRunId must be 1-128 characters using only letters, numbers, underscores, or hyphens.",
    );
  }
}

export function renderProjectVerificationMatrixSummary(
  scorecard: ProjectVerificationMatrixScorecard,
): string {
  return [
    "# Source-to-Project Reliability Matrix",
    "",
    `- Gate: ${scorecard.gate.passed ? "PASS" : "FAIL"}`,
    `- Trials: ${scorecard.trialCount}`,
    `- Matrix run ID: ${safeInlineCode(scorecard.matrixRunId)}`,
    `- Weavekit vs Codex mean quality margin: ${formatMargin(scorecard.codex.meanQualityMargin)}`,
    `- Weavekit vs Copilot mean quality margin: ${formatMargin(scorecard.copilot.meanQualityMargin)}`,
    `- Worst case mean margins: Codex ${formatMargin(scorecard.codex.worstCaseMeanMargin)}, Copilot ${formatMargin(scorecard.copilot.worstCaseMeanMargin)}`,
    "",
    "## Pairwise reliability",
    "",
    "| Baseline | Quality wins | Quality losses | Disputed | Agreed wins | Agreed losses |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    reliabilityRow("Codex", scorecard.codex),
    reliabilityRow("Copilot", scorecard.copilot),
    "",
    "## Invalid and unaudited runs",
    "",
    `- Invalid provider runs: ${scorecard.invalidProviderRuns}`,
    `- Invalid judge panels: ${scorecard.invalidJudgePanels}`,
    `- Unaudited Weavekit plans: ${scorecard.unauditedWeavekitPlans}`,
    "",
    "## Persisted Promptfoo evaluations",
    "",
    "| Case | Trial | Generation evaluation ID | Judge evaluation ID |",
    "| --- | ---: | --- | --- |",
    ...scorecard.trials.map(
      (trial) =>
        `| ${safeCell(trial.caseId)} | ${trial.trial} | ${safeInlineCode(trial.promptfoo.generationEvaluationId)} | ${safeInlineCode(trial.promptfoo.judgeEvaluationId)} |`,
    ),
    "",
    "View persisted evaluations: `nubx promptfoo view`",
    "",
    "## Efficiency diagnostics (not part of the gate)",
    "",
    "| Provider | Median latency ms | P95 latency ms | Median tokens | P95 tokens | Median cost USD | P95 cost USD |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(scorecard.efficiency).map(
      ([provider, metrics]) =>
        `| ${safeCell(provider)} | ${formatNumber(metrics.latencyMs.median)} | ${formatNumber(metrics.latencyMs.p95)} | ${formatNumber(metrics.tokens.median)} | ${formatNumber(metrics.tokens.p95)} | ${formatNumber(metrics.costUsd.median)} | ${formatNumber(metrics.costUsd.p95)} |`,
    ),
    "",
  ].join("\n");
}

function aggregateReliability(
  trials: Array<{ caseId: string; result: SourceToProjectVerificationRunResult }>,
): ReliabilityGateInput {
  return {
    codex: aggregateBaseline(trials, ProjectVerificationProviderId.CODEX),
    copilot: aggregateBaseline(trials, ProjectVerificationProviderId.COPILOT),
    invalidProviderRuns: trials.filter(({ result }) =>
      [
        ProjectVerificationProviderId.WEAVEKIT,
        ProjectVerificationProviderId.CODEX,
        ProjectVerificationProviderId.COPILOT,
      ].some((providerId) => !validProvider(result.scorecard, providerId)),
    ).length,
    invalidJudgePanels: trials.reduce(
      (sum, { result }) =>
        sum + result.scorecard.comparisons.pairs.filter((pair) => pair.status === "invalid").length,
      0,
    ),
    unauditedWeavekitPlans: trials.filter(({ result }) => {
      const weavekit = result.scorecard.providers.find(
        (provider) => provider.id === ProjectVerificationProviderId.WEAVEKIT,
      );
      return (
        weavekit?.qualityValid === true &&
        !weavekit.artifactPath?.endsWith("plan-portfolio-full.md")
      );
    }).length,
  };
}

function aggregateBaseline(
  trials: Array<{ caseId: string; result: SourceToProjectVerificationRunResult }>,
  baselineId: string,
): BaselineReliability {
  const margins = trials.flatMap(({ caseId, result }) => {
    const weavekit = scoreFor(result.scorecard, ProjectVerificationProviderId.WEAVEKIT);
    const baseline = scoreFor(result.scorecard, baselineId);
    return weavekit === undefined || baseline === undefined
      ? []
      : [{ caseId, margin: weavekit - baseline }];
  });
  const caseMargins = new Map<string, number[]>();
  for (const item of margins) {
    caseMargins.set(item.caseId, [...(caseMargins.get(item.caseId) ?? []), item.margin]);
  }
  let reliableWins = 0;
  let reliableLosses = 0;
  let disputed = 0;
  for (const { result } of trials) {
    const pair = result.scorecard.comparisons.pairs.find(
      (candidate) =>
        candidate.providerIds.includes(ProjectVerificationProviderId.WEAVEKIT) &&
        candidate.providerIds.includes(baselineId),
    );
    if (!pair || pair.status === "disputed" || pair.status === "invalid") {
      disputed += pair?.status === "disputed" ? 1 : 0;
      continue;
    }
    if (pair.status === "agreed" && pair.winner === ProjectVerificationProviderId.WEAVEKIT) {
      reliableWins += 1;
    } else if (pair.status === "agreed" && pair.winner === baselineId) {
      reliableLosses += 1;
    }
  }
  const caseMeans = [...caseMargins.values()].map(mean);
  return {
    wins: margins.filter((item) => item.margin > 0).length,
    losses: margins.filter((item) => item.margin < 0).length,
    disputed,
    meanQualityMargin: round(mean(margins.map((item) => item.margin))),
    worstCaseMeanMargin: round(caseMeans.length > 0 ? Math.min(...caseMeans) : -1),
    reliableWins,
    reliableLosses,
  };
}

function aggregateEfficiency(scorecards: ProjectVerificationScorecard[]) {
  const providers = new Map<string, ProjectVerificationProviderScore[]>();
  for (const scorecard of scorecards) {
    for (const provider of scorecard.providers) {
      providers.set(provider.id, [...(providers.get(provider.id) ?? []), provider]);
    }
  }
  return Object.fromEntries(
    [...providers.entries()].map(([id, values]) => {
      const latency = values.flatMap((item) => item.latencyMs ?? []);
      const tokens = values.flatMap((item) => totalTokens(item.tokenUsage) ?? []);
      const costs = values.flatMap((item) => item.estimatedCostUsd ?? []);
      return [
        id,
        {
          latencyMs: distribution(latency),
          tokens: distribution(tokens),
          costUsd: distribution(costs),
        },
      ];
    }),
  );
}

function validProvider(scorecard: ProjectVerificationScorecard, providerId: string): boolean {
  const provider = scorecard.providers.find((item) => item.id === providerId);
  return Boolean(
    provider?.generationSucceeded && provider.workspaceMutationVerified && provider.qualityValid,
  );
}

function scoreFor(scorecard: ProjectVerificationScorecard, providerId: string) {
  const provider = scorecard.providers.find((item) => item.id === providerId);
  return provider?.qualityValid && Number.isFinite(provider.score) ? provider.score : undefined;
}

function totalTokens(usage?: Record<string, number>): number | undefined {
  if (!usage) return undefined;
  return Object.values(usage).reduce((sum, value) => sum + value, 0);
}

function distribution(values: number[]): { median?: number; p95?: number } {
  if (values.length === 0) return {};
  const sorted = [...values].sort((left, right) => left - right);
  return { median: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function reliabilityRow(label: string, value: BaselineReliability): string {
  return `| ${label} | ${value.wins} | ${value.losses} | ${value.disputed} | ${value.reliableWins} | ${value.reliableLosses} |`;
}

function formatMargin(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "n/a" : String(round(value));
}

function safeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function safeInlineCode(value: string): string {
  return `\`${value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("`", "&#96;")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")}\``;
}
