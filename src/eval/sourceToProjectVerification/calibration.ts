import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EvaluateTestSuite, TestCase } from "promptfoo";
import { runPersistedPromptfooEvaluation } from "../promptfooRunner.js";
import { aggregatePlanQuality } from "./aggregation.js";
import { createDefaultSourceToProjectJudgePanel } from "./bamlJudge.js";
import {
  buildProjectVerificationRequirements,
  DEFAULT_PROJECT_VERIFICATION_CASE_PATH,
  fingerprintProjectVerificationCase,
  loadProjectVerificationCase,
} from "./case.js";
import type {
  AbsoluteJudgeRecord,
  ResolvedPairwisePanel,
  SourceToProjectPlanJudge,
} from "./judge.js";
import { resolvePairwisePanel, shouldSwapPairwiseOrder } from "./judge.js";
import type { ProjectVerificationManifest, VerifiedPlanArtifact } from "./manifest.js";
import {
  createPromptfooJudgeProviders,
  type PromptfooJudgeTask,
} from "./promptfooJudgeProvider.js";
import { projectPromptfooJudgeResults } from "./promptfooJudgeResults.js";
import { buildPromptfooJudgeSuite, type PromptfooJudgeSuite } from "./promptfooJudgeSuite.js";

const DEFAULT_FIXTURE_DIR = "evals/source-to-project/judge-calibration/todo-safe-write-path";
const PROMPTFOO_VIEW_COMMAND = "nubx promptfoo view";
const MAX_ALTERNATE_TRIAL_ATTEMPTS = 4_096;

export type SourceToProjectCalibrationResult = {
  passed: boolean;
  promptfooEvaluationId: string;
  promptfooViewCommand: string;
  scores: Record<"weak" | "medium" | "strong", number>;
  perJudgeScores: Record<string, Record<"weak" | "medium" | "strong", number>>;
  qualityErrors: Record<"weak" | "medium" | "strong", string[]>;
  perJudgeQualityErrors: Record<string, Record<"weak" | "medium" | "strong", string[]>>;
  absolute: AbsoluteJudgeRecord[];
  pairwise: ResolvedPairwisePanel[];
  reversalChecks: CalibrationReversalCheck[];
  errors: string[];
};

export type CalibrationReversalCheck = {
  judgeId: string;
  providerIds: [string, string];
  originalOrder: [string, string];
  reversedOrder: [string, string];
  originalMappedWinner?: string;
  reversedMappedWinner?: string;
  passed: boolean;
  error?: string;
};

export function formatSourceToProjectCalibrationCliOutput(evaluationId: string): string {
  return [
    `Calibration evaluation ID: ${evaluationId}`,
    "View persisted evaluations: nubx promptfoo view",
    "",
  ].join("\n");
}

export async function runSourceToProjectJudgeCalibration(
  args: {
    casePath?: string;
    fixtureDir?: string;
    judges?: SourceToProjectPlanJudge[];
    runPromptfoo?: typeof runPersistedPromptfooEvaluation;
    now?: () => Date;
  } = {},
): Promise<SourceToProjectCalibrationResult> {
  const definition = loadProjectVerificationCase(
    args.casePath ?? DEFAULT_PROJECT_VERIFICATION_CASE_PATH,
  );
  const judges = args.judges ?? createDefaultSourceToProjectJudgePanel();
  const createdAt = (args.now?.() ?? new Date()).toISOString();
  const fixtureDir = args.fixtureDir ?? DEFAULT_FIXTURE_DIR;
  const plans = await loadCalibrationPlans(fixtureDir);
  const manifest = await calibrationManifest({ definition, plans, fixtureDir, createdAt });
  const caseJson = JSON.stringify({
    id: definition.id,
    title: definition.title,
    objective: definition.objective,
    requirements: buildProjectVerificationRequirements(definition),
    criteria: definition.rubric.filter(
      (criterion) => criterion.criterion !== "source-practice-coverage",
    ),
    antiGoals: definition.antiGoals,
  });
  const judgeIds = judges.map(({ id }) => id);
  const judgeSuite = buildCalibrationJudgeSuite({
    manifest,
    plans,
    caseJson,
    caseId: definition.id,
    trialId: createdAt,
    judges,
  });
  const evaluation = await (args.runPromptfoo ?? runPersistedPromptfooEvaluation)({
    suite: judgeSuite.suite,
    description: `Source-to-project judge calibration for ${definition.id} trial ${createdAt}`,
    tags: {
      workflow: "source-to-project",
      phase: "calibration",
      runId: createdAt,
      caseId: definition.id,
      trial: "calibration",
    },
    cache: false,
    maxConcurrency: 1,
  });
  const projected = projectPromptfooJudgeResults({
    summary: evaluation.summary,
    tasks: judgeSuite.tasks,
    judgeIds,
  });
  const panel = {
    absolute: projected.absolute,
    pairwise: mergeCalibrationPairwisePanels(projected.pairwise),
  };
  const qualities = Object.fromEntries(
    plans.map((plan) => [
      plan.providerId,
      aggregatePlanQuality({
        definition,
        providerId: plan.providerId,
        planMarkdown: plan.markdown,
        judgeIds,
        records: panel.absolute,
      }),
    ]),
  );
  const scores = Object.fromEntries(
    plans.map((plan) => [plan.providerId, qualities[plan.providerId]!.score ?? Number.NaN]),
  ) as SourceToProjectCalibrationResult["scores"];
  const qualityErrors = Object.fromEntries(
    plans.map((plan) => [plan.providerId, qualities[plan.providerId]!.errors]),
  ) as SourceToProjectCalibrationResult["qualityErrors"];
  const perJudgeQualities = Object.fromEntries(
    judgeIds.map((judgeId) => [
      judgeId,
      Object.fromEntries(
        plans.map((plan) => [
          plan.providerId,
          aggregatePlanQuality({
            definition,
            providerId: plan.providerId,
            planMarkdown: plan.markdown,
            judgeIds: [judgeId],
            records: panel.absolute.filter((record) => record.judgeId === judgeId),
          }),
        ]),
      ),
    ]),
  );
  const perJudgeScores = Object.fromEntries(
    judgeIds.map((judgeId) => [
      judgeId,
      Object.fromEntries(
        plans.map((plan) => [
          plan.providerId,
          perJudgeQualities[judgeId]![plan.providerId]!.score ?? Number.NaN,
        ]),
      ),
    ]),
  ) as SourceToProjectCalibrationResult["perJudgeScores"];
  const perJudgeQualityErrors = Object.fromEntries(
    judgeIds.map((judgeId) => [
      judgeId,
      Object.fromEntries(
        plans.map((plan) => [
          plan.providerId,
          perJudgeQualities[judgeId]![plan.providerId]!.errors,
        ]),
      ),
    ]),
  ) as SourceToProjectCalibrationResult["perJudgeQualityErrors"];
  const reversalChecks = projectReversalChecks(panel.pairwise);
  const errors = validateCalibration(
    scores,
    perJudgeScores,
    perJudgeQualityErrors,
    panel.pairwise,
    reversalChecks,
  );
  return {
    passed: errors.length === 0,
    promptfooEvaluationId: evaluation.evaluationId,
    promptfooViewCommand: PROMPTFOO_VIEW_COMMAND,
    scores,
    perJudgeScores,
    qualityErrors,
    perJudgeQualityErrors,
    absolute: panel.absolute,
    pairwise: panel.pairwise,
    reversalChecks,
    errors,
  };
}

function buildCalibrationJudgeSuite(args: {
  manifest: ProjectVerificationManifest;
  plans: VerifiedPlanArtifact[];
  caseJson: string;
  caseId: string;
  trialId: string;
  judges: SourceToProjectPlanJudge[];
}): PromptfooJudgeSuite {
  const calibrationPlanIds = new Set(args.plans.map(({ providerId }) => providerId));
  const requiredCalibrationPlanIds = ["weak", "medium", "strong"];
  if (
    calibrationPlanIds.size !== requiredCalibrationPlanIds.length ||
    requiredCalibrationPlanIds.some((providerId) => !calibrationPlanIds.has(providerId))
  ) {
    throw new Error("Judge calibration requires exactly the weak, medium, and strong plans.");
  }
  const judgeProviders = createPromptfooJudgeProviders(args.judges);
  const base = buildPromptfooJudgeSuite({
    manifest: args.manifest,
    plans: args.plans,
    caseJson: args.caseJson,
    caseId: args.caseId,
    trialId: args.trialId,
    judgeProviders,
  });
  const basePairwise = pairwiseTasks(base.tasks);
  const alternateTrialId = findCounterbalancedTrialId({
    baseTrialId: args.trialId,
    caseId: args.caseId,
    pairwiseTasks: basePairwise,
    judgeIds: args.judges.map(({ id }) => id),
  });
  const alternate = buildPromptfooJudgeSuite({
    manifest: args.manifest,
    plans: args.plans,
    caseJson: args.caseJson,
    caseId: args.caseId,
    trialId: alternateTrialId,
    judgeProviders,
  });
  const alternateTests = suiteTests(alternate.suite);
  const alternateEntries = alternate.tasks.flatMap((task, index) =>
    task.kind === "pairwise" ? [{ task, test: alternateTests[index]! }] : [],
  );
  return {
    tasks: [...base.tasks, ...alternateEntries.map(({ task }) => task)],
    suite: {
      ...base.suite,
      tests: [...suiteTests(base.suite), ...alternateEntries.map(({ test }) => test)],
    },
  };
}

function findCounterbalancedTrialId(args: {
  baseTrialId: string;
  caseId: string;
  pairwiseTasks: Array<Extract<PromptfooJudgeTask, { kind: "pairwise" }>>;
  judgeIds: string[];
}): string {
  for (let attempt = 1; attempt <= MAX_ALTERNATE_TRIAL_ATTEMPTS; attempt += 1) {
    const candidate = `${args.baseTrialId}:counterbalance:${attempt}`;
    const flipsEveryOrientation = args.pairwiseTasks.every((task) =>
      args.judgeIds.every(
        (judgeId) =>
          shouldSwapPairwiseOrder({
            caseId: args.caseId,
            trialId: candidate,
            leftProviderId: task.providerIds[0],
            rightProviderId: task.providerIds[1],
            judgeId,
            judgeIds: args.judgeIds,
          }) !==
          shouldSwapPairwiseOrder({
            caseId: args.caseId,
            trialId: args.baseTrialId,
            leftProviderId: task.providerIds[0],
            rightProviderId: task.providerIds[1],
            judgeId,
            judgeIds: args.judgeIds,
          }),
      ),
    );
    if (flipsEveryOrientation) return candidate;
  }
  throw new Error(
    `Could not find a counterbalanced Promptfoo calibration trial in ${MAX_ALTERNATE_TRIAL_ATTEMPTS} deterministic attempts.`,
  );
}

function suiteTests(suite: EvaluateTestSuite): TestCase[] {
  if (!Array.isArray(suite.tests) || suite.tests.some((test) => typeof test === "string")) {
    throw new Error("Promptfoo calibration judge suite must contain inline tests.");
  }
  return suite.tests as TestCase[];
}

function pairwiseTasks(
  tasks: PromptfooJudgeTask[],
): Array<Extract<PromptfooJudgeTask, { kind: "pairwise" }>> {
  return tasks.filter(
    (task): task is Extract<PromptfooJudgeTask, { kind: "pairwise" }> => task.kind === "pairwise",
  );
}

function mergeCalibrationPairwisePanels(panels: ResolvedPairwisePanel[]): ResolvedPairwisePanel[] {
  const judgmentsByPair = new Map<string, ResolvedPairwisePanel["judgments"]>();
  for (const panel of panels) {
    const key = [...panel.providerIds].sort().join("\0");
    const judgments = judgmentsByPair.get(key) ?? [];
    judgments.push(...panel.judgments);
    judgmentsByPair.set(key, judgments);
  }
  return [...judgmentsByPair.values()].map(resolvePairwisePanel);
}

async function loadCalibrationPlans(fixtureDir: string): Promise<VerifiedPlanArtifact[]> {
  return await Promise.all(
    (["weak", "medium", "strong"] as const).map(async (providerId) => ({
      providerId,
      markdown: await readFile(join(fixtureDir, `${providerId}.md`), "utf8"),
    })),
  );
}

async function calibrationManifest(args: {
  definition: ReturnType<typeof loadProjectVerificationCase>;
  plans: VerifiedPlanArtifact[];
  fixtureDir: string;
  createdAt: string;
}): Promise<ProjectVerificationManifest> {
  return {
    version: 2,
    caseId: args.definition.id,
    caseSha256: await fingerprintProjectVerificationCase(args.definition),
    createdAt: args.createdAt,
    promptfooGenerationEvaluationId: `calibration-fixtures:${args.definition.id}`,
    artifacts: args.plans.map((plan) => ({
      providerId: plan.providerId,
      generationSucceeded: true,
      workspaceMutationVerified: true,
      planPath: resolve(args.fixtureDir, `${plan.providerId}.md`),
      sha256: createHash("sha256").update(plan.markdown).digest("hex"),
      errors: [],
    })),
  };
}

function projectReversalChecks(comparisons: ResolvedPairwisePanel[]): CalibrationReversalCheck[] {
  return comparisons.flatMap((comparison) =>
    [...new Set(comparison.judgments.map(({ judgeId }) => judgeId))].map((judgeId) => {
      const judgments = comparison.judgments.filter((record) => record.judgeId === judgeId);
      const canonical = judgments.filter(
        (record) => record.planAProviderId.localeCompare(record.planBProviderId) < 0,
      );
      const counterbalanced = judgments.filter(
        (record) => record.planAProviderId.localeCompare(record.planBProviderId) > 0,
      );
      const record = canonical[0];
      const reversed = counterbalanced[0];
      const originalOrder: [string, string] = record
        ? [record.planAProviderId, record.planBProviderId]
        : ([...comparison.providerIds].sort() as [string, string]);
      const reversedOrder: [string, string] = [originalOrder[1], originalOrder[0]];
      const base = {
        judgeId,
        providerIds: comparison.providerIds,
        originalOrder,
        reversedOrder,
        ...(record?.mappedWinner ? { originalMappedWinner: record.mappedWinner } : {}),
        ...(reversed?.mappedWinner ? { reversedMappedWinner: reversed.mappedWinner } : {}),
      };
      if (canonical.length !== 1 || counterbalanced.length !== 1) {
        return {
          ...base,
          passed: false,
          error: `${judgeId} requires exactly one canonical and one counterbalanced judgment for ${comparison.providerIds.join(" vs ")}; found ${canonical.length} and ${counterbalanced.length}.`,
        };
      }
      if (record!.error || !record!.mappedWinner || reversed!.error || !reversed!.mappedWinner) {
        return {
          ...base,
          passed: false,
          error: `${judgeId} has an invalid canonical or counterbalanced judgment for ${comparison.providerIds.join(" vs ")}.`,
        };
      }
      return { ...base, passed: reversed!.mappedWinner === record!.mappedWinner };
    }),
  );
}

function validateCalibration(
  scores: SourceToProjectCalibrationResult["scores"],
  perJudgeScores: SourceToProjectCalibrationResult["perJudgeScores"],
  perJudgeQualityErrors: SourceToProjectCalibrationResult["perJudgeQualityErrors"],
  pairwise: ResolvedPairwisePanel[],
  reversalChecks: CalibrationReversalCheck[],
): string[] {
  const errors: string[] = [];
  for (const [judgeId, judgeScores] of Object.entries(perJudgeScores)) {
    for (const providerId of ["weak", "medium", "strong"] as const) {
      for (const error of perJudgeQualityErrors[judgeId]?.[providerId] ?? []) {
        errors.push(`Calibration quality for ${judgeId}/${providerId} is invalid: ${error}`);
      }
    }
    if (
      Object.values(judgeScores).every(Number.isFinite) &&
      !(judgeScores.strong > judgeScores.medium && judgeScores.medium > judgeScores.weak)
    ) {
      errors.push(`${judgeId} did not rank strong > medium > weak.`);
    }
  }
  if (Number.isFinite(scores.weak) && !(scores.weak < 0.5)) {
    errors.push("Weak calibration score must be below 0.50.");
  }
  if (Number.isFinite(scores.strong) && !(scores.strong >= 0.8)) {
    errors.push("Strong calibration score must be at least 0.80.");
  }
  for (const comparison of pairwise) {
    const expected = [...comparison.providerIds].sort(
      (left, right) => calibrationRank(right) - calibrationRank(left),
    )[0]!;
    if (comparison.status !== "agreed" || comparison.winner !== expected) {
      errors.push(
        `Calibration pair ${comparison.providerIds.join(" vs ")} was ${comparison.status} with winner ${comparison.winner ?? "none"}; expected ${expected}.`,
      );
    }
  }
  for (const check of reversalChecks) {
    if (!check.passed) {
      errors.push(
        check.error ??
          `${check.judgeId} changed mapped winner for ${check.providerIds.join(" vs ")} after A/B reversal.`,
      );
    }
  }
  return errors;
}

function calibrationRank(providerId: string): number {
  if (providerId === "strong") return 3;
  if (providerId === "medium") return 2;
  return 1;
}

async function main(): Promise<void> {
  const result = await runSourceToProjectJudgeCalibration();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(formatSourceToProjectCalibrationCliOutput(result.promptfooEvaluationId));
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
