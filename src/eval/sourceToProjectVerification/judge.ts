import { createHash } from "node:crypto";
import type {
  SourceToProjectPairwiseJudgment,
  SourceToProjectPlanJudgment,
} from "../../generated/baml_client/types.js";

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

export function noAbsoluteJudgeRepairMetadata(): AbsoluteJudgeRepairMetadata {
  return {
    repairAttempted: false,
    retryCount: 0,
    evidenceDefectCount: 0,
    evidenceDefectCodes: [],
    evidenceDefectOmittedCount: 0,
  };
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
