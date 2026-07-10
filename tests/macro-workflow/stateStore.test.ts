import { open, readdir, writeFile } from "node:fs/promises";
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

  it("uses an adjacent bounded lock and leaves only an atomically renamed snapshot", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "workflow-state-store-"));
    const blockedStore = new MacroWorkflowStateStore(outputDir, {
      lockRetryMs: 5,
      lockTimeoutMs: 20,
    });
    const store = new MacroWorkflowStateStore(outputDir);
    let lockHandle;
    try {
      lockHandle = await open(store.lockPath, "wx");
      await expect(blockedStore.write(createState())).rejects.toThrow(
        "Timed out acquiring workflow state lock",
      );
      await lockHandle.close();
      lockHandle = undefined;
      await rm(store.lockPath, { force: true });

      await Promise.all([
        store.write(createState({ runName: "Writer One" })),
        store.write(createState({ runName: "Writer Two" })),
      ]);

      const state = await store.read();
      expect(["Writer One", "Writer Two"]).toContain(state.runName);
      expect(await readdir(outputDir)).toEqual(["workflow-state.json"]);
    } finally {
      await lockHandle?.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
