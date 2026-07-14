import { z } from "zod";
import type { AggregatedPlanQuality } from "./aggregation.js";
import type { ProjectVerificationCase } from "./case.js";
import type { PairwiseJudgeRecord, ResolvedPairwisePanel } from "./judge.js";
import type { FrozenPlanArtifact, ProjectVerificationManifest } from "./manifest.js";
import {
  WeavekitOpportunityDiagnosticsSchema,
  type WeavekitOpportunityDiagnostics,
} from "./weavekitDiagnostics.js";

export const ProjectVerificationProviderId = {
  WEAVEKIT: "weavekit:source-to-project",
  COPILOT: "copilot-cli:plan",
  CODEX: "codex-cli:plan",
} as const;

export type ProjectVerificationProviderId =
  (typeof ProjectVerificationProviderId)[keyof typeof ProjectVerificationProviderId];

export type ProjectVerificationProviderScore = {
  id: string;
  generationSucceeded: boolean;
  workspaceMutationVerified: boolean;
  qualityValid: boolean;
  score?: number;
  criteria: Record<string, number>;
  practiceScores: Record<string, number>;
  requirementScores: Record<string, number>;
  artifactPath?: string;
  sha256?: string;
  model?: string;
  latencyMs?: number;
  tokenUsage?: Record<string, number>;
  estimatedCostUsd?: number;
  retries?: number;
  opportunityDiagnostics?: WeavekitOpportunityDiagnostics;
  errors: string[];
  contradictions: string[];
  unsupportedRecommendations: string[];
};

export type ProjectVerificationScorecard = {
  version: 2;
  caseId: string;
  caseSha256: string;
  title: string;
  createdAt: string;
  judgeModels: string[];
  promptfoo: {
    generationEvaluationId: string;
    judgeEvaluationId: string;
  };
  providers: ProjectVerificationProviderScore[];
  comparisons: {
    pairs: ResolvedPairwisePanel[];
    weavekitMinusCopilot?: number;
    weavekitMinusCodex?: number;
  };
  baselineComparison?: {
    path: string;
    baselineScore: number;
    currentScore: number;
    delta: number;
    minimumDelta: number;
    passed: boolean;
  };
};

const PairwiseJudgmentSchema = z
  .object({
    winner: z.enum(["plan-a", "plan-b", "tie"]),
    confidence: z.number().finite().min(0).max(1),
    decidingFactors: z.array(z.string()),
    planAStrengths: z.array(z.string()),
    planAGaps: z.array(z.string()),
    planBStrengths: z.array(z.string()),
    planBGaps: z.array(z.string()),
    rationale: z.string(),
  })
  .strict();

type JudgeTokenUsageValue = number | { [key: string]: JudgeTokenUsageValue };
const NonnegativeAccountingNumberSchema = z.number().finite().nonnegative();
const JudgeTokenUsageValueSchema: z.ZodType<JudgeTokenUsageValue> = z.lazy(() =>
  z.union([NonnegativeAccountingNumberSchema, z.record(z.string(), JudgeTokenUsageValueSchema)]),
);
const JudgeTokenUsageSchema = z.record(z.string(), JudgeTokenUsageValueSchema);

const PairwiseJudgeRecordSchema = z
  .object({
    judgeId: z.string(),
    bamlClientName: z.string().optional(),
    planAProviderId: z.string(),
    planBProviderId: z.string(),
    elapsedMs: z.number().finite().nonnegative(),
    mappedWinner: z.string().optional(),
    result: PairwiseJudgmentSchema.optional(),
    error: z.string().optional(),
    reason: z.string().optional(),
    tokenUsage: JudgeTokenUsageSchema.optional(),
    cost: NonnegativeAccountingNumberSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const hasResult = record.result !== undefined;
    const hasError = record.error !== undefined;
    if (hasResult === hasError) {
      context.addIssue({
        code: "custom",
        message: "A pairwise judgment must contain exactly one of result or error.",
      });
      return;
    }
    if (!record.result) {
      if (record.mappedWinner !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["mappedWinner"],
          message: "A failed pairwise judgment cannot contain mappedWinner.",
        });
      }
      return;
    }
    const expectedWinner =
      record.result.winner === "tie"
        ? "tie"
        : record.result.winner === "plan-a"
          ? record.planAProviderId
          : record.planBProviderId;
    if (record.mappedWinner !== expectedWinner) {
      context.addIssue({
        code: "custom",
        path: ["mappedWinner"],
        message: `mappedWinner must be ${expectedWinner} for the stored pairwise result.`,
      });
    }
  }) satisfies z.ZodType<PairwiseJudgeRecord>;

const FrozenPairSchema = z
  .object({
    providerIds: z.tuple([z.string(), z.string()]),
    status: z.enum(["agreed", "disputed", "single-judge", "invalid"]),
    winner: z.string().optional(),
    judgments: z.array(PairwiseJudgeRecordSchema),
  })
  .strict()
  .superRefine((pair, context) => {
    const providerIds = new Set(pair.providerIds);
    if (providerIds.size !== 2) {
      context.addIssue({
        code: "custom",
        path: ["providerIds"],
        message: "A pairwise panel must contain two distinct providers.",
      });
    }
    for (const [index, judgment] of pair.judgments.entries()) {
      const judgmentProviders = new Set([judgment.planAProviderId, judgment.planBProviderId]);
      if (
        judgmentProviders.size !== 2 ||
        judgmentProviders.size !== providerIds.size ||
        [...judgmentProviders].some((providerId) => !providerIds.has(providerId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["judgments", index],
          message: "Judgment providers must be the panel's two distinct providers.",
        });
      }
    }
    const resolved = pair.status === "agreed" || pair.status === "single-judge";
    if (resolved && pair.winner === undefined) {
      context.addIssue({
        code: "custom",
        path: ["winner"],
        message: `${pair.status} pairwise panels require a winner.`,
      });
    }
    if (!resolved && pair.winner !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["winner"],
        message: `${pair.status} pairwise panels cannot contain a winner.`,
      });
    }
    if (pair.winner !== undefined && pair.winner !== "tie" && !providerIds.has(pair.winner)) {
      context.addIssue({
        code: "custom",
        path: ["winner"],
        message: "Pairwise panel winner must be tie or one of the panel providers.",
      });
    }
    if (
      resolved &&
      pair.winner !== undefined &&
      pair.judgments.some(
        (judgment) => judgment.result !== undefined && judgment.mappedWinner !== pair.winner,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["winner"],
        message: "Resolved panel winner must match every successful judgment.",
      });
    }
    const validWinners = pair.judgments.flatMap((judgment) =>
      judgment.result !== undefined && judgment.mappedWinner !== undefined
        ? [judgment.mappedWinner]
        : [],
    );
    const distinctWinners = new Set(validWinners);
    const expectedStatus =
      validWinners.length === 0
        ? "invalid"
        : validWinners.length === 1
          ? "single-judge"
          : distinctWinners.size === 1
            ? "agreed"
            : "disputed";
    const expectedWinner =
      expectedStatus === "agreed" || expectedStatus === "single-judge"
        ? validWinners[0]
        : undefined;
    if (pair.status !== expectedStatus || pair.winner !== expectedWinner) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `Panel resolution must be ${expectedStatus}${expectedWinner ? ` with winner ${expectedWinner}` : " without a winner"} for its stored judgments.`,
      });
    }
  });

const NormalizedScoreSchema = z.number().finite().min(0).max(1);
const ScoreDeltaSchema = z.number().finite().min(-1).max(1);

const ProviderScoreSchema = z
  .object({
    id: z.string(),
    generationSucceeded: z.boolean(),
    workspaceMutationVerified: z.boolean(),
    qualityValid: z.boolean(),
    score: NormalizedScoreSchema.optional(),
    criteria: z.record(z.string(), NormalizedScoreSchema),
    practiceScores: z.record(z.string(), NormalizedScoreSchema),
    requirementScores: z.record(z.string(), NormalizedScoreSchema),
    artifactPath: z.string().optional(),
    sha256: z.string().optional(),
    model: z.string().optional(),
    latencyMs: z.number().finite().nonnegative().optional(),
    tokenUsage: z.record(z.string(), z.number().finite().nonnegative()).optional(),
    estimatedCostUsd: z.number().finite().nonnegative().optional(),
    retries: z.number().int().nonnegative().optional(),
    opportunityDiagnostics: WeavekitOpportunityDiagnosticsSchema.optional(),
    errors: z.array(z.string()),
    contradictions: z.array(z.string()),
    unsupportedRecommendations: z.array(z.string()),
  })
  .superRefine((provider, context) => {
    if (provider.qualityValid === (provider.score === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["score"],
        message: provider.qualityValid
          ? "A quality-valid provider requires a finite score."
          : "A quality-invalid provider cannot contain a score.",
      });
    }
    if (
      provider.qualityValid &&
      (!provider.generationSucceeded || !provider.workspaceMutationVerified)
    ) {
      context.addIssue({
        code: "custom",
        path: ["qualityValid"],
        message: "Quality can be valid only after successful generation and mutation verification.",
      });
    }
    if (
      provider.qualityValid &&
      (Object.keys(provider.criteria).length === 0 ||
        Object.keys(provider.practiceScores).length === 0 ||
        Object.keys(provider.requirementScores).length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["criteria"],
        message: "A quality-valid provider requires criterion, practice, and requirement scores.",
      });
    }
  });

const ProviderScoresSchema = z.array(ProviderScoreSchema).superRefine((providers, context) => {
  const seen = new Set<string>();
  for (const [index, provider] of providers.entries()) {
    if (seen.has(provider.id)) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: `Duplicate provider id: ${provider.id}.`,
      });
    }
    seen.add(provider.id);
  }
});

const ScorecardSchema = z
  .object({
    version: z.literal(2),
    caseId: z.string(),
    caseSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    title: z.string(),
    createdAt: z.string(),
    judgeModels: z.array(z.string()).min(1),
    promptfoo: z
      .object({
        generationEvaluationId: z.string().min(1),
        judgeEvaluationId: z.string().min(1),
      })
      .strict(),
    providers: ProviderScoresSchema,
    comparisons: z.object({
      pairs: z.array(FrozenPairSchema),
      weavekitMinusCopilot: ScoreDeltaSchema.optional(),
      weavekitMinusCodex: ScoreDeltaSchema.optional(),
    }),
    baselineComparison: z
      .object({
        path: z.string(),
        baselineScore: NormalizedScoreSchema,
        currentScore: NormalizedScoreSchema,
        delta: ScoreDeltaSchema,
        minimumDelta: ScoreDeltaSchema,
        passed: z.boolean(),
      })
      .optional(),
  })
  .strict();

type BuildProjectVerificationScorecardArgs = {
  definition: ProjectVerificationCase;
  manifest: ProjectVerificationManifest;
  qualities: AggregatedPlanQuality[];
  pairwise: ResolvedPairwisePanel[];
  createdAt: string;
  judgeModels: string[];
  baseline?: { path: string; scorecard: ProjectVerificationScorecard };
  minimumWeavekitDelta?: number;
  judgeEvaluationId: string;
};

export function buildProjectVerificationScorecard(
  args: BuildProjectVerificationScorecardArgs,
): ProjectVerificationScorecard {
  const qualityByProvider = new Map(args.qualities.map((quality) => [quality.providerId, quality]));
  const providers = args.manifest.artifacts
    .map((artifact) => providerScore(artifact, qualityByProvider.get(artifact.providerId)))
    .sort(
      (left, right) =>
        (right.score ?? Number.NEGATIVE_INFINITY) - (left.score ?? Number.NEGATIVE_INFINITY) ||
        left.id.localeCompare(right.id),
    );
  const weavekitScore = validScore(providers, ProjectVerificationProviderId.WEAVEKIT);
  const copilotScore = validScore(providers, ProjectVerificationProviderId.COPILOT);
  const codexScore = validScore(providers, ProjectVerificationProviderId.CODEX);
  if (args.baseline && args.baseline.scorecard.caseId !== args.definition.id) {
    throw new Error(
      `Baseline ${args.baseline.path}: case ${args.baseline.scorecard.caseId} does not match ${args.definition.id}.`,
    );
  }
  if (args.baseline && args.baseline.scorecard.caseSha256 !== args.manifest.caseSha256) {
    throw new Error(
      `Baseline ${args.baseline.path}: case fingerprint does not match current case.`,
    );
  }
  if (args.baseline && !sameStrings(args.baseline.scorecard.judgeModels, args.judgeModels)) {
    throw new Error(
      `Baseline ${args.baseline.path}: judge panel does not match current judge panel.`,
    );
  }
  const baselineScore = args.baseline
    ? validScore(args.baseline.scorecard.providers, ProjectVerificationProviderId.WEAVEKIT)
    : undefined;
  if (args.baseline && baselineScore === undefined) {
    throw new Error(`Baseline ${args.baseline.path}: Weavekit has no valid quality score.`);
  }
  const minimumDelta = args.minimumWeavekitDelta ?? 0;
  const baselineComparison =
    args.baseline && baselineScore !== undefined && weavekitScore !== undefined
      ? {
          path: args.baseline.path,
          baselineScore,
          currentScore: weavekitScore,
          delta: round(weavekitScore - baselineScore),
          minimumDelta,
          passed: round(weavekitScore - baselineScore) >= minimumDelta,
        }
      : undefined;
  return {
    version: 2,
    caseId: args.definition.id,
    caseSha256: args.manifest.caseSha256,
    title: args.definition.title,
    createdAt: args.createdAt,
    judgeModels: args.judgeModels,
    promptfoo: {
      generationEvaluationId: args.manifest.promptfooGenerationEvaluationId,
      judgeEvaluationId: args.judgeEvaluationId,
    },
    providers,
    comparisons: {
      pairs: args.pairwise,
      ...(weavekitScore !== undefined && copilotScore !== undefined
        ? { weavekitMinusCopilot: round(weavekitScore - copilotScore) }
        : {}),
      ...(weavekitScore !== undefined && codexScore !== undefined
        ? { weavekitMinusCodex: round(weavekitScore - codexScore) }
        : {}),
    },
    ...(baselineComparison ? { baselineComparison } : {}),
  };
}

export function renderProjectVerificationSummary(scorecard: ProjectVerificationScorecard): string {
  return [
    "# Source-to-Project Verification Summary",
    "",
    `- Case: ${safeMarkdownText(scorecard.caseId)} - ${safeMarkdownText(scorecard.title)}`,
    `- Judges: ${scorecard.judgeModels.map(safeMarkdownText).join(", ")}`,
    `- Created: ${safeMarkdownText(scorecard.createdAt)}`,
    `- Promptfoo evaluations: generation \`${safeMarkdownText(scorecard.promptfoo.generationEvaluationId)}\`; judge \`${safeMarkdownText(scorecard.promptfoo.judgeEvaluationId)}\` (open with \`nubx promptfoo view\`)`,
    "",
    "## Absolute plan quality",
    "",
    "| Provider | Score | Quality valid |",
    "| --- | ---: | :---: |",
    ...scorecard.providers.map(
      (provider) =>
        `| ${safeMarkdownText(providerLabel(provider.id))} | ${provider.score === undefined ? "n/a" : provider.score.toFixed(3)} | ${provider.qualityValid ? "yes" : "no"} |`,
    ),
    "",
    "## Pairwise preference",
    "",
    "| Comparison | Panel status | Winner |",
    "| --- | --- | --- |",
    ...(scorecard.comparisons.pairs.length > 0
      ? scorecard.comparisons.pairs.map(
          (pair) =>
            `| ${pair.providerIds.map((id) => safeMarkdownText(providerLabel(id))).join(" vs ")} | ${pair.status} | ${pair.winner === "tie" ? "Tie" : pair.winner ? safeMarkdownText(providerLabel(pair.winner)) : "n/a"} |`,
        )
      : ["| None | n/a | n/a |"]),
    "",
    "## Generation and mutation safety",
    "",
    "| Provider | Generated | Mutation safe |",
    "| --- | :---: | :---: |",
    ...scorecard.providers.map(
      (provider) =>
        `| ${safeMarkdownText(providerLabel(provider.id))} | ${provider.generationSucceeded ? "yes" : "no"} | ${provider.workspaceMutationVerified ? "yes" : "no"} |`,
    ),
    "",
    "## Failure details",
    "",
    ...failureDetailRows(scorecard),
    "",
    "## Efficiency",
    "",
    "| Provider | Latency ms | Tokens | Estimated cost USD | Retries | Model |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...scorecard.providers.map(
      (provider) =>
        `| ${safeMarkdownText(providerLabel(provider.id))} | ${provider.latencyMs ?? "n/a"} | ${totalTokens(provider.tokenUsage) ?? "n/a"} | ${provider.estimatedCostUsd?.toFixed(6) ?? "n/a"} | ${provider.retries ?? "n/a"} | ${safeMarkdownText(provider.model ?? "n/a")} |`,
    ),
    "",
    ...opportunityDiagnosticRows(scorecard),
    "## Score deltas",
    "",
    "| Comparison | Delta |",
    "| --- | ---: |",
    ...(scoreDeltaRows(scorecard).length > 0 ? scoreDeltaRows(scorecard) : ["| None | n/a |"]),
    "",
  ].join("\n");
}

export function parseProjectVerificationScorecard(input: unknown): ProjectVerificationScorecard {
  return ScorecardSchema.parse(input) as ProjectVerificationScorecard;
}

function providerScore(
  artifact: FrozenPlanArtifact,
  quality: AggregatedPlanQuality | undefined,
): ProjectVerificationProviderScore {
  const qualityValid =
    artifact.generationSucceeded && artifact.workspaceMutationVerified && quality?.valid === true;
  return {
    id: artifact.providerId,
    generationSucceeded: artifact.generationSucceeded,
    workspaceMutationVerified: artifact.workspaceMutationVerified,
    qualityValid,
    ...(qualityValid && quality.score !== undefined ? { score: quality.score } : {}),
    criteria: qualityValid ? quality.criteria : {},
    practiceScores: qualityValid ? quality.practiceScores : {},
    requirementScores: qualityValid ? quality.requirementScores : {},
    ...(artifact.planPath ? { artifactPath: artifact.planPath } : {}),
    ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    ...(artifact.model ? { model: artifact.model } : {}),
    ...(artifact.latencyMs !== undefined ? { latencyMs: artifact.latencyMs } : {}),
    ...(artifact.tokenUsage ? { tokenUsage: { ...artifact.tokenUsage } } : {}),
    ...(artifact.estimatedCostUsd !== undefined
      ? { estimatedCostUsd: artifact.estimatedCostUsd }
      : {}),
    ...(artifact.retries !== undefined ? { retries: artifact.retries } : {}),
    ...(artifact.opportunityDiagnostics
      ? { opportunityDiagnostics: artifact.opportunityDiagnostics }
      : {}),
    errors: unique([...artifact.errors, ...(quality?.errors ?? [])]),
    contradictions: quality?.contradictions ?? [],
    unsupportedRecommendations: quality?.unsupportedRecommendations ?? [],
  };
}

function validScore(
  providers: ProjectVerificationProviderScore[],
  providerId: string,
): number | undefined {
  const provider = providers.find((candidate) => candidate.id === providerId);
  return provider?.qualityValid && Number.isFinite(provider.score) ? provider.score : undefined;
}

function scoreDeltaRows(scorecard: ProjectVerificationScorecard): string[] {
  return [
    scorecard.comparisons.weavekitMinusCopilot === undefined
      ? undefined
      : `| Weavekit vs Copilot | ${formatDelta(scorecard.comparisons.weavekitMinusCopilot)} |`,
    scorecard.comparisons.weavekitMinusCodex === undefined
      ? undefined
      : `| Weavekit vs Codex | ${formatDelta(scorecard.comparisons.weavekitMinusCodex)} |`,
    scorecard.baselineComparison
      ? `| Weavekit delta | ${formatDelta(scorecard.baselineComparison.delta)} |`
      : undefined,
  ].filter((row): row is string => Boolean(row));
}

function failureDetailRows(scorecard: ProjectVerificationScorecard): string[] {
  const providerFailures = scorecard.providers.flatMap((provider) =>
    provider.errors.map(
      (error) =>
        `- Provider ${safeMarkdownText(providerLabel(provider.id))}: ${safeMarkdownText(error)}`,
    ),
  );
  const pairwiseFailures = scorecard.comparisons.pairs.flatMap((pair) =>
    pair.judgments.flatMap((judgment) =>
      judgment.error !== undefined
        ? [
            `- Pairwise ${pair.providerIds.map((id) => safeMarkdownText(providerLabel(id))).join(" vs ")} (judge ${safeMarkdownText(judgment.judgeId)}): ${safeMarkdownText(judgment.error)}`,
          ]
        : [],
    ),
  );
  const failures = unique([...providerFailures, ...pairwiseFailures]);
  return failures.length > 0 ? failures : ["- None."];
}

function safeMarkdownText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const withoutRawHtml = normalized
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return withoutRawHtml.replace(/([\\`*_[\]~|])/g, "\\$1");
}

function formatDelta(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function providerLabel(providerId: string): string {
  if (providerId === ProjectVerificationProviderId.WEAVEKIT) return "Weavekit";
  if (providerId === ProjectVerificationProviderId.COPILOT) return "Copilot";
  if (providerId === ProjectVerificationProviderId.CODEX) return "Codex";
  return providerId;
}

function totalTokens(tokenUsage: Record<string, number> | undefined): number | undefined {
  if (!tokenUsage) return undefined;
  if (typeof tokenUsage.total === "number") return tokenUsage.total;
  const values = Object.values(tokenUsage);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function opportunityDiagnosticRows(scorecard: ProjectVerificationScorecard): string[] {
  const diagnostics = scorecard.providers.find(
    (provider) => provider.id === ProjectVerificationProviderId.WEAVEKIT,
  )?.opportunityDiagnostics;
  if (!diagnostics) return [];
  return [
    "## Weavekit opportunity diagnostics",
    "",
    "These diagnostics are non-scoring workflow-funnel evidence.",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Discovered opportunities | ${diagnostics.discoveredOpportunityCount} |`,
    `| Accepted opportunities | ${diagnostics.acceptedOpportunityCount} |`,
    `| Rejected opportunities | ${diagnostics.rejectedOpportunityCount} |`,
    `| Bundles | ${diagnostics.bundleCount} |`,
    `| Planned opportunity IDs | ${formatSafeList(diagnostics.plannedOpportunityIds)} |`,
    `| Accepted-opportunity retention | ${formatOptionalRatio(diagnostics.acceptedOpportunityRetention)} |`,
    `| Rejected opportunity IDs restored | ${formatSafeList(diagnostics.rejectedOpportunityIdsRestored)} |`,
    `| Expected-practice recall before planning | ${formatOptionalRatio(diagnostics.expectedPracticeRecallBeforePlanning)} |`,
    `| Accepted-practice retention | ${formatOptionalRatio(diagnostics.acceptedPracticeRetention)} |`,
    `| Rejected grounded practices restored | ${formatOptionalList(diagnostics.rejectedGroundedPracticesRestored)} |`,
    "",
    ...(diagnostics.bundles.length > 0
      ? [
          "Bundle membership:",
          "",
          ...diagnostics.bundles.map(
            (bundle) =>
              `- ${safeMarkdownText(bundle.id)}: ${formatSafeList(bundle.opportunityIds)}`,
          ),
          "",
        ]
      : []),
    ...diagnostics.overlapOrContradictionFindings.map(
      (finding) => `- Finding: ${safeMarkdownText(finding)}`,
    ),
    ...diagnostics.unavailableMetrics.map((metric) => `- Unavailable: ${safeMarkdownText(metric)}`),
    "",
  ];
}

function formatOptionalRatio(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

function formatOptionalList(value: string[] | null): string {
  return value === null ? "n/a" : formatSafeList(value);
}

function formatSafeList(value: string[]): string {
  return value.length > 0 ? value.map(safeMarkdownText).join(", ") : "none";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
