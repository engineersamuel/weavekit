import { describe, expect, it, vi } from "vitest";
import { MastermindAction, MastermindState } from "../../src/mastermind/domain/events.js";
import { executeOneReadyWork } from "../../src/mastermind/execution/oneShot.js";
import type { ExecutionAttempt, MastermindWorkItem } from "../../src/mastermind/store/store.js";
import { ExecutorKind } from "../../src/submind/contracts.js";

describe("one-shot Mastermind execution", () => {
  it("exits cleanly when no work is ready", async () => {
    const store = fakeStore();

    await expect(
      executeOneReadyWork({
        store,
        coordinator: { process: vi.fn() },
        pollIntervalMs: 1,
      }),
    ).resolves.toEqual({ disposition: "no-work" });
  });

  it("resumes the oldest recoverable attempt before launching new work", async () => {
    let work = workItem("recoverable", MastermindState.RUNNING, "attempt-one");
    let attempt = executionAttempt("attempt-one", work.id, MastermindState.RUNNING);
    const process = vi.fn(async () => {
      work = { ...work, state: MastermindState.SUCCEEDED, rowVersion: work.rowVersion + 1 };
      attempt = {
        ...attempt,
        state: MastermindState.SUCCEEDED,
        projection: { disposition: "applied" },
        rowVersion: attempt.rowVersion + 1,
      };
    });
    const store = fakeStore({
      getWork: () => work,
      getAttempt: () => attempt,
      recoverable: [{ workId: work.id, attemptId: attempt.id }],
      launchable: ["launchable"],
    });

    const result = await executeOneReadyWork({
      store,
      coordinator: { process },
      pollIntervalMs: 1,
    });

    expect(process).toHaveBeenCalledWith("recoverable");
    expect(result).toMatchObject({
      disposition: "completed",
      work: { state: MastermindState.SUCCEEDED },
    });
  });

  it("polls a running attempt until its terminal projection is applied", async () => {
    let work = workItem("launchable", MastermindState.ACTION_PLANNED);
    let attempt: ExecutionAttempt | undefined;
    const wait = vi.fn(async () => {});
    const process = vi.fn(async () => {
      if (!attempt) {
        work = {
          ...work,
          state: MastermindState.RUNNING,
          currentExecutionAttemptId: "attempt-one",
          rowVersion: work.rowVersion + 1,
        };
        attempt = executionAttempt("attempt-one", work.id, MastermindState.RUNNING);
        return;
      }
      work = { ...work, state: MastermindState.SUCCEEDED, rowVersion: work.rowVersion + 1 };
      attempt = {
        ...attempt,
        state: MastermindState.SUCCEEDED,
        projection: { disposition: "applied" },
        rowVersion: attempt.rowVersion + 1,
      };
    });
    const store = fakeStore({
      getWork: () => work,
      getAttempt: () => attempt,
      launchable: [work.id],
    });

    const result = await executeOneReadyWork({
      store,
      coordinator: { process },
      pollIntervalMs: 25,
      wait,
    });

    expect(wait).toHaveBeenCalledWith(25);
    expect(process).toHaveBeenCalledTimes(2);
    expect(result.disposition).toBe("completed");
  });

  it("fails instead of looping when project policy does not start execution", async () => {
    const work = workItem("launchable", MastermindState.ACTION_PLANNED);
    const store = fakeStore({ work, launchable: [work.id] });

    await expect(
      executeOneReadyWork({
        store,
        coordinator: { process: vi.fn() },
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow("Verify global execution configuration and project opt-in");
  });
});

function fakeStore(
  input: {
    work?: MastermindWorkItem;
    getWork?: () => MastermindWorkItem | undefined;
    attempt?: ExecutionAttempt;
    getAttempt?: () => ExecutionAttempt | undefined;
    recoverable?: Array<{ workId: string; attemptId: string }>;
    launchable?: string[];
  } = {},
) {
  return {
    async getWork() {
      return input.getWork?.() ?? input.work;
    },
    async getCurrentExecutionAttempt() {
      return input.getAttempt?.() ?? input.attempt;
    },
    async listRecoverableExecutions() {
      return input.recoverable ?? [];
    },
    async listLaunchableExecutionWorkIds() {
      return input.launchable ?? [];
    },
  };
}

function workItem(
  id: string,
  state: MastermindState,
  currentExecutionAttemptId?: string,
): MastermindWorkItem {
  return {
    id,
    organizationId: "organization-one",
    issueId: "issue-one",
    projectPolicyId: "weavekit",
    state,
    plannedAction: MastermindAction.IMPLEMENT_DIRECTLY,
    currentExecutionAttemptId,
    retryCount: 0,
    rowVersion: 0,
    createdAt: "2026-08-06T12:00:00.000Z",
    updatedAt: "2026-08-06T12:00:00.000Z",
  };
}

function executionAttempt(id: string, workId: string, state: MastermindState): ExecutionAttempt {
  return {
    id,
    workId,
    attemptNumber: 1,
    action: MastermindAction.IMPLEMENT_DIRECTLY,
    projectPolicyId: "weavekit",
    projectPolicyVersion: "policy-one",
    executorKind: ExecutorKind.HERDR_COPILOT,
    state,
    retryEligible: false,
    rowVersion: 0,
    createdAt: "2026-08-06T12:00:00.000Z",
    updatedAt: "2026-08-06T12:00:00.000Z",
  };
}
