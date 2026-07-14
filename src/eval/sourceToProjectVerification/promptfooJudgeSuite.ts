import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ApiProvider,
  AssertionValueFunction,
  EvaluateTestSuite,
  GradingResult,
  TestCase,
} from "promptfoo";
import { z } from "zod";
import type {
  SourceToProjectPairwiseJudgment,
  SourceToProjectPlanJudgment,
} from "../../generated/baml_client/types.js";
import { validateAbsoluteJudgeResult, validatePairwiseJudgeBounds } from "./evidenceValidation.js";
import type { ProjectVerificationManifest, VerifiedPlanArtifact } from "./manifest.js";
import { shouldSwapPairwiseOrder } from "./judge.js";
import {
  formatPromptfooJudgeFailure,
  parsePromptfooJudgeTask,
  type PromptfooJudgeTask,
} from "./promptfooJudgeProvider.js";

export type BuildPromptfooJudgeSuiteArgs = {
  manifest: ProjectVerificationManifest;
  plans: VerifiedPlanArtifact[];
  caseJson: string;
  caseId: string;
  trialId: string;
  judgeProviders: ApiProvider[];
};

export type PromptfooJudgeSuite = {
  suite: EvaluateTestSuite;
  tasks: PromptfooJudgeTask[];
};

const NonEmptyStringSchema = z.string().min(1);
const RequirementAssessmentSchema = z
  .object({
    requirementId: NonEmptyStringSchema,
    status: z.enum(["complete", "partial", "missing", "contradicted"]),
    evidenceQuotes: z.array(z.string()),
    gaps: z.array(z.string()),
    rationale: z.string(),
  })
  .strict();
const CriterionAssessmentSchema = z
  .object({
    criterion: NonEmptyStringSchema,
    score: z.number(),
    evidenceQuotes: z.array(z.string()),
    gaps: z.array(z.string()),
    rationale: z.string(),
  })
  .strict();
const AbsoluteResultSchema = z
  .object({
    requirementAssessments: z.array(RequirementAssessmentSchema),
    criterionAssessments: z.array(CriterionAssessmentSchema),
    contradictions: z.array(z.string()),
    unsupportedRecommendations: z.array(z.string()),
    summary: z.string(),
  })
  .strict();
const PairwiseResultSchema = z
  .object({
    winner: z.enum(["plan-a", "plan-b", "tie"]),
    confidence: z.number(),
    decidingFactors: z.array(z.string()),
    planAStrengths: z.array(z.string()),
    planAGaps: z.array(z.string()),
    planBStrengths: z.array(z.string()),
    planBGaps: z.array(z.string()),
    rationale: z.string(),
  })
  .strict();
const CaseContractSchema = z
  .object({
    id: NonEmptyStringSchema,
    requirements: z.array(z.object({ id: NonEmptyStringSchema }).passthrough()),
    criteria: z.array(z.object({ criterion: NonEmptyStringSchema }).passthrough()),
  })
  .passthrough();

type CaseContract = { requirementIds: string[]; criterionIds: string[] };

export function buildPromptfooJudgeSuite(args: BuildPromptfooJudgeSuiteArgs): PromptfooJudgeSuite {
  const caseContract = validateSuiteInputs(args);
  const plans = [...args.plans].sort((left, right) =>
    left.providerId.localeCompare(right.providerId),
  );
  const tasks = buildTasks(args, plans);
  const judgeProviderIds = args.judgeProviders.map((provider) => provider.id());
  const hashes = new Map(
    args.manifest.artifacts.map((artifact) => [artifact.providerId, artifact.sha256!] as const),
  );
  const tests: TestCase[] = tasks.map((task) => ({
    description: describeTask(task),
    vars: { task: JSON.stringify(task) },
    metadata: taskMetadata(task, judgeProviderIds, hashes, args.caseId, args.trialId),
    assert: [
      {
        type: "javascript",
        value: assertionForTask(task, caseContract, judgeProviderIds),
      },
    ],
  }));
  return {
    tasks,
    suite: { providers: args.judgeProviders, prompts: ["{{task}}"], tests },
  };
}

function buildTasks(
  args: BuildPromptfooJudgeSuiteArgs,
  plans: VerifiedPlanArtifact[],
): PromptfooJudgeTask[] {
  const absolute: PromptfooJudgeTask[] = plans.map((plan) => ({
    kind: "absolute",
    caseJson: args.caseJson,
    providerId: plan.providerId,
    planMarkdown: plan.markdown,
  }));
  const pairwise: PromptfooJudgeTask[] = [];
  for (let leftIndex = 0; leftIndex < plans.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < plans.length; rightIndex += 1) {
      const left = plans[leftIndex]!;
      const right = plans[rightIndex]!;
      pairwise.push({
        kind: "pairwise",
        caseId: args.caseId,
        trialId: args.trialId,
        caseJson: args.caseJson,
        providerIds: [left.providerId, right.providerId],
        plans: { [left.providerId]: left.markdown, [right.providerId]: right.markdown },
      });
    }
  }
  return [...absolute, ...pairwise];
}

function taskMetadata(
  task: PromptfooJudgeTask,
  judgeProviderIds: string[],
  hashes: Map<string, string>,
  caseId: string,
  trialId: string,
): Record<string, unknown> {
  const taskProviderIds = task.kind === "absolute" ? [task.providerId] : task.providerIds;
  return {
    taskKind: task.kind,
    taskProviderIds,
    judgeProviderIds,
    artifactHashes: Object.fromEntries(taskProviderIds.map((id) => [id, hashes.get(id)])),
    caseId,
    trialId,
  };
}

function describeTask(task: PromptfooJudgeTask): string {
  return task.kind === "absolute"
    ? `absolute:${task.providerId}`
    : `pairwise:${task.trialId}:${task.providerIds.join(":")}`;
}

function assertionForTask(
  task: PromptfooJudgeTask,
  caseContract: CaseContract,
  judgeProviderIds: string[],
): AssertionValueFunction {
  return async (output, context): Promise<GradingResult> => {
    const taskError = validateRenderedTask(task, context.prompt);
    if (taskError) return failure(taskError);
    const parsed = parseOutput(output);
    if (!parsed.ok) return failure(parsed.error);
    if (task.kind === "absolute") {
      const metadataError = validateResponseMetadata(task, judgeProviderIds, context);
      return metadataError
        ? failure(metadataError)
        : gradeAbsolute(task, caseContract, parsed.value);
    }
    return gradePairwise(task, judgeProviderIds, context, parsed.value);
  };
}

function validateSuiteInputs(args: BuildPromptfooJudgeSuiteArgs): CaseContract {
  if (args.caseId.trim().length === 0) throw new Error("Promptfoo judge case ID is required.");
  if (args.trialId.trim().length === 0) throw new Error("Promptfoo judge trial ID is required.");
  if (args.manifest.caseId !== args.caseId) {
    throw new Error(`Manifest case ID ${args.manifest.caseId} does not match ${args.caseId}.`);
  }
  validateJudgeProviders(args.judgeProviders);
  validatePlans(args.manifest, args.plans);
  return parseCaseContract(args.caseJson, args.caseId);
}

function validateJudgeProviders(providers: ApiProvider[]): void {
  if (providers.length !== 2) {
    throw new Error(
      `Promptfoo judge suite requires exactly two judge providers; found ${providers.length}.`,
    );
  }
  const ids = providers.map((provider) => provider.id());
  if (ids.some((id) => id.trim().length === 0)) {
    throw new Error("Promptfoo judge provider IDs must be non-empty.");
  }
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate judge provider ID.");
}

function validatePlans(manifest: ProjectVerificationManifest, plans: VerifiedPlanArtifact[]): void {
  if (plans.length === 0)
    throw new Error("Promptfoo judge suite requires at least one valid plan.");
  const planIds = plans.map((plan) => plan.providerId);
  const duplicatePlanId = duplicate(planIds);
  if (duplicatePlanId) throw new Error(`Duplicate plan provider ID: ${duplicatePlanId}.`);
  const artifactIds = manifest.artifacts.map((artifact) => artifact.providerId);
  const duplicateArtifactId = duplicate(artifactIds);
  if (duplicateArtifactId)
    throw new Error(`Duplicate manifest provider ID: ${duplicateArtifactId}.`);
  for (const plan of plans) {
    const artifact = manifest.artifacts.find(
      (candidate) => candidate.providerId === plan.providerId,
    );
    if (!artifact) {
      throw new Error(`Plan provider ${plan.providerId} is not present in the frozen manifest.`);
    }
    if (!artifact.generationSucceeded || !artifact.workspaceMutationVerified) {
      throw new Error(`Frozen plan ${plan.providerId} is not valid for judging.`);
    }
    if (!artifact.sha256) throw new Error(`Missing artifact hash for ${plan.providerId}.`);
    const actualHash = sha256(plan.markdown);
    if (actualHash !== artifact.sha256.toLowerCase()) {
      throw new Error(
        `Plan hash mismatch for ${plan.providerId}: expected ${artifact.sha256}, received ${actualHash}.`,
      );
    }
  }
  const missingPlan = manifest.artifacts.find(
    (artifact) =>
      artifact.generationSucceeded &&
      artifact.workspaceMutationVerified &&
      !planIds.includes(artifact.providerId),
  )?.providerId;
  if (missingPlan) throw new Error(`Manifest provider ${missingPlan} has no verified plan.`);
}

function parseCaseContract(caseJson: string, caseId: string): CaseContract {
  let value: unknown;
  try {
    value = JSON.parse(caseJson);
  } catch {
    throw new Error("Promptfoo judge case JSON must be valid JSON.");
  }
  const parsed = CaseContractSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid Promptfoo judge case: ${firstIssue(parsed.error)}`);
  if (parsed.data.id !== caseId) {
    throw new Error(`Case JSON ID ${parsed.data.id} does not match ${caseId}.`);
  }
  const requirementIds = parsed.data.requirements.map((requirement) => requirement.id);
  const criterionIds = parsed.data.criteria.map((criterion) => criterion.criterion);
  const duplicateRequirement = duplicate(requirementIds);
  if (duplicateRequirement)
    throw new Error(`Duplicate case requirement ID: ${duplicateRequirement}.`);
  const duplicateCriterion = duplicate(criterionIds);
  if (duplicateCriterion) throw new Error(`Duplicate case criterion ID: ${duplicateCriterion}.`);
  return { requirementIds, criterionIds };
}

function validateRenderedTask(
  task: PromptfooJudgeTask,
  prompt: string | undefined,
): string | undefined {
  if (!prompt) return "Promptfoo rendered task prompt is missing.";
  const parsed = parsePromptfooJudgeTask(prompt);
  if (!parsed.ok) return parsed.error;
  return isDeepStrictEqual(parsed.task, task)
    ? undefined
    : "Rendered Promptfoo judge task does not match the expected suite task.";
}

function validateResponseMetadata(
  task: PromptfooJudgeTask,
  judgeProviderIds: string[],
  context: Parameters<AssertionValueFunction>[1],
  pairwiseResult?: SourceToProjectPairwiseJudgment,
): string | undefined {
  const providerId = context.provider?.id();
  if (!providerId || !judgeProviderIds.includes(providerId)) {
    return `Unexpected judge provider: ${String(providerId)}.`;
  }
  const metadata = context.metadata;
  if (!metadata || metadata.kind !== task.kind) {
    return `Judge response task kind does not match ${task.kind}.`;
  }
  if (`source-to-project-judge:${String(metadata.judgeId)}` !== providerId) {
    return `Judge response ID ${String(metadata.judgeId)} does not match provider ${providerId}.`;
  }
  if (task.kind === "absolute" && metadata.providerId !== task.providerId) {
    return `Response provider ${String(metadata.providerId)} does not match task provider ${task.providerId}.`;
  }
  if (task.kind === "pairwise" && !sameStrings(metadata.providerIds, task.providerIds)) {
    return "Response pairwise provider IDs do not match the task providers.";
  }
  if (task.kind === "pairwise" && pairwiseResult) {
    return validatePairwiseMapping(task, judgeProviderIds, metadata, pairwiseResult);
  }
  return undefined;
}

function validatePairwiseMapping(
  task: Extract<PromptfooJudgeTask, { kind: "pairwise" }>,
  judgeProviderIds: string[],
  metadata: Record<string, unknown>,
  result: SourceToProjectPairwiseJudgment,
): string | undefined {
  const judgeId = String(metadata.judgeId);
  const judgeIds = judgeProviderIds.map((id) => id.replace(/^source-to-project-judge:/, ""));
  const swap = shouldSwapPairwiseOrder({
    caseId: task.caseId,
    trialId: task.trialId,
    leftProviderId: task.providerIds[0],
    rightProviderId: task.providerIds[1],
    judgeId,
    judgeIds,
  });
  const [planAProviderId, planBProviderId] = swap
    ? [task.providerIds[1], task.providerIds[0]]
    : [task.providerIds[0], task.providerIds[1]];
  if (metadata.planAProviderId !== planAProviderId) {
    return `Response plan A provider ${String(metadata.planAProviderId)} does not match the deterministic mapping.`;
  }
  if (metadata.planBProviderId !== planBProviderId) {
    return `Response plan B provider ${String(metadata.planBProviderId)} does not match the deterministic mapping.`;
  }
  const anonymousOrder = metadata.anonymousOrder;
  if (
    !isRecord(anonymousOrder) ||
    anonymousOrder.planAProviderId !== planAProviderId ||
    anonymousOrder.planBProviderId !== planBProviderId
  ) {
    return "Response anonymous order does not match the deterministic pairwise mapping.";
  }
  if (metadata.anonymousWinner !== result.winner) {
    return "Response anonymous winner does not match the pairwise output winner.";
  }
  const mappedWinner =
    result.winner === "tie"
      ? "tie"
      : result.winner === "plan-a"
        ? planAProviderId
        : planBProviderId;
  if (metadata.mappedWinner !== mappedWinner) {
    return "Response mapped winner does not match the pairwise output and anonymous order.";
  }
  return undefined;
}

function parseOutput(output: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(output) };
  } catch {
    return { ok: false, error: "Judge output must be valid JSON." };
  }
}

function gradeAbsolute(
  task: Extract<PromptfooJudgeTask, { kind: "absolute" }>,
  caseContract: CaseContract,
  value: unknown,
): GradingResult {
  const parsed = AbsoluteResultSchema.safeParse(value);
  if (!parsed.success) return failure(`Invalid absolute judge output: ${firstIssue(parsed.error)}`);
  const errors = validateAbsoluteJudgeResult({
    judgeId: "judge output",
    planMarkdown: task.planMarkdown,
    expectedRequirementIds: caseContract.requirementIds,
    expectedCriterionIds: caseContract.criterionIds,
    result: parsed.data as SourceToProjectPlanJudgment,
  });
  return errors[0] ? failure(errors[0]) : success("Absolute judge output is valid.");
}

function gradePairwise(
  task: Extract<PromptfooJudgeTask, { kind: "pairwise" }>,
  judgeProviderIds: string[],
  context: Parameters<AssertionValueFunction>[1],
  value: unknown,
): GradingResult {
  const parsed = PairwiseResultSchema.safeParse(value);
  if (!parsed.success) return failure(`Invalid pairwise judge output: ${firstIssue(parsed.error)}`);
  const metadataError = validateResponseMetadata(
    task,
    judgeProviderIds,
    context,
    parsed.data as SourceToProjectPairwiseJudgment,
  );
  if (metadataError) return failure(metadataError);
  const errors = validatePairwiseJudgeBounds({
    judgeId: "judge output",
    result: parsed.data as SourceToProjectPairwiseJudgment,
  });
  return errors[0] ? failure(errors[0]) : success("Pairwise judge output is valid.");
}

function success(reason: string): GradingResult {
  return { pass: true, score: 1, reason };
}

function failure(reason: string): GradingResult {
  return {
    pass: false,
    score: 0,
    reason: formatPromptfooJudgeFailure("Promptfoo judge assertion failed", reason),
  };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "output"}: ${issue.message}` : "unknown schema error";
}

function duplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
