import { describe, expect, it } from "vitest";
import { normalizeExecutionOutcome } from "../../src/mastermind/execution/result.js";
import { MastermindEventType, MastermindState } from "../../src/mastermind/domain/events.js";
import type {
  DirectExecutionResult,
  ExecutorStatus,
  VerificationEvidence,
} from "../../src/submind/contracts.js";

describe("execution result normalization", () => {
  it("requires terminal Herdr state and independent verification for success", () => {
    expect(
      normalizeExecutionOutcome({
        status: status("done"),
        result: result("succeeded"),
        verification: verification(true),
        attemptNumber: 1,
        maxAttempts: 2,
      }),
    ).toMatchObject({
      state: MastermindState.SUCCEEDED,
      eventType: MastermindEventType.EXECUTION_SUCCEEDED,
    });
    expect(
      normalizeExecutionOutcome({
        status: status("done"),
        result: result("succeeded"),
        verification: { commands: [], passed: false },
        attemptNumber: 1,
        maxAttempts: 2,
      }),
    ).toMatchObject({
      state: MastermindState.NEEDS_HUMAN,
      failureClass: "VERIFICATION_MISSING",
    });
    expect(
      normalizeExecutionOutcome({
        status: status("working"),
        result: result("succeeded"),
        verification: verification(true),
        attemptNumber: 1,
        maxAttempts: 2,
      }),
    ).toMatchObject({
      state: MastermindState.NEEDS_HUMAN,
      failureClass: "NONTERMINAL_COLLECTION",
    });
  });

  it.each([
    {
      outcome: "retryable-failure" as const,
      attemptNumber: 1,
      expected: MastermindState.RETRY_WAIT,
    },
    {
      outcome: "retryable-failure" as const,
      attemptNumber: 2,
      expected: MastermindState.NEEDS_HUMAN,
    },
    {
      outcome: "terminal-failure" as const,
      attemptNumber: 1,
      expected: MastermindState.FAILED,
    },
    {
      outcome: "needs-human" as const,
      attemptNumber: 1,
      expected: MastermindState.NEEDS_HUMAN,
    },
  ])("normalizes $outcome at attempt $attemptNumber", ({ outcome, attemptNumber, expected }) => {
    expect(
      normalizeExecutionOutcome({
        status: status("idle"),
        result: result(outcome),
        verification: verification(false),
        attemptNumber,
        maxAttempts: 2,
      }).state,
    ).toBe(expected);
  });
});

function status(state: ExecutorStatus["state"]): ExecutorStatus {
  return { state, observedAt: "2026-08-06T12:00:00.000Z" };
}

function result(outcome: DirectExecutionResult["outcome"]): DirectExecutionResult {
  return {
    schemaVersion: 1,
    workId: "work-one",
    attemptId: "attempt-one",
    attemptNumber: 1,
    outcome,
    summary: "result",
    artifactPaths: [],
    verification: [{ command: "test", exitCode: outcome === "succeeded" ? 0 : 1, summary: "done" }],
    knownRisks: [],
    remainingWork: [],
  };
}

function verification(passed: boolean): VerificationEvidence {
  return {
    passed,
    commands: [{ command: "test", exitCode: passed ? 0 : 1, summary: "done", durationMs: 1 }],
  };
}
