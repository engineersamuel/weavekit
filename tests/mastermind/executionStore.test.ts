import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  MastermindAction,
  MastermindEventType,
  MastermindState,
} from "../../src/mastermind/domain/events.js";
import { transitionMastermindState } from "../../src/mastermind/domain/machine.js";
import { FencedExecutionError, SqliteMastermindStore } from "../../src/mastermind/store/sqlite.js";
import type { ExecutionAttempt, MastermindWorkItem } from "../../src/mastermind/store/store.js";
import { ExecutorKind } from "../../src/submind/contracts.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Mastermind execution attempt store", () => {
  it("migrates the previous work-item schema", async () => {
    const path = await databasePath();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE mastermind_work_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        project_policy_id TEXT,
        state TEXT NOT NULL,
        planned_action TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        row_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organization_id, issue_id)
      );
    `);
    database.close();

    const store = new SqliteMastermindStore(path);
    await store.initialize();
    const migrated = new DatabaseSync(path);
    expect(
      migrated
        .prepare("PRAGMA table_info(mastermind_work_items)")
        .all()
        .some((column) => (column as { name: string }).name === "current_execution_attempt_id"),
    ).toBe(true);
    expect(
      migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mastermind_execution_attempts'",
        )
        .get(),
    ).toBeDefined();
    migrated.close();
    store.close();
  });

  it("atomically creates one current attempt and fences concurrent creators", async () => {
    const store = await createStore();
    const work = await directWork(store);

    const results = await Promise.allSettled([
      store.createExecutionAttempt(createInput(work)),
      store.createExecutionAttempt(createInput(work)),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await store.getCurrentExecutionAttempt(work.id)).toMatchObject({
      attemptNumber: 1,
      state: MastermindState.PROVISIONING,
    });
    store.close();
  });

  it("rejects stale attempt results after a newer attempt becomes current", async () => {
    const store = await createStore();
    const initial = await directWork(store);
    let { work, attempt } = await store.createExecutionAttempt(createInput(initial));

    ({ work, attempt } = await advance(
      store,
      work,
      attempt,
      MastermindEventType.WORKSPACE_PROVISIONED,
    ));
    ({ work, attempt } = await advance(store, work, attempt, MastermindEventType.PREFLIGHT_PASSED));
    ({ work, attempt } = await advance(store, work, attempt, MastermindEventType.EXECUTOR_STARTED));
    ({ work, attempt } = await advance(
      store,
      work,
      attempt,
      MastermindEventType.EXECUTOR_TERMINAL,
    ));
    ({ work, attempt } = await advance(
      store,
      work,
      attempt,
      MastermindEventType.EXECUTION_RETRYABLE,
      { retryEligible: true },
    ));
    const stale = attempt;
    const next = await store.createExecutionAttempt(createInput(work));

    await expect(
      store.patchExecutionAttempt({
        work: next.work,
        attempt: stale,
        owner: "test-owner",
        patch: {
          failureClass: "STALE_RESULT",
          failureMessage: "must not persist",
        },
        eventType: "execution.stale_result",
      }),
    ).rejects.toBeInstanceOf(FencedExecutionError);
    expect(await store.getCurrentExecutionAttempt(work.id)).toMatchObject({
      id: next.attempt.id,
      attemptNumber: 2,
      state: MastermindState.PROVISIONING,
    });
    expect(await store.listEvents(work.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "execution.fence_rejected",
          metadata: expect.objectContaining({ attemptId: stale.id }),
        }),
      ]),
    );
    store.close();
  });

  it("rejects a new attempt when the current retry is not eligible", async () => {
    const store = await createStore();
    const initial = await directWork(store);
    let { work, attempt } = await store.createExecutionAttempt(createInput(initial));

    for (const eventType of [
      MastermindEventType.WORKSPACE_PROVISIONED,
      MastermindEventType.PREFLIGHT_PASSED,
      MastermindEventType.EXECUTOR_STARTED,
      MastermindEventType.EXECUTOR_TERMINAL,
    ] as const) {
      ({ work, attempt } = await advance(store, work, attempt, eventType));
    }
    ({ work, attempt } = await advance(
      store,
      work,
      attempt,
      MastermindEventType.EXECUTION_RETRYABLE,
      { retryEligible: false },
    ));

    await expect(store.createExecutionAttempt(createInput(work))).rejects.toThrow(
      "Execution retry is not eligible",
    );
    store.close();
  });

  it("clears the current attempt when a succeeded work item reopens for review", async () => {
    const store = await createStore();
    const initial = await directWork(store);
    let { work, attempt } = await store.createExecutionAttempt(createInput(initial));

    for (const eventType of [
      MastermindEventType.WORKSPACE_PROVISIONED,
      MastermindEventType.PREFLIGHT_PASSED,
      MastermindEventType.EXECUTOR_STARTED,
      MastermindEventType.EXECUTOR_TERMINAL,
      MastermindEventType.EXECUTION_SUCCEEDED,
    ] as const) {
      ({ work, attempt } = await advance(store, work, attempt, eventType));
    }
    work = await store.transition(work, "test-owner", {
      eventType: MastermindEventType.REOPEN_REVIEW,
      priorState: work.state,
      nextState: MastermindState.REVIEWING,
    });

    expect(work.currentExecutionAttemptId).toBeUndefined();
    store.close();
  });

  it("lists recoverable execution pairs only after the short lease is released", async () => {
    const store = await createStore();
    const work = await directWork(store);
    const created = await store.createExecutionAttempt(createInput(work));

    await expect(store.listRecoverableExecutions(new Date())).resolves.toEqual([]);
    await store.releaseLease(work.id, "test-owner");
    await expect(store.listRecoverableExecutions(new Date())).resolves.toEqual([
      { workId: work.id, attemptId: created.attempt.id },
    ]);
    store.close();
  });

  it("deduplicates code reviews by immutable execution identity and rejects stale writes", async () => {
    const store = await createStore();
    const work = await directWork(store);
    const { attempt } = await store.createExecutionAttempt(createInput(work));
    const identity = {
      workId: work.id,
      executionAttemptId: attempt.id,
      commitSha: "abc123",
      resultHash: "result-hash",
      ticketHash: "ticket-hash",
    };

    const first = await store.createCodeReview(identity);
    const duplicate = await store.createCodeReview(identity);
    expect(duplicate.id).toBe(first.id);

    const running = await store.saveCodeReview({ review: first, status: "running" });
    await expect(store.saveCodeReview({ review: first, status: "passed" })).rejects.toThrow(
      "Stale code review",
    );
    await expect(store.getCurrentCodeReview(work.id)).resolves.toMatchObject({
      id: running.id,
      status: "running",
      commitSha: "abc123",
    });
    store.close();
  });
});

async function createStore(): Promise<SqliteMastermindStore> {
  const store = new SqliteMastermindStore(await databasePath());
  await store.initialize();
  return store;
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "weavekit-execution-store-"));
  directories.push(directory);
  return join(directory, "mastermind.sqlite");
}

async function directWork(store: SqliteMastermindStore): Promise<MastermindWorkItem> {
  const delivery = await store.ingestDelivery({
    deliveryId: crypto.randomUUID(),
    organizationId: "organization-one",
    eventType: "Issue",
    action: "create",
    issueId: crypto.randomUUID(),
  });
  let work = (await store.acquireLease(delivery.workId, "test-owner", new Date(), 60_000))!;
  for (const eventType of [
    MastermindEventType.CLAIM,
    MastermindEventType.DECIDE,
    MastermindEventType.PLAN_ACTION,
  ] as const) {
    const nextState = transitionMastermindState(work.state, { type: eventType });
    work = await store.transition(work, "test-owner", {
      eventType,
      priorState: work.state,
      nextState,
      ...(eventType === MastermindEventType.PLAN_ACTION
        ? { metadata: { plannedAction: MastermindAction.IMPLEMENT_DIRECTLY } }
        : {}),
    });
  }
  await store.setProjectPolicy(work.id, "weavekit");
  return (await store.getWork(work.id))!;
}

function createInput(work: MastermindWorkItem) {
  return {
    work,
    owner: "test-owner",
    projectPolicyId: "weavekit",
    projectPolicyVersion: "policy-one",
    executorKind: ExecutorKind.HERDR_COPILOT,
  };
}

async function advance(
  store: SqliteMastermindStore,
  work: MastermindWorkItem,
  attempt: ExecutionAttempt,
  eventType: Parameters<typeof transitionMastermindState>[1]["type"],
  patch: Parameters<SqliteMastermindStore["transitionExecutionAttempt"]>[0]["patch"] = {},
) {
  const nextState = transitionMastermindState(attempt.state, { type: eventType } as never);
  return store.transitionExecutionAttempt({
    work,
    attempt,
    owner: "test-owner",
    event: { eventType, priorState: attempt.state, nextState },
    patch,
  });
}
