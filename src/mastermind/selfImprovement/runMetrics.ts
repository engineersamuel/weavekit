import type { MastermindState } from "../domain/events.js";
import type { RlmRunRecord } from "../../rlm-poc/runState.js";
import type { ExecutionAttempt, StoredCodeReview } from "../store/store.js";

export type FindingSeverity = "BLOCKING" | "IMPORTANT" | "SUGGESTION";

/**
 * How much recursion an attempt spent. Derived from the run record persisted with the execution
 * result; this is the number that sizes a per-profile spawn cap.
 */
export type RunEfficiencyMetrics = {
  totalCalls: number;
  callsByProfile: Record<string, number>;
  maxDepthReached: number;
  failedCalls: number;
  wallMs?: number;
};

/** What the attempt produced. Efficiency alone would reward a cheap run that did worse work. */
export type RunOutcomeMetrics = {
  state: MastermindState;
  outcome?: string;
  codeReviewStatus?: StoredCodeReview["status"];
  codeReviewVerdict?: string;
  codeReviewConfidence?: number;
  findingsBySeverity: Record<FindingSeverity, number>;
};

export type AttemptScorecard = {
  attemptId: string;
  attemptNumber: number;
  efficiency?: RunEfficiencyMetrics;
  outcome: RunOutcomeMetrics;
};

export type TicketScorecard = {
  workId: string;
  attempts: AttemptScorecard[];
  /** Attempt number of the first passing code review, absent when no attempt has passed. */
  attemptsToCodeReviewPass?: number;
};

export function deriveRunEfficiency(record: RlmRunRecord): RunEfficiencyMetrics {
  const callsByProfile: Record<string, number> = {};
  let maxDepthReached = 0;
  let failedCalls = 0;
  let earliest: number | undefined;
  let latest: number | undefined;
  for (const call of record.calls) {
    callsByProfile[call.profile] = (callsByProfile[call.profile] ?? 0) + 1;
    maxDepthReached = Math.max(maxDepthReached, call.depthUsed);
    if (call.status === "failed") failedCalls += 1;
    const started = Date.parse(call.startedAt);
    if (Number.isFinite(started)) {
      earliest = earliest === undefined ? started : Math.min(earliest, started);
    }
    const completed = call.completedAt ? Date.parse(call.completedAt) : Number.NaN;
    if (Number.isFinite(completed)) {
      latest = latest === undefined ? completed : Math.max(latest, completed);
    }
  }
  const wallMs =
    earliest !== undefined && latest !== undefined ? Math.max(0, latest - earliest) : undefined;
  return {
    totalCalls: record.calls.length,
    callsByProfile,
    maxDepthReached,
    failedCalls,
    ...(wallMs !== undefined ? { wallMs } : {}),
  };
}

export function buildAttemptScorecard(
  attempt: ExecutionAttempt,
  codeReview?: StoredCodeReview,
): AttemptScorecard {
  const findingsBySeverity: Record<FindingSeverity, number> = {
    BLOCKING: 0,
    IMPORTANT: 0,
    SUGGESTION: 0,
  };
  for (const finding of codeReview?.review?.findings ?? []) {
    findingsBySeverity[finding.severity] += 1;
  }
  const record = attempt.result?.runRecord;
  return {
    attemptId: attempt.id,
    attemptNumber: attempt.attemptNumber,
    ...(record ? { efficiency: deriveRunEfficiency(record) } : {}),
    outcome: {
      state: attempt.state,
      ...(attempt.result?.outcome ? { outcome: attempt.result.outcome } : {}),
      ...(codeReview ? { codeReviewStatus: codeReview.status } : {}),
      ...(codeReview?.review ? { codeReviewVerdict: codeReview.review.verdict } : {}),
      ...(codeReview?.review ? { codeReviewConfidence: codeReview.review.confidence } : {}),
      findingsBySeverity,
    },
  };
}

export function buildTicketScorecard(
  workId: string,
  attempts: readonly ExecutionAttempt[],
  codeReviewsByAttemptId: ReadonlyMap<string, StoredCodeReview>,
): TicketScorecard {
  const scorecards = attempts.map((attempt) =>
    buildAttemptScorecard(attempt, codeReviewsByAttemptId.get(attempt.id)),
  );
  const passed = scorecards.find(({ outcome }) => outcome.codeReviewStatus === "passed");
  return {
    workId,
    attempts: scorecards,
    ...(passed ? { attemptsToCodeReviewPass: passed.attemptNumber } : {}),
  };
}
