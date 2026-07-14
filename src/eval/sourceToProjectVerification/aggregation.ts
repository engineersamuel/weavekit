import { buildProjectVerificationRequirements, type ProjectVerificationCase } from "./case.js";
import { validateAbsoluteJudgeResult } from "./evidenceValidation.js";
import type { AbsoluteJudgeRecord } from "./judge.js";

export type AggregatedPlanQuality = {
  providerId: string;
  valid: boolean;
  score?: number;
  criteria: Record<string, number>;
  practiceScores: Record<string, number>;
  requirementScores: Record<string, number>;
  contradictions: string[];
  unsupportedRecommendations: string[];
  errors: string[];
  judgments: AbsoluteJudgeRecord[];
};

export function aggregatePlanQuality(args: {
  definition: ProjectVerificationCase;
  providerId: string;
  planMarkdown: string;
  judgeIds: string[];
  records: AbsoluteJudgeRecord[];
}): AggregatedPlanQuality {
  const records = args.records.filter((record) => record.providerId === args.providerId);
  const errors = validatePanel(args.definition, args.planMarkdown, args.judgeIds, records);
  const base = {
    providerId: args.providerId,
    criteria: {} as Record<string, number>,
    practiceScores: {} as Record<string, number>,
    requirementScores: {} as Record<string, number>,
    contradictions: unique(records.flatMap((record) => record.result?.contradictions ?? [])),
    unsupportedRecommendations: unique(
      records.flatMap((record) => record.result?.unsupportedRecommendations ?? []),
    ),
    errors,
    judgments: records,
  };
  if (errors.length > 0) return { ...base, valid: false };

  const requirements = buildProjectVerificationRequirements(args.definition);
  const requirementScores = Object.fromEntries(
    requirements.map((requirement) => [
      requirement.id,
      round(
        average(
          records.map((record) =>
            coverageValue(
              record.result!.requirementAssessments.find(
                (assessment) => assessment.requirementId === requirement.id,
              )!.status,
            ),
          ),
        ),
      ),
    ]),
  );
  const practiceScores = Object.fromEntries(
    args.definition.expectedPractices.map((practice) => {
      const ids = requirements
        .filter((requirement) => requirement.practiceId === practice.id)
        .map((requirement) => requirement.id);
      return [practice.id, round(average(ids.map((id) => requirementScores[id]!)))];
    }),
  );
  const criteria: Record<string, number> = {
    "source-practice-coverage": round(average(Object.values(practiceScores))),
  };
  for (const rubric of args.definition.rubric) {
    if (rubric.criterion === "source-practice-coverage") continue;
    criteria[rubric.criterion] = round(
      average(
        records.map(
          (record) =>
            record.result!.criterionAssessments.find(
              (assessment) => assessment.criterion === rubric.criterion,
            )!.score / 4,
        ),
      ),
    );
  }
  const score = round(
    args.definition.rubric.reduce(
      (total, rubric) => total + (criteria[rubric.criterion] ?? 0) * rubric.weight,
      0,
    ),
  );
  return {
    ...base,
    valid: true,
    score,
    criteria,
    practiceScores,
    requirementScores,
  };
}

function validatePanel(
  definition: ProjectVerificationCase,
  planMarkdown: string,
  judgeIds: string[],
  records: AbsoluteJudgeRecord[],
): string[] {
  const errors: string[] = [];
  if (judgeIds.length === 0) {
    errors.push("At least one judge is required to aggregate plan quality.");
  }
  for (const judgeId of judgeIds) {
    const judgeRecords = records.filter((record) => record.judgeId === judgeId);
    if (judgeRecords.length !== 1) {
      errors.push(`Expected one judgment from ${judgeId}, found ${judgeRecords.length}.`);
      continue;
    }
    const record = judgeRecords[0]!;
    if (record.error) {
      errors.push(`${judgeId}: ${record.error}`);
      continue;
    }
    if (!record.result) {
      errors.push(`${judgeId}: judge returned no result.`);
      continue;
    }
    errors.push(...validateResult(definition, planMarkdown, judgeId, record.result));
  }
  const unknownJudges = unique(
    records.filter((record) => !judgeIds.includes(record.judgeId)).map((record) => record.judgeId),
  );
  for (const judgeId of unknownJudges) errors.push(`Unknown judge result: ${judgeId}.`);
  return errors;
}

function validateResult(
  definition: ProjectVerificationCase,
  planMarkdown: string,
  judgeId: string,
  result: NonNullable<AbsoluteJudgeRecord["result"]>,
): string[] {
  return validateAbsoluteJudgeResult({
    judgeId,
    planMarkdown,
    expectedRequirementIds: buildProjectVerificationRequirements(definition).map(
      (requirement) => requirement.id,
    ),
    expectedCriterionIds: definition.rubric
      .map((rubric) => rubric.criterion)
      .filter((criterion) => criterion !== "source-practice-coverage"),
    result,
  });
}

function coverageValue(status: string): number {
  if (status === "complete") return 1;
  if (status === "partial") return 0.5;
  return 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function average(values: number[]): number {
  if (values.length === 0) throw new Error("Cannot average an empty set.");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
