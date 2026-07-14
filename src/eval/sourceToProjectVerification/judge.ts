import { createHash } from "node:crypto";
import type {
  SourceToProjectPairwiseJudgment,
  SourceToProjectPlanJudgment,
} from "../../generated/baml_client/types.js";
import { validatePairwiseJudgeBounds } from "./evidenceValidation.js";

export type AbsoluteJudgeInput = {
  caseJson: string;
  planMarkdown: string;
};

export type PairwiseJudgeInput = {
  caseJson: string;
  planA: string;
  planB: string;
};

export type SourceToProjectPlanJudge = {
  id: string;
  bamlClientName?: string;
  judgePlan(input: AbsoluteJudgeInput): Promise<SourceToProjectPlanJudgment>;
  judgePlanWithMetadata?(input: AbsoluteJudgeInput): Promise<RecordedAbsoluteJudgeOutcome>;
  comparePlans(input: PairwiseJudgeInput): Promise<SourceToProjectPairwiseJudgment>;
};

export type AbsoluteJudgeRepairMetadata = {
  repairAttempted: boolean;
  retryCount: number;
  evidenceDefectCount: number;
  evidenceDefectCodes: string[];
  evidenceDefectOmittedCount: number;
};

export type RecordedAbsoluteJudgeOutcome =
  | { ok: true; result: SourceToProjectPlanJudgment; repairMetadata: AbsoluteJudgeRepairMetadata }
  | { ok: false; error: unknown; repairMetadata: AbsoluteJudgeRepairMetadata };

export type JudgeablePlan = {
  providerId: string;
  markdown: string;
};

export type AbsoluteJudgeRecord = {
  judgeId: string;
  bamlClientName?: string;
  providerId: string;
  requirementIds: string[];
  elapsedMs: number;
  repairAttempted: boolean;
  retryCount: number;
  evidenceDefectCount: number;
  evidenceDefectCodes: string[];
  evidenceDefectOmittedCount: number;
  result?: SourceToProjectPlanJudgment;
  error?: string;
  reason?: string;
  tokenUsage?: Record<string, unknown>;
  cost?: number;
};

export type PairwiseJudgeRecord = {
  judgeId: string;
  bamlClientName?: string;
  planAProviderId: string;
  planBProviderId: string;
  elapsedMs: number;
  mappedWinner?: string;
  result?: SourceToProjectPairwiseJudgment;
  error?: string;
  reason?: string;
  tokenUsage?: Record<string, unknown>;
  cost?: number;
};

export type ResolvedPairwisePanel = {
  providerIds: [string, string];
  status: "agreed" | "disputed" | "single-judge" | "invalid";
  winner?: string;
  judgments: PairwiseJudgeRecord[];
};

export type ProjectVerificationJudgePanelResult = {
  absolute: AbsoluteJudgeRecord[];
  pairwise: ResolvedPairwisePanel[];
};

export type PairwiseOrderInput = {
  caseId: string;
  trialId: string;
  leftProviderId: string;
  rightProviderId: string;
  judgeId: string;
  judgeIds: string[];
};

export async function runProjectVerificationJudgePanel(args: {
  caseId: string;
  trialId: string;
  caseJson: string;
  plans: JudgeablePlan[];
  judges: SourceToProjectPlanJudge[];
}): Promise<ProjectVerificationJudgePanelResult> {
  if (args.judges.length === 0) {
    throw new Error("At least one judge is required to run the project verification panel.");
  }
  const plans = [...args.plans].sort((left, right) =>
    left.providerId.localeCompare(right.providerId),
  );
  const absolute: AbsoluteJudgeRecord[] = [];
  for (const plan of plans) {
    absolute.push(
      ...(await Promise.all(args.judges.map((judge) => runAbsolute(judge, plan, args.caseJson)))),
    );
  }
  const pairwise: ResolvedPairwisePanel[] = [];
  for (let leftIndex = 0; leftIndex < plans.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < plans.length; rightIndex += 1) {
      const left = plans[leftIndex]!;
      const right = plans[rightIndex]!;
      const records = await Promise.all(
        args.judges.map(async (judge) => {
          const swap = shouldSwapPairwiseOrder({
            caseId: args.caseId,
            trialId: args.trialId,
            leftProviderId: left.providerId,
            rightProviderId: right.providerId,
            judgeId: judge.id,
            judgeIds: args.judges.map(({ id }) => id),
          });
          return await runPairwise(judge, swap ? right : left, swap ? left : right, args.caseJson);
        }),
      );
      pairwise.push(resolvePairwisePanel(records));
    }
  }
  return { absolute, pairwise };
}

export function resolvePairwisePanel(records: PairwiseJudgeRecord[]): ResolvedPairwisePanel {
  const providerIds = uniqueProviderIds(records);
  const valid = records.filter(
    (record): record is PairwiseJudgeRecord & { mappedWinner: string } =>
      Boolean(record.result) && typeof record.mappedWinner === "string",
  );
  if (valid.length === 0) return { providerIds, status: "invalid", judgments: records };
  if (valid.length === 1) {
    return {
      providerIds,
      status: "single-judge",
      winner: valid[0].mappedWinner,
      judgments: records,
    };
  }
  const winners = new Set(valid.map((record) => record.mappedWinner));
  if (winners.size === 1) {
    return {
      providerIds,
      status: "agreed",
      winner: valid[0].mappedWinner,
      judgments: records,
    };
  }
  return { providerIds, status: "disputed", judgments: records };
}

async function runAbsolute(
  judge: SourceToProjectPlanJudge,
  plan: JudgeablePlan,
  caseJson: string,
): Promise<AbsoluteJudgeRecord> {
  const startedAt = performance.now();
  const requirementIds = readRequirementIds(caseJson);
  const base = {
    judgeId: judge.id,
    ...(judge.bamlClientName ? { bamlClientName: judge.bamlClientName } : {}),
    providerId: plan.providerId,
    requirementIds,
  };
  try {
    const outcome = judge.judgePlanWithMetadata
      ? await judge.judgePlanWithMetadata({ caseJson, planMarkdown: plan.markdown })
      : {
          ok: true as const,
          result: await judge.judgePlan({ caseJson, planMarkdown: plan.markdown }),
          repairMetadata: noAbsoluteJudgeRepairMetadata(),
        };
    if (!outcome.ok) {
      return {
        ...base,
        elapsedMs: Math.round(performance.now() - startedAt),
        ...outcome.repairMetadata,
        error: errorMessage(outcome.error),
      };
    }
    return {
      ...base,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...outcome.repairMetadata,
      result: outcome.result,
    };
  } catch (error) {
    return {
      ...base,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...noAbsoluteJudgeRepairMetadata(),
      error: errorMessage(error),
    };
  }
}

export function noAbsoluteJudgeRepairMetadata(): AbsoluteJudgeRepairMetadata {
  return {
    repairAttempted: false,
    retryCount: 0,
    evidenceDefectCount: 0,
    evidenceDefectCodes: [],
    evidenceDefectOmittedCount: 0,
  };
}

async function runPairwise(
  judge: SourceToProjectPlanJudge,
  planA: JudgeablePlan,
  planB: JudgeablePlan,
  caseJson: string,
): Promise<PairwiseJudgeRecord> {
  const startedAt = performance.now();
  try {
    const result = await judge.comparePlans({
      caseJson,
      planA: planA.markdown,
      planB: planB.markdown,
    });
    const boundsErrors = validatePairwiseJudgeBounds({ judgeId: judge.id, result });
    if (boundsErrors[0]) throw new Error(boundsErrors[0]);
    return {
      judgeId: judge.id,
      ...(judge.bamlClientName ? { bamlClientName: judge.bamlClientName } : {}),
      planAProviderId: planA.providerId,
      planBProviderId: planB.providerId,
      elapsedMs: Math.round(performance.now() - startedAt),
      mappedWinner:
        result.winner === "tie"
          ? "tie"
          : result.winner === "plan-a"
            ? planA.providerId
            : planB.providerId,
      result,
    };
  } catch (error) {
    return {
      judgeId: judge.id,
      ...(judge.bamlClientName ? { bamlClientName: judge.bamlClientName } : {}),
      planAProviderId: planA.providerId,
      planBProviderId: planB.providerId,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: errorMessage(error),
    };
  }
}

function readRequirementIds(caseJson: string): string[] {
  try {
    const parsed = JSON.parse(caseJson) as { requirements?: Array<{ id?: unknown }> };
    return Array.isArray(parsed.requirements)
      ? parsed.requirements
          .map((requirement) => requirement.id)
          .filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function shouldSwap(caseId: string, trialId: string, left: string, right: string): boolean {
  const hash = createHash("sha256").update(`${caseId}\0${trialId}\0${left}\0${right}`).digest();
  return (hash[0] ?? 0) % 2 === 1;
}

export function shouldSwapPairwiseOrder(input: PairwiseOrderInput): boolean {
  const judgeIndex = input.judgeIds.indexOf(input.judgeId);
  if (judgeIndex < 0) {
    throw new Error(`Judge ${input.judgeId} is not present in the judge panel.`);
  }
  const baseSwap = shouldSwap(
    input.caseId,
    input.trialId,
    input.leftProviderId,
    input.rightProviderId,
  );
  return judgeIndex % 2 === 0 ? baseSwap : !baseSwap;
}

function uniqueProviderIds(records: PairwiseJudgeRecord[]): [string, string] {
  const ids = [
    ...new Set(records.flatMap((record) => [record.planAProviderId, record.planBProviderId])),
  ].sort();
  if (ids.length !== 2) throw new Error(`Expected exactly two providers, found ${ids.length}.`);
  return [ids[0]!, ids[1]!];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
