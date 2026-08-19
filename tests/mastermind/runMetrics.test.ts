import { describe, expect, it } from "vitest";
import { MastermindState } from "../../src/mastermind/domain/events.js";
import {
  buildAttemptScorecard,
  buildTicketScorecard,
  deriveRunEfficiency,
} from "../../src/mastermind/selfImprovement/runMetrics.js";
import type { RlmRunRecord } from "../../src/rlm-poc/runState.js";
import type { ExecutionAttempt, StoredCodeReview } from "../../src/mastermind/store/store.js";

const runRecord: RlmRunRecord = {
  schemaVersion: 1,
  runId: "run-one",
  calls: [
    {
      callId: "run-one:call-1",
      callNumber: 1,
      profile: "review",
      depthUsed: 1,
      status: "succeeded",
      model: "claude-opus-5",
      startedAt: "2026-08-13T12:00:00.000Z",
      completedAt: "2026-08-13T12:00:30.000Z",
      summary: "Reviewed.",
    },
    {
      callId: "run-one:call-2",
      callNumber: 2,
      parentCallId: "run-one:call-1",
      profile: "review",
      depthUsed: 4,
      status: "succeeded",
      model: "claude-opus-5",
      startedAt: "2026-08-13T12:00:05.000Z",
      completedAt: "2026-08-13T12:01:40.000Z",
      summary: "Reviewed deeper.",
    },
    {
      callId: "run-one:call-3",
      callNumber: 3,
      profile: "validation",
      depthUsed: 2,
      status: "failed",
      startedAt: "2026-08-13T12:00:10.000Z",
      completedAt: "2026-08-13T12:00:20.000Z",
      summary: "Session timed out.",
    },
  ],
};

describe("RLM run efficiency", () => {
  it("counts spawns per profile and reports the deepest recursion reached", () => {
    expect(deriveRunEfficiency(runRecord)).toEqual({
      totalCalls: 3,
      callsByProfile: { review: 2, validation: 1 },
      maxDepthReached: 4,
      failedCalls: 1,
      wallMs: 100_000,
    });
  });

  it("reports an empty run without a wall time", () => {
    expect(deriveRunEfficiency({ schemaVersion: 1, runId: "empty", calls: [] })).toEqual({
      totalCalls: 0,
      callsByProfile: {},
      maxDepthReached: 0,
      failedCalls: 0,
    });
  });
});

describe("attempt scorecard", () => {
  it("pairs recursion cost with the code-review outcome for the same attempt", () => {
    const scorecard = buildAttemptScorecard(attempt(1, runRecord), codeReview("a1", "passed"));

    expect(scorecard.efficiency?.callsByProfile).toEqual({ review: 2, validation: 1 });
    expect(scorecard.outcome).toMatchObject({
      codeReviewStatus: "passed",
      codeReviewVerdict: "PASS",
      codeReviewConfidence: 0.82,
      findingsBySeverity: { BLOCKING: 0, IMPORTANT: 1, SUGGESTION: 2 },
    });
  });

  it("omits efficiency for an attempt stored before the run record existed", () => {
    expect(buildAttemptScorecard(attempt(1)).efficiency).toBeUndefined();
  });

  it("reports the attempt number that first reached a passing code review", () => {
    const passing = codeReview("a2", "passed");
    const scorecard = buildTicketScorecard(
      "work-1",
      [attempt(1, runRecord), attempt(2, runRecord, "a2")],
      new Map<string, StoredCodeReview>([[passing.executionAttemptId, passing]]),
    );

    expect(scorecard.attemptsToCodeReviewPass).toBe(2);
    expect(scorecard.attempts).toHaveLength(2);
  });

  it("leaves the pass count absent while no attempt has passed", () => {
    const pending = codeReview("a1", "changes_requested");
    const scorecard = buildTicketScorecard(
      "work-1",
      [attempt(1, runRecord)],
      new Map<string, StoredCodeReview>([[pending.executionAttemptId, pending]]),
    );

    expect(scorecard.attemptsToCodeReviewPass).toBeUndefined();
  });
});

function attempt(attemptNumber: number, record?: RlmRunRecord, id = "a1"): ExecutionAttempt {
  return {
    id,
    attemptNumber,
    state: MastermindState.SUCCEEDED,
    ...(record
      ? {
          result: {
            schemaVersion: 1,
            outcome: "succeeded",
            runRecord: record,
          },
        }
      : {}),
  } as ExecutionAttempt;
}

function codeReview(
  executionAttemptId: string,
  status: StoredCodeReview["status"],
): StoredCodeReview {
  return {
    executionAttemptId,
    status,
    review: {
      verdict: "PASS",
      confidence: 0.82,
      findings: [
        { severity: "IMPORTANT", summary: "One gap.", evidence: [] },
        { severity: "SUGGESTION", summary: "Nit.", evidence: [] },
        { severity: "SUGGESTION", summary: "Another nit.", evidence: [] },
      ],
    },
  } as unknown as StoredCodeReview;
}
