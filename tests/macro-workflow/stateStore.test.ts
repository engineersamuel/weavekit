import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MacroWorkflowStateStore,
  WORKFLOW_STATE_SCHEMA_VERSION,
} from "../../src/macro-workflow/stateStore.js";
import type { MacroWorkflowRunState } from "../../src/macro-workflow/types.js";

function createState(overrides: Partial<MacroWorkflowRunState> = {}): MacroWorkflowRunState {
  const plan = {
    id: "resume-plan",
    objective: "Resume a durable run",
    templateId: "implementation-review",
    maxReplans: 1,
    nodes: [],
  };
  return {
    runId: "run-123",
    runName: "Resume Durable Run",
    planId: plan.id,
    objective: plan.objective,
    templateId: plan.templateId,
    status: "running",
    startedAt: new Date("2026-07-10T10:00:00.000Z"),
    completedAt: new Date("2026-07-10T10:10:00.000Z"),
    plan,
    currentPlan: plan,
    nodeResults: [],
    replans: [
      {
        failedNodeId: "research",
        reason: "contract-failure",
        rationale: "Retry with a corrected node.",
        patch: {
          reason: "contract-failure",
          replaceRemainingNodeIds: [],
          newNodes: [],
        },
        timestamp: new Date("2026-07-10T10:05:00.000Z"),
      },
    ],
    ...overrides,
  };
}

describe("macro workflow state store", () => {
  it("does not let a delayed stale-lock reclaimer delete a successor owner", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "workflow-state-store-"));
    const lockPath = join(outputDir, "workflow-state.json.lock");
    const staleOwnerPath = join(lockPath, "owner-dead.json");
    const bothInspected = createDeferred<void>();
    const firstWriterAcquired = createDeferred<void>();
    const delayedReclaimAttempted = createDeferred<void>();
    let inspectedCount = 0;
    let activeWriters = 0;
    let maxActiveWriters = 0;
    const markInspected = async () => {
      inspectedCount += 1;
      if (inspectedCount === 2) {
        bothInspected.resolve(undefined);
      }
      await bothInspected.promise;
    };
    const trackAcquired = () => {
      activeWriters += 1;
      maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
    };
    const trackReleased = () => {
      activeWriters -= 1;
    };
    const firstStore = new MacroWorkflowStateStore(outputDir, {
      lockRetryMs: 2,
      lockTimeoutMs: 500,
      staleLockThresholdMs: 0,
      testHooks: {
        beforeReclaim: markInspected,
        onLockAcquired: async (ownerPath) => {
          trackAcquired();
          firstWriterAcquired.resolve(undefined);
          await delayedReclaimAttempted.promise;
          await expect(readFile(ownerPath, "utf8")).resolves.toContain(`"pid":${process.pid}`);
        },
        beforeLockRelease: trackReleased,
      },
    });
    const delayedStore = new MacroWorkflowStateStore(outputDir, {
      lockRetryMs: 2,
      lockTimeoutMs: 500,
      staleLockThresholdMs: 0,
      testHooks: {
        beforeReclaim: async () => {
          await markInspected();
          await firstWriterAcquired.promise;
        },
        afterReclaimAttempt: () => delayedReclaimAttempted.resolve(undefined),
        onLockAcquired: trackAcquired,
        beforeLockRelease: trackReleased,
      },
    });
    try {
      await mkdir(lockPath);
      await writeFile(
        staleOwnerPath,
        JSON.stringify({ pid: 2_147_483_647, createdAt: new Date().toISOString() }),
        "utf8",
      );

      await Promise.all([
        firstStore.write(createState({ runName: "First Writer" })),
        delayedStore.write(createState({ runName: "Delayed Writer" })),
      ]);

      expect(maxActiveWriters).toBe(1);
      expect(activeWriters).toBe(0);
      await expect(firstStore.read()).resolves.toMatchObject({
        runName: expect.stringMatching(/^(First|Delayed) Writer$/u),
      });
      await expect(readdir(outputDir)).resolves.toEqual(["workflow-state.json"]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("round-trips versioned state and revives every persisted Date field", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "workflow-state-store-"));
    try {
      const store = new MacroWorkflowStateStore(outputDir);

      await store.write(createState());
      const state = await store.read();

      expect(state.schemaVersion).toBe(WORKFLOW_STATE_SCHEMA_VERSION);
      expect(state.runId).toBe("run-123");
      expect(state.lastUpdatedAt).toBeInstanceOf(Date);
      expect(state.startedAt).toEqual(new Date("2026-07-10T10:00:00.000Z"));
      expect(state.completedAt).toEqual(new Date("2026-07-10T10:10:00.000Z"));
      expect(state.replans[0]?.timestamp).toEqual(new Date("2026-07-10T10:05:00.000Z"));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("loads legacy unversioned state and rejects unsupported future schemas", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "workflow-state-store-"));
    const store = new MacroWorkflowStateStore(outputDir);
    try {
      const legacy = createState({ runId: undefined });
      await writeFile(store.statePath, JSON.stringify(legacy), "utf8");

      const loaded = await store.read();
      expect(loaded.schemaVersion).toBe(WORKFLOW_STATE_SCHEMA_VERSION);
      expect(loaded.runId).toBe(basename(outputDir));
      expect(loaded.startedAt).toBeInstanceOf(Date);

      await writeFile(
        store.statePath,
        JSON.stringify({ ...legacy, schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION + 1 }),
        "utf8",
      );
      await expect(store.read()).rejects.toThrow("Unsupported workflow state schema version");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    "token",
    "secret",
    "password",
    "apiKey",
    "api_key",
    "authorization",
    "accessToken",
    "access_token",
  ])("refuses nested sensitive field %s without writing a snapshot", async (sensitiveKey) => {
    const outputDir = await mkdtemp(join(tmpdir(), "workflow-state-store-"));
    const store = new MacroWorkflowStateStore(outputDir);
    try {
      const state = createState({
        nodeResults: [
          {
            nodeId: "research",
            status: "passed",
            output: "complete",
            payload: { nested: { [sensitiveKey]: "do-not-persist" } },
          },
        ],
      });

      await expect(store.write(state)).rejects.toThrow(
        "Refusing to persist sensitive workflow state key",
      );
      await expect(readdir(outputDir)).resolves.not.toContain("workflow-state.json");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("does not reclaim an adjacent lock owned by a live process", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "workflow-state-store-"));
    const blockedStore = new MacroWorkflowStateStore(outputDir, {
      lockRetryMs: 5,
      lockTimeoutMs: 20,
      staleLockThresholdMs: 0,
    });
    const store = new MacroWorkflowStateStore(outputDir);
    const ownerPath = join(store.lockPath, "owner-live.json");
    try {
      await mkdir(store.lockPath);
      await writeFile(
        ownerPath,
        JSON.stringify({ pid: process.pid, createdAt: new Date(0).toISOString() }),
        "utf8",
      );
      await expect(blockedStore.write(createState())).rejects.toThrow(
        "Timed out acquiring workflow state lock",
      );
      await expect(readFile(ownerPath, "utf8")).resolves.toContain(`"pid":${process.pid}`);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reclaims a lock whose recorded owner process is dead", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "workflow-state-store-"));
    const store = new MacroWorkflowStateStore(outputDir, {
      lockRetryMs: 5,
      lockTimeoutMs: 100,
    });
    try {
      await writeFile(
        store.lockPath,
        JSON.stringify({ pid: 2_147_483_647, createdAt: new Date().toISOString() }),
        "utf8",
      );

      await store.write(createState({ runName: "Recovered Writer" }));

      await expect(store.read()).resolves.toMatchObject({ runName: "Recovered Writer" });
      await expect(readdir(outputDir)).resolves.toEqual(["workflow-state.json"]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reclaims incomplete owner metadata only after the stale threshold", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "workflow-state-store-"));
    const store = new MacroWorkflowStateStore(outputDir, {
      lockRetryMs: 5,
      lockTimeoutMs: 100,
      staleLockThresholdMs: 10,
    });
    const ownerPath = join(store.lockPath, "owner-incomplete.json");
    try {
      await mkdir(store.lockPath);
      await writeFile(ownerPath, JSON.stringify({ pid: process.pid }), "utf8");
      const oldTimestamp = new Date(Date.now() - 1_000);
      await utimes(ownerPath, oldTimestamp, oldTimestamp);

      await store.write(createState({ runName: "Recovered Partial Lock" }));

      await expect(store.read()).resolves.toMatchObject({ runName: "Recovered Partial Lock" });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent writers and leaves only an atomically renamed snapshot", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "workflow-state-store-"));
    const store = new MacroWorkflowStateStore(outputDir);
    try {
      await Promise.all([
        store.write(createState({ runName: "Writer One" })),
        store.write(createState({ runName: "Writer Two" })),
      ]);

      const state = await store.read();
      expect(["Writer One", "Writer Two"]).toContain(state.runName);
      expect(await readdir(outputDir)).toEqual(["workflow-state.json"]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
