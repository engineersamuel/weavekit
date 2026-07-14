import { isDeepStrictEqual } from "node:util";
import type { EvaluateResult, EvaluateSummaryV3 } from "promptfoo";
import { z } from "zod";
import type {
  SourceToProjectPairwiseJudgment,
  SourceToProjectPlanJudgment,
} from "../../generated/baml_client/types.js";
import { validateAbsoluteJudgeResult, validatePairwiseJudgeBounds } from "./evidenceValidation.js";
import {
  noAbsoluteJudgeRepairMetadata,
  resolvePairwisePanel,
  shouldSwapPairwiseOrder,
  type AbsoluteJudgeRecord,
  type PairwiseJudgeRecord,
  type ProjectVerificationJudgePanelResult,
} from "./judge.js";
import {
  formatPromptfooJudgeFailure,
  parsePromptfooJudgeTask,
  type PromptfooJudgeTask,
} from "./promptfooJudgeProvider.js";

const RequirementAssessmentSchema = z
  .object({
    requirementId: z.string().min(1),
    status: z.enum(["complete", "partial", "missing", "contradicted"]),
    evidenceQuotes: z.array(z.string()),
    gaps: z.array(z.string()),
    rationale: z.string(),
  })
  .strict();
const CriterionAssessmentSchema = z
  .object({
    criterion: z.string().min(1),
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

type IndexedRow = { row: EvaluateResult; judgeId: string };

export function projectPromptfooJudgeResults(args: {
  summary: EvaluateSummaryV3;
  tasks: PromptfooJudgeTask[];
  judgeIds: string[];
}): ProjectVerificationJudgePanelResult {
  const tasks = validateRuntimeTasks(args.tasks);
  validateInputs(tasks, args.judgeIds);
  const rows = indexRows(args.summary, tasks, args.judgeIds);
  const absolute = tasks
    .filter(
      (task): task is Extract<PromptfooJudgeTask, { kind: "absolute" }> => task.kind === "absolute",
    )
    .flatMap((task) =>
      args.judgeIds.map((judgeId) => projectAbsolute(task, requiredRow(rows, task, judgeId))),
    );
  const pairwise = tasks
    .filter(
      (task): task is Extract<PromptfooJudgeTask, { kind: "pairwise" }> => task.kind === "pairwise",
    )
    .map((task) =>
      resolvePairwisePanel(
        args.judgeIds.map((judgeId) =>
          projectPairwise(task, requiredRow(rows, task, judgeId), args.judgeIds),
        ),
      ),
    );
  return { absolute, pairwise };
}

function validateRuntimeTasks(tasks: PromptfooJudgeTask[]): PromptfooJudgeTask[] {
  return tasks.map((task) => {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(task);
    } catch (error) {
      throw new Error(formatPromptfooJudgeFailure("Invalid Promptfoo judge task", error));
    }
    if (serialized === undefined) {
      throw new Error(
        formatPromptfooJudgeFailure(
          "Invalid Promptfoo judge task",
          "Task is not JSON serializable.",
        ),
      );
    }
    const parsed = parsePromptfooJudgeTask(serialized);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.task;
  });
}

function validateInputs(tasks: PromptfooJudgeTask[], judgeIds: string[]): void {
  if (judgeIds.length === 0) throw new Error("At least one Promptfoo judge ID is required.");
  if (new Set(judgeIds).size !== judgeIds.length) {
    throw new Error("Promptfoo judge IDs must be unique.");
  }
  const descriptions = tasks.map(describeTask);
  if (new Set(descriptions).size !== descriptions.length) {
    throw new Error("Promptfoo judge tasks must have unique identities.");
  }
  const caseIds = new Set(tasks.map(caseId));
  if (caseIds.size !== 1 || caseIds.has(undefined)) {
    throw new Error("Promptfoo judge tasks must share one case identity.");
  }
}

function indexRows(
  summary: EvaluateSummaryV3,
  tasks: PromptfooJudgeTask[],
  judgeIds: string[],
): Map<string, IndexedRow> {
  if (!Array.isArray(summary.results)) {
    throw new Error("Promptfoo judge summary is missing result rows.");
  }
  const tasksByDescription = new Map(tasks.map((task) => [describeTask(task), task]));
  const expectedTrialIds = pairwiseTrialIds(tasks);
  const rows = new Map<string, IndexedRow>();
  for (const row of summary.results) {
    const providerId = row.provider?.id;
    const judgeId = providerId?.replace(/^source-to-project-judge:/, "");
    if (!providerId || !judgeId || providerId !== judgeProviderId(judgeId)) {
      throw new Error(`Promptfoo judge row has an unknown provider: ${String(providerId)}.`);
    }
    if (!judgeIds.includes(judgeId)) {
      throw new Error(`Promptfoo judge row has an unknown judge: ${judgeId}.`);
    }
    const task = tasksByDescription.get(String(row.testCase?.description));
    if (!task) {
      throw new Error(
        `Promptfoo judge row has an unknown task: ${String(row.testCase?.description)}.`,
      );
    }
    validateTaskIdentity(row, task, judgeIds, expectedTrialIds);
    const key = rowKey(task, judgeId);
    if (rows.has(key)) {
      throw new Error(
        `Promptfoo judge summary has a duplicate row for ${describeTask(task)} and ${judgeId}.`,
      );
    }
    rows.set(key, { row, judgeId });
  }
  for (const task of tasks) {
    for (const judgeId of judgeIds) {
      if (!rows.has(rowKey(task, judgeId))) {
        throw new Error(
          `Promptfoo judge summary is missing a row for ${describeTask(task)} and ${judgeId}.`,
        );
      }
    }
  }
  return rows;
}

function validateTaskIdentity(
  row: EvaluateResult,
  task: PromptfooJudgeTask,
  judgeIds: string[],
  expectedTrialIds: Set<string>,
): void {
  const serializedTask = JSON.stringify(task);
  if (row.vars?.task !== serializedTask || row.testCase.vars?.task !== serializedTask) {
    throw new Error(`Promptfoo judge row task identity does not match ${describeTask(task)}.`);
  }
  const metadata = row.testCase.metadata;
  const taskProviderIds = task.kind === "absolute" ? [task.providerId] : task.providerIds;
  const expectedJudgeProviders = judgeIds.map(judgeProviderId);
  const canonicalTrialId = [...expectedTrialIds][0];
  if (
    !metadata ||
    metadata.taskKind !== task.kind ||
    !isDeepStrictEqual(metadata.taskProviderIds, taskProviderIds) ||
    !isDeepStrictEqual(metadata.judgeProviderIds, expectedJudgeProviders) ||
    metadata.caseId !== caseId(task) ||
    (task.kind === "absolute"
      ? canonicalTrialId
        ? metadata.trialId !== canonicalTrialId
        : typeof metadata.trialId !== "string" || metadata.trialId.length === 0
      : metadata.trialId !== task.trialId)
  ) {
    throw new Error(`Promptfoo judge row metadata does not match ${describeTask(task)}.`);
  }
  const hashes = metadata.artifactHashes;
  if (!isRecord(hashes) || !sameKeys(hashes, taskProviderIds)) {
    throw new Error(`Promptfoo judge row metadata does not match ${describeTask(task)}.`);
  }
}

function projectAbsolute(
  task: Extract<PromptfooJudgeTask, { kind: "absolute" }>,
  indexed: IndexedRow,
): AbsoluteJudgeRecord {
  const { row, judgeId } = indexed;
  const metadata = responseMetadata(row);
  const base: AbsoluteJudgeRecord = {
    judgeId,
    ...bamlClient(metadata),
    providerId: task.providerId,
    requirementIds: caseContract(task.caseJson).requirementIds,
    elapsedMs: elapsedMs(row),
    ...repairMetadata(metadata),
    ...rowAccounting(row),
  };
  const failure = rowFailure(row);
  if (failure) return { ...base, ...failure };
  const metadataError = validateAbsoluteMetadata(task, judgeId, metadata);
  if (metadataError) return { ...base, error: metadataError };
  const parsed = parseOutput(row, AbsoluteResultSchema, "absolute");
  if (!parsed.ok) return { ...base, error: parsed.error };
  const result = parsed.value as SourceToProjectPlanJudgment;
  const contract = caseContract(task.caseJson);
  const errors = validateAbsoluteJudgeResult({
    judgeId,
    planMarkdown: task.planMarkdown,
    expectedRequirementIds: contract.requirementIds,
    expectedCriterionIds: contract.criterionIds,
    result,
  });
  return errors[0] ? { ...base, error: errors[0] } : { ...base, result };
}

function projectPairwise(
  task: Extract<PromptfooJudgeTask, { kind: "pairwise" }>,
  indexed: IndexedRow,
  judgeIds: string[],
): PairwiseJudgeRecord {
  const { row, judgeId } = indexed;
  const metadata = responseMetadata(row);
  const [planAProviderId, planBProviderId] = pairwiseOrder(task, judgeId, judgeIds);
  const base: PairwiseJudgeRecord = {
    judgeId,
    ...bamlClient(metadata),
    planAProviderId,
    planBProviderId,
    elapsedMs: elapsedMs(row),
    ...rowAccounting(row),
  };
  const failure = rowFailure(row);
  if (failure) return { ...base, ...failure };
  const parsed = parseOutput(row, PairwiseResultSchema, "pairwise");
  if (!parsed.ok) return { ...base, error: parsed.error };
  const result = parsed.value as SourceToProjectPairwiseJudgment;
  const mappedWinner = mapWinner(result.winner, planAProviderId, planBProviderId);
  const metadataError = validatePairwiseMetadata(
    task,
    judgeId,
    metadata,
    planAProviderId,
    planBProviderId,
    result.winner,
    mappedWinner,
  );
  if (metadataError) return { ...base, error: metadataError };
  const errors = validatePairwiseJudgeBounds({ judgeId, result });
  return errors[0] ? { ...base, error: errors[0] } : { ...base, mappedWinner, result };
}

function rowFailure(row: EvaluateResult): { error: string; reason?: string } | undefined {
  const responseError = row.response?.error;
  const reason = sanitizeOptional("Promptfoo judge assertion reason", row.gradingResult?.reason);
  if (row.success === true && row.gradingResult?.pass === true && !row.error && !responseError) {
    return undefined;
  }
  const rawError = row.error ?? responseError ?? reason ?? "Promptfoo judge row failed.";
  return {
    error: sanitize("Promptfoo judge row failed", rawError),
    ...(reason ? { reason } : {}),
  };
}

function validateAbsoluteMetadata(
  task: Extract<PromptfooJudgeTask, { kind: "absolute" }>,
  judgeId: string,
  metadata: Record<string, unknown>,
): string | undefined {
  if (metadata.kind !== "absolute") return "Judge response task kind does not match absolute.";
  if (metadata.judgeId !== judgeId) return "Judge response ID does not match the row provider.";
  if (metadata.providerId !== task.providerId) {
    return "Judge response provider does not match the absolute task provider.";
  }
  return undefined;
}

function validatePairwiseMetadata(
  task: Extract<PromptfooJudgeTask, { kind: "pairwise" }>,
  judgeId: string,
  metadata: Record<string, unknown>,
  planAProviderId: string,
  planBProviderId: string,
  anonymousWinner: string,
  mappedWinner: string,
): string | undefined {
  if (metadata.kind !== "pairwise") return "Judge response task kind does not match pairwise.";
  if (metadata.judgeId !== judgeId) return "Judge response ID does not match the row provider.";
  if (!isDeepStrictEqual(metadata.providerIds, task.providerIds)) {
    return "Response pairwise provider IDs do not match the task providers.";
  }
  if (metadata.planAProviderId !== planAProviderId) {
    return "Response plan A provider does not match the deterministic mapping.";
  }
  if (metadata.planBProviderId !== planBProviderId) {
    return "Response plan B provider does not match the deterministic mapping.";
  }
  const order = metadata.anonymousOrder;
  if (
    !isRecord(order) ||
    order.planAProviderId !== planAProviderId ||
    order.planBProviderId !== planBProviderId
  ) {
    return "Response anonymous order does not match the deterministic pairwise mapping.";
  }
  if (metadata.anonymousWinner !== anonymousWinner) {
    return "Response anonymous winner does not match the pairwise output winner.";
  }
  if (metadata.mappedWinner !== mappedWinner) {
    return "Response mapped winner does not match the pairwise output and anonymous order.";
  }
  return undefined;
}

function parseOutput<T>(
  row: EvaluateResult,
  schema: z.ZodType<T>,
  kind: string,
): { ok: true; value: T } | { ok: false; error: string } {
  const output = row.response?.output;
  if (typeof output !== "string") {
    return { ok: false, error: `Promptfoo ${kind} judge output must be a JSON string.` };
  }
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return { ok: false, error: `Promptfoo ${kind} judge output must be valid JSON.` };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    error: `Invalid ${kind} judge output: ${issue?.path.join(".") || "output"}: ${issue?.message ?? "unknown schema error"}`,
  };
}

function requiredRow(
  rows: Map<string, IndexedRow>,
  task: PromptfooJudgeTask,
  judgeId: string,
): IndexedRow {
  return rows.get(rowKey(task, judgeId))!;
}

function rowKey(task: PromptfooJudgeTask, judgeId: string): string {
  return `${describeTask(task)}\0${judgeId}`;
}

function describeTask(task: PromptfooJudgeTask): string {
  return task.kind === "absolute"
    ? `absolute:${task.providerId}`
    : `pairwise:${task.trialId}:${task.providerIds.join(":")}`;
}

function judgeProviderId(judgeId: string): string {
  return `source-to-project-judge:${judgeId}`;
}

function responseMetadata(row: EvaluateResult): Record<string, unknown> {
  return isRecord(row.metadata) ? row.metadata : {};
}

function rowAccounting(
  row: EvaluateResult,
): Pick<AbsoluteJudgeRecord, "reason" | "tokenUsage" | "cost"> {
  const reason = sanitizeOptional("Promptfoo judge assertion reason", row.gradingResult?.reason);
  return {
    ...(reason ? { reason } : {}),
    ...(isRecord(row.tokenUsage) ? { tokenUsage: row.tokenUsage } : {}),
    ...(typeof row.cost === "number" && Number.isFinite(row.cost) ? { cost: row.cost } : {}),
  };
}

function repairMetadata(metadata: Record<string, unknown>) {
  const value = metadata.repairMetadata;
  if (!isRecord(value)) return noAbsoluteJudgeRepairMetadata();
  if (
    typeof value.repairAttempted !== "boolean" ||
    typeof value.retryCount !== "number" ||
    typeof value.evidenceDefectCount !== "number" ||
    !Array.isArray(value.evidenceDefectCodes) ||
    !value.evidenceDefectCodes.every((code) => typeof code === "string") ||
    typeof value.evidenceDefectOmittedCount !== "number"
  ) {
    return noAbsoluteJudgeRepairMetadata();
  }
  return {
    repairAttempted: value.repairAttempted,
    retryCount: value.retryCount,
    evidenceDefectCount: value.evidenceDefectCount,
    evidenceDefectCodes: value.evidenceDefectCodes,
    evidenceDefectOmittedCount: value.evidenceDefectOmittedCount,
  };
}

function pairwiseOrder(
  task: Extract<PromptfooJudgeTask, { kind: "pairwise" }>,
  judgeId: string,
  judgeIds: string[],
): [string, string] {
  const swap = shouldSwapPairwiseOrder({
    caseId: task.caseId,
    trialId: task.trialId,
    leftProviderId: task.providerIds[0],
    rightProviderId: task.providerIds[1],
    judgeId,
    judgeIds,
  });
  return swap
    ? [task.providerIds[1], task.providerIds[0]]
    : [task.providerIds[0], task.providerIds[1]];
}

function mapWinner(winner: string, planAProviderId: string, planBProviderId: string): string {
  if (winner === "tie") return "tie";
  return winner === "plan-a" ? planAProviderId : planBProviderId;
}

function caseContract(caseJson: string): { requirementIds: string[]; criterionIds: string[] } {
  try {
    const value = JSON.parse(caseJson) as {
      requirements?: Array<{ id?: unknown }>;
      criteria?: Array<{ criterion?: unknown }>;
    };
    return {
      requirementIds: (value.requirements ?? [])
        .map(({ id }) => id)
        .filter((id): id is string => typeof id === "string"),
      criterionIds: (value.criteria ?? [])
        .map(({ criterion }) => criterion)
        .filter((criterion): criterion is string => typeof criterion === "string"),
    };
  } catch {
    return { requirementIds: [], criterionIds: [] };
  }
}

function caseId(task: PromptfooJudgeTask): string | undefined {
  if (task.kind === "pairwise") return task.caseId;
  try {
    const value = JSON.parse(task.caseJson) as { id?: unknown };
    return typeof value.id === "string" ? value.id : undefined;
  } catch {
    return undefined;
  }
}

function pairwiseTrialIds(tasks: PromptfooJudgeTask[]): Set<string> {
  return new Set(
    tasks
      .filter(
        (task): task is Extract<PromptfooJudgeTask, { kind: "pairwise" }> =>
          task.kind === "pairwise",
      )
      .map((task) => task.trialId),
  );
}

function bamlClient(metadata: Record<string, unknown>): { bamlClientName?: string } {
  return typeof metadata.bamlClientName === "string"
    ? { bamlClientName: metadata.bamlClientName }
    : {};
}

function elapsedMs(row: EvaluateResult): number {
  return typeof row.latencyMs === "number" && Number.isFinite(row.latencyMs) ? row.latencyMs : 0;
}

function sanitize(context: string, value: unknown): string {
  return formatPromptfooJudgeFailure(context, value);
}

function sanitizeOptional(context: string, value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? sanitize(context, value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return isDeepStrictEqual(keys, expectedKeys);
}
