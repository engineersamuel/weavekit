import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ApiProvider, EvaluateSummaryV3 } from "promptfoo";
import { sanitizePersistedErrorFields } from "../boundedError.js";
import { runPersistedPromptfooEvaluation } from "../promptfooRunner.js";
import { aggregatePlanQuality } from "./aggregation.js";
import { createDefaultSourceToProjectJudgePanel } from "./bamlJudge.js";
import {
  buildProjectVerificationRequirements,
  DEFAULT_PROJECT_VERIFICATION_CASE_PATH,
  fingerprintProjectVerificationCase,
  loadProjectVerificationCase,
} from "./case.js";
import {
  type ProjectVerificationJudgePanelResult,
  type SourceToProjectPlanJudge,
} from "./judge.js";
import {
  buildProjectVerificationManifest,
  verifyProjectVerificationManifest,
  type ProjectVerificationExecutionRow,
  type ProjectVerificationManifest,
} from "./manifest.js";
import { createProjectVerificationProviders } from "./providers.js";
import { createPromptfooJudgeProviders } from "./promptfooJudgeProvider.js";
import { projectPromptfooJudgeResults } from "./promptfooJudgeResults.js";
import { buildPromptfooJudgeSuite } from "./promptfooJudgeSuite.js";
import { loadProjectVerificationRejudgeSource } from "./rejudge.js";
import {
  buildProjectVerificationScorecard,
  parseProjectVerificationScorecard,
  renderProjectVerificationSummary,
  type ProjectVerificationProviderId,
  type ProjectVerificationScorecard,
} from "./scorecard.js";
import { buildProjectVerificationSuite } from "./suite.js";

export type RunSourceToProjectVerificationOptions = {
  casePath?: string;
  resultsDir?: string;
  providerIds?: ProjectVerificationProviderId[];
  baselinePath?: string;
  minimumWeavekitDelta?: number;
  maxConcurrency?: number;
  rejudgeFrom?: string;
  matrixRunId?: string;
  trial?: number;
};

export type RunSourceToProjectVerificationDeps = {
  providers?: ApiProvider[];
  runPromptfoo?: typeof runPersistedPromptfooEvaluation;
  now?: () => Date;
  judges?: SourceToProjectPlanJudge[];
};

export type SourceToProjectVerificationRunResult = {
  outputDir: string;
  generationEvaluationId: string;
  promptfoo: {
    generationEvaluationId: string;
    judgeEvaluationId: string;
  };
  scorecard: ProjectVerificationScorecard;
  passed: boolean;
};

type PromptfooSummary = { results?: ProjectVerificationExecutionRow[] } & Record<string, unknown>;

export async function runSourceToProjectVerification(
  options: RunSourceToProjectVerificationOptions = {},
  deps: RunSourceToProjectVerificationDeps = {},
): Promise<SourceToProjectVerificationRunResult> {
  assertRunOptions(options);
  const definition = loadProjectVerificationCase(
    options.casePath ?? DEFAULT_PROJECT_VERIFICATION_CASE_PATH,
  );
  const now = deps.now?.() ?? new Date();
  const caseSha256 = await fingerprintProjectVerificationCase(definition);
  const judges = deps.judges ?? createDefaultSourceToProjectJudgePanel();
  const judgeModels = judges.map((judge) => judge.id);
  const baseline = options.baselinePath
    ? await loadBaseline(options.baselinePath, definition.id, caseSha256, judgeModels)
    : undefined;
  const createdAt = now.toISOString();
  const timestamp = createdAt.replace(/[:.]/g, "-");
  const collected = options.rejudgeFrom
    ? await loadProjectVerificationRejudgeSource({
        sourceDir: options.rejudgeFrom,
        expectedCaseId: definition.id,
        expectedCaseSha256: caseSha256,
        timestamp,
      })
    : await collectProviderPlans({
        definition,
        caseSha256,
        options,
        deps,
        createdAt,
        timestamp,
      });
  const verifiedPlans = await verifyProjectVerificationManifest(
    collected.manifest,
    collected.artifactRootDir,
  );
  if (options.rejudgeFrom) await allocateExclusiveOutputDirectory(collected.outputDir);
  await persistGenerationArtifacts({
    outputDir: collected.outputDir,
    promptfooSummary: collected.promptfooSummary,
    manifest: collected.manifest,
  });
  const usableProviderIds = new Set(
    collected.manifest.artifacts
      .filter((artifact) => artifact.generationSucceeded && artifact.workspaceMutationVerified)
      .map((artifact) => artifact.providerId),
  );
  const plans = verifiedPlans.filter((plan) => usableProviderIds.has(plan.providerId));
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
  const judgeEvaluation = await runPromptfooJudging({
    definition,
    manifest: collected.manifest,
    plans,
    judges,
    caseJson,
    createdAt,
    sourceManifestPath:
      "sourceManifestPath" in collected
        ? collected.sourceManifestPath
        : join(collected.outputDir, "manifest.json"),
    ...(options.rejudgeFrom ? { replayId: createdAt } : {}),
    ...(options.matrixRunId ? { matrixRunId: options.matrixRunId } : {}),
    ...(options.trial !== undefined ? { trial: options.trial } : {}),
    runPromptfoo: deps.runPromptfoo ?? runPersistedPromptfooEvaluation,
  });
  const panel = judgeEvaluation.panel;
  const planMarkdownByProvider = new Map(
    plans.map((plan) => [plan.providerId, plan.markdown] as const),
  );
  const qualities = collected.manifest.artifacts
    .filter((artifact) => artifact.generationSucceeded && artifact.workspaceMutationVerified)
    .map((artifact) =>
      aggregatePlanQuality({
        definition,
        providerId: artifact.providerId,
        planMarkdown: planMarkdownByProvider.get(artifact.providerId)!,
        judgeIds: judges.map((judge) => judge.id),
        records: panel.absolute,
      }),
    );
  const scorecard = buildProjectVerificationScorecard({
    definition,
    manifest: collected.manifest,
    qualities,
    pairwise: panel.pairwise,
    createdAt,
    judgeModels,
    judgeEvaluationId: judgeEvaluation.evaluationId,
    ...(baseline ? { baseline: { path: options.baselinePath!, scorecard: baseline } } : {}),
    ...(options.minimumWeavekitDelta !== undefined
      ? { minimumWeavekitDelta: options.minimumWeavekitDelta }
      : {}),
  });
  await persistFinalArtifacts({
    outputDir: collected.outputDir,
    panel,
    scorecard,
    judgePromptfoo: {
      evaluationId: judgeEvaluation.evaluationId,
      summary: judgeEvaluation.summary,
      generationEvaluationId: collected.manifest.promptfooGenerationEvaluationId,
    },
  });
  const passed =
    scorecard.providers.length > 0 &&
    scorecard.providers.every(
      (provider) =>
        provider.generationSucceeded && provider.workspaceMutationVerified && provider.qualityValid,
    ) &&
    scorecard.baselineComparison?.passed !== false;
  return {
    outputDir: collected.outputDir,
    generationEvaluationId: collected.manifest.promptfooGenerationEvaluationId,
    promptfoo: {
      generationEvaluationId: collected.manifest.promptfooGenerationEvaluationId,
      judgeEvaluationId: judgeEvaluation.evaluationId,
    },
    scorecard,
    passed,
  };
}

async function runPromptfooJudging(args: {
  definition: ReturnType<typeof loadProjectVerificationCase>;
  manifest: ProjectVerificationManifest;
  plans: Awaited<ReturnType<typeof verifyProjectVerificationManifest>>;
  judges: SourceToProjectPlanJudge[];
  caseJson: string;
  createdAt: string;
  sourceManifestPath: string;
  replayId?: string;
  matrixRunId?: string;
  trial?: number;
  runPromptfoo: typeof runPersistedPromptfooEvaluation;
}): Promise<{
  panel: ProjectVerificationJudgePanelResult;
  evaluationId: string;
  summary: EvaluateSummaryV3;
}> {
  const judgeIds = args.judges.map(({ id }) => id);
  const judgeProviders = createPromptfooJudgeProviders(args.judges);
  const judgeSuite = buildPromptfooJudgeSuite({
    manifest: args.manifest,
    plans: args.plans,
    caseJson: args.caseJson,
    caseId: args.definition.id,
    trialId: args.createdAt,
    judgeProviders,
  });
  const evaluation = await args.runPromptfoo({
    suite: judgeSuite.suite,
    description: `Source-to-project verification judging for ${args.definition.id} trial ${args.createdAt}`,
    tags: {
      workflow: "source-to-project",
      phase: "judge",
      runId: args.createdAt,
      caseId: args.definition.id,
      ...(args.matrixRunId ? { matrixRunId: args.matrixRunId } : {}),
      ...(args.trial !== undefined ? { trial: String(args.trial) } : {}),
      ...(args.replayId ? { replayId: args.replayId } : {}),
      parentEvaluationId: args.manifest.promptfooGenerationEvaluationId,
      sourceManifestPath: args.sourceManifestPath,
    },
    cache: false,
    maxConcurrency: 1,
  });
  return {
    evaluationId: evaluation.evaluationId,
    summary: evaluation.summary,
    panel: projectPromptfooJudgeResults({
      summary: evaluation.summary,
      tasks: judgeSuite.tasks,
      judgeIds,
    }),
  };
}

async function collectProviderPlans(args: {
  definition: ReturnType<typeof loadProjectVerificationCase>;
  caseSha256: string;
  options: RunSourceToProjectVerificationOptions;
  deps: RunSourceToProjectVerificationDeps;
  createdAt: string;
  timestamp: string;
}): Promise<{
  outputDir: string;
  artifactRootDir: string;
  manifest: ProjectVerificationManifest;
  promptfooSummary: PromptfooSummary;
}> {
  const outputDir = join(
    args.options.resultsDir ?? "evals/source-to-project/results",
    args.timestamp,
  );
  await allocateExclusiveOutputDirectory(outputDir);
  const providers =
    args.deps.providers ??
    createProjectVerificationProviders({
      definition: args.definition,
      artifactsDir: join(outputDir, "providers"),
      providerIds: args.options.providerIds,
    });
  const suite = buildProjectVerificationSuite(args.definition, { providers });
  const evaluation = await (args.deps.runPromptfoo ?? runPersistedPromptfooEvaluation)({
    suite,
    description: `Source-to-project verification generation for ${args.definition.id} trial ${args.createdAt}`,
    tags: {
      workflow: "source-to-project",
      phase: "generation",
      runId: args.createdAt,
      caseId: args.definition.id,
      ...(args.options.matrixRunId ? { matrixRunId: args.options.matrixRunId } : {}),
      ...(args.options.trial !== undefined ? { trial: String(args.options.trial) } : {}),
    },
    cache: false,
    maxConcurrency: args.options.maxConcurrency ?? 1,
  });
  const promptfooSummary = sanitizePersistedErrorFields(
    evaluation.summary as unknown as PromptfooSummary,
  );
  const manifest = await buildProjectVerificationManifest({
    caseId: args.definition.id,
    caseSha256: args.caseSha256,
    createdAt: args.createdAt,
    promptfooGenerationEvaluationId: evaluation.evaluationId,
    rows: promptfooSummary.results ?? [],
  });
  return { outputDir, artifactRootDir: outputDir, manifest, promptfooSummary };
}

async function allocateExclusiveOutputDirectory(outputDir: string): Promise<void> {
  await mkdir(dirname(outputDir), { recursive: true });
  await mkdir(outputDir);
}

async function persistGenerationArtifacts(args: {
  outputDir: string;
  promptfooSummary: PromptfooSummary;
  manifest: ProjectVerificationManifest;
}): Promise<void> {
  await Promise.all([
    writeJson(join(args.outputDir, "promptfoo-report.json"), args.promptfooSummary),
    writeJson(join(args.outputDir, "promptfoo-evaluation.json"), {
      evaluationId: args.manifest.promptfooGenerationEvaluationId,
    }),
    writeJson(join(args.outputDir, "manifest.json"), args.manifest),
  ]);
}

async function persistFinalArtifacts(args: {
  outputDir: string;
  panel: ProjectVerificationJudgePanelResult;
  scorecard: ProjectVerificationScorecard;
  judgePromptfoo?: {
    evaluationId: string;
    generationEvaluationId: string;
    summary: EvaluateSummaryV3;
  };
}): Promise<void> {
  await Promise.all([
    writeJson(join(args.outputDir, "scores.json"), args.scorecard),
    writeFile(
      join(args.outputDir, "summary.md"),
      renderProjectVerificationSummary(args.scorecard),
      "utf8",
    ),
    persistJudgments(args.outputDir, args.panel),
    ...(args.judgePromptfoo
      ? [
          writeJson(
            join(args.outputDir, "promptfoo-judge-report.json"),
            args.judgePromptfoo.summary,
          ),
          writeJson(join(args.outputDir, "promptfoo-judge-evaluation.json"), {
            evaluationId: args.judgePromptfoo.evaluationId,
          }),
          writeJson(join(args.outputDir, "promptfoo-evaluations.json"), {
            generationEvaluationId: args.judgePromptfoo.generationEvaluationId,
            judgeEvaluationId: args.judgePromptfoo.evaluationId,
          }),
        ]
      : []),
  ]);
}

async function persistJudgments(
  outputDir: string,
  panel: ProjectVerificationJudgePanelResult,
): Promise<void> {
  for (const record of panel.absolute) {
    await writeJson(
      join(
        outputDir,
        "judgments",
        "absolute",
        safePathPart(record.providerId),
        `${safePathPart(record.judgeId)}.json`,
      ),
      record,
    );
  }
  for (const comparison of panel.pairwise) {
    const pairDir = comparison.providerIds.map(safePathPart).join("--");
    for (const record of comparison.judgments) {
      await writeJson(
        join(outputDir, "judgments", "pairwise", pairDir, `${safePathPart(record.judgeId)}.json`),
        record,
      );
    }
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

function safePathPart(value: string): string {
  return encodeURIComponent(value);
}

async function loadBaseline(
  path: string,
  expectedCaseId: string,
  expectedCaseSha256: string,
  expectedJudgeModels: string[],
): Promise<ProjectVerificationScorecard> {
  const scorecard = parseProjectVerificationScorecard(JSON.parse(await readFile(path, "utf8")));
  if (scorecard.caseId !== expectedCaseId) {
    throw new Error(
      `Baseline case ${scorecard.caseId} does not match current case ${expectedCaseId}.`,
    );
  }
  if (scorecard.caseSha256 !== expectedCaseSha256) {
    throw new Error(`Baseline case fingerprint does not match current case.`);
  }
  if (
    scorecard.judgeModels.length !== expectedJudgeModels.length ||
    scorecard.judgeModels.some((model, index) => model !== expectedJudgeModels[index])
  ) {
    throw new Error(`Baseline judge panel does not match current judge panel.`);
  }
  return scorecard;
}

function assertRunOptions(options: RunSourceToProjectVerificationOptions): void {
  if (
    options.maxConcurrency !== undefined &&
    (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1)
  ) {
    throw new Error("maxConcurrency must be an integer >= 1.");
  }
  if (options.minimumWeavekitDelta !== undefined && !options.baselinePath) {
    throw new Error("minimumWeavekitDelta requires a baselinePath.");
  }
  if (
    options.minimumWeavekitDelta !== undefined &&
    (!Number.isFinite(options.minimumWeavekitDelta) ||
      options.minimumWeavekitDelta < -1 ||
      options.minimumWeavekitDelta > 1)
  ) {
    throw new Error("minimumWeavekitDelta must be between -1 and 1.");
  }
  if (
    options.rejudgeFrom &&
    (options.providerIds || options.resultsDir || options.maxConcurrency)
  ) {
    throw new Error(
      "rejudgeFrom cannot be combined with providerIds, resultsDir, or maxConcurrency.",
    );
  }
}
