import { describe, expect, it } from "vitest";
import {
  RlmCallExecutionStatus,
  RlmRunStateError,
  beginRlmCall,
  createRlmRunState,
  failRlmCall,
  hydrateRlmRunState,
  interruptRunningRlmCalls,
  parseRlmRunStateSnapshot,
  resolveRlmDependencies,
  restoreRlmRunState,
  snapshotRlmRunState,
  succeedRlmCall,
  toRlmRunRecord,
} from "../../src/rlm-poc/runState.js";
import {
  RlmWorkerOutcome,
  RlmVerificationOutcome,
  type RlmRunBrief,
  type RlmWorkerReport,
} from "../../src/generated/baml_client/types.js";

const brief: RlmRunBrief = {
  objective: "Implement the state model.",
  constraints: ["Do not create shared Markdown memory."],
  acceptanceCriteria: ["Dependencies are explicit."],
  validationCommands: ["nub run test -- tests/rlm-poc"],
};

const report = (summary: string): RlmWorkerReport => ({
  outcome: RlmWorkerOutcome.COMPLETED,
  summary,
  evidence: [],
  artifacts: [],
  verification: [
    {
      commandOrMethod: "nub run test",
      outcome: RlmVerificationOutcome.PASSED,
      summary: "Passed.",
    },
  ],
  decisions: [],
  risks: [],
  openQuestions: [],
  remainingWork: [],
});

function clock(...timestamps: string[]): () => Date {
  let index = 0;
  return () => new Date(timestamps[Math.min(index++, timestamps.length - 1)]!);
}

describe("RLM run state", () => {
  it("allocates stable call IDs and records successful dependency reports", () => {
    const state = createRlmRunState(brief, {
      runId: "run-one",
      now: clock("2026-08-13T12:00:00.000Z", "2026-08-13T12:00:01.000Z"),
    });

    const running = beginRlmCall(state, {
      profile: "research",
      depthUsed: 1,
    });
    const completed = succeedRlmCall(state, running.callId, {
      model: "gpt-5.6-sol",
      report: report("Found the evidence."),
    });

    expect(running.callId).toBe("run-one:call-1");
    expect(completed).toMatchObject({
      callNumber: 1,
      status: RlmCallExecutionStatus.Succeeded,
      model: "gpt-5.6-sol",
      completedAt: "2026-08-13T12:00:01.000Z",
    });
    expect(resolveRlmDependencies(state, [running.callId])).toEqual([
      {
        callId: running.callId,
        profile: "research",
        report: report("Found the evidence."),
      },
    ]);
  });

  it("allocates unique monotonic IDs for synchronous parallel sibling starts", () => {
    const state = createRlmRunState(brief, { runId: "run-parallel" });

    const calls = Array.from({ length: 20 }, () =>
      beginRlmCall(state, { profile: "general", depthUsed: 1 }),
    );

    expect(calls.map(({ callId }) => callId)).toEqual(
      Array.from({ length: 20 }, (_, index) => `run-parallel:call-${index + 1}`),
    );
    expect(new Set(calls.map(({ callId }) => callId)).size).toBe(20);
  });

  it("keeps snapshots immutable from later state and caller mutations", () => {
    const state = createRlmRunState(brief, { runId: "run-one" });
    const running = beginRlmCall(state, { profile: "general", depthUsed: 1 });
    const snapshot = snapshotRlmRunState(state);

    snapshot.brief.constraints.push("mutated");
    snapshot.calls[0]!.dependencyCallIds.push("mutated");
    failRlmCall(state, running.callId, "failed");

    const current = snapshotRlmRunState(state);
    expect(current.brief.constraints).toEqual(["Do not create shared Markdown memory."]);
    expect(current.calls[0]!.dependencyCallIds).toEqual([]);
    expect(current.calls[0]!.status).toBe(RlmCallExecutionStatus.Failed);
  });

  it("rejects duplicate, missing, running, and failed dependencies", () => {
    const state = createRlmRunState(brief, { runId: "run-one" });
    const running = beginRlmCall(state, { profile: "general", depthUsed: 1 });

    expect(() => resolveRlmDependencies(state, [running.callId])).toThrow(/running/iu);
    failRlmCall(state, running.callId, "failed");
    expect(() => resolveRlmDependencies(state, [running.callId])).toThrow(/failed/iu);
    expect(() => resolveRlmDependencies(state, ["missing"])).toThrow(/does not exist/iu);

    const second = beginRlmCall(state, { profile: "general", depthUsed: 1 });
    succeedRlmCall(state, second.callId, { model: "test", report: report("done") });
    expect(() => resolveRlmDependencies(state, [second.callId, second.callId])).toThrow(
      /more than once/iu,
    );

    const semanticFailure = beginRlmCall(state, { profile: "general", depthUsed: 1 });
    succeedRlmCall(state, semanticFailure.callId, {
      model: "test",
      report: {
        ...report("could not complete"),
        outcome: RlmWorkerOutcome.FAILED,
      },
    });
    expect(() => resolveRlmDependencies(state, [semanticFailure.callId])).toThrow(
      /worker outcome FAILED.*COMPLETED/iu,
    );
  });

  it("restores a versioned snapshot and marks interrupted calls failed", () => {
    const state = createRlmRunState(brief, {
      runId: "run-one",
      now: clock("2026-08-13T12:00:00.000Z"),
    });
    beginRlmCall(state, { profile: "general", depthUsed: 1 });
    const restored = restoreRlmRunState(snapshotRlmRunState(state), {
      now: clock("2026-08-13T12:05:00.000Z"),
    });

    interruptRunningRlmCalls(restored);
    const snapshot = snapshotRlmRunState(restored);

    expect(snapshot.nextCallNumber).toBe(2);
    expect(snapshot.calls[0]).toMatchObject({
      callId: "run-one:call-1",
      status: RlmCallExecutionStatus.Failed,
      completedAt: "2026-08-13T12:05:00.000Z",
      error: expect.stringMatching(/prior process ended/iu),
    });
  });

  it("rejects repeated terminal transitions", () => {
    const state = createRlmRunState(brief, { runId: "run-one" });
    const running = beginRlmCall(state, { profile: "general", depthUsed: 1 });
    failRlmCall(state, running.callId, "failed");

    expect(() => failRlmCall(state, running.callId, "again")).toThrow(RlmRunStateError);
  });

  it("validates checkpoint reports and preserves the run identity during hydration", () => {
    const source = createRlmRunState(brief, { runId: "run-one" });
    const running = beginRlmCall(source, { profile: "general", depthUsed: 1 });
    succeedRlmCall(source, running.callId, {
      model: "test",
      report: report("validated"),
    });
    const parseReport = (raw: string) => {
      expect(raw).toBe(JSON.stringify(report("validated")));
      return report("parsed");
    };
    const parsed = parseRlmRunStateSnapshot(snapshotRlmRunState(source), parseReport);
    const target = createRlmRunState(brief, { runId: "run-one" });

    hydrateRlmRunState(target, parsed);

    expect(snapshotRlmRunState(target)).toMatchObject({
      runId: "run-one",
      nextCallNumber: 2,
      calls: [{ report: report("parsed") }],
    });
    const wrongRun = createRlmRunState(brief, { runId: "run-two" });
    expect(() => hydrateRlmRunState(wrongRun, parsed)).toThrow(/run-two.*run-one/iu);
  });

  it("rejects invalid restored call relationships and sequence gaps", () => {
    const state = createRlmRunState(brief, { runId: "run-one" });
    const parent = beginRlmCall(state, { profile: "general", depthUsed: 1 });
    beginRlmCall(state, {
      parentCallId: parent.callId,
      profile: "general",
      depthUsed: 2,
    });
    const snapshot = snapshotRlmRunState(state);

    const invalidParent = structuredClone(snapshot);
    invalidParent.calls[1]!.parentCallId = "run-one:call-99";
    expect(() => restoreRlmRunState(invalidParent)).toThrow(/parent call/iu);

    const sequenceGap = structuredClone(snapshot);
    sequenceGap.calls[1]!.callNumber = 3;
    sequenceGap.calls[1]!.callId = "run-one:call-3";
    sequenceGap.nextCallNumber = 4;
    expect(() => restoreRlmRunState(sequenceGap)).toThrow(/contiguous/iu);
  });
});

describe("RLM run record", () => {
  it("keeps every measurement field and drops the worker report bulk", () => {
    const state = createRlmRunState(brief, {
      runId: "run-record",
      now: clock(
        "2026-08-13T12:00:00.000Z",
        "2026-08-13T12:00:00.000Z",
        "2026-08-13T12:00:04.000Z",
        "2026-08-13T12:00:09.000Z",
      ),
    });
    const first = beginRlmCall(state, { profile: "review", depthUsed: 1 });
    const second = beginRlmCall(state, {
      profile: "validation",
      depthUsed: 2,
      parentCallId: first.callId,
    });
    succeedRlmCall(state, first.callId, {
      model: "claude-opus-5",
      report: report("Reviewed the diff."),
    });
    failRlmCall(state, second.callId, "Session timed out.");

    const record = toRlmRunRecord(snapshotRlmRunState(state));

    expect(record.runId).toBe("run-record");
    expect(record.calls).toEqual([
      {
        callId: "run-record:call-1",
        callNumber: 1,
        profile: "review",
        depthUsed: 1,
        status: RlmCallExecutionStatus.Succeeded,
        model: "claude-opus-5",
        startedAt: "2026-08-13T12:00:00.000Z",
        completedAt: "2026-08-13T12:00:04.000Z",
        summary: "Reviewed the diff.",
      },
      {
        callId: "run-record:call-2",
        callNumber: 2,
        parentCallId: "run-record:call-1",
        profile: "validation",
        depthUsed: 2,
        status: RlmCallExecutionStatus.Failed,
        startedAt: "2026-08-13T12:00:00.000Z",
        completedAt: "2026-08-13T12:00:09.000Z",
        summary: "Session timed out.",
      },
    ]);
  });

  it("omits completion fields for a call that is still running", () => {
    const state = createRlmRunState(brief, { runId: "run-open" });
    beginRlmCall(state, { profile: "general", depthUsed: 1 });

    const [call] = toRlmRunRecord(snapshotRlmRunState(state)).calls;

    expect(call).toMatchObject({ status: RlmCallExecutionStatus.Running });
    expect(call).not.toHaveProperty("completedAt");
    expect(call).not.toHaveProperty("summary");
    expect(call).not.toHaveProperty("model");
  });
});
