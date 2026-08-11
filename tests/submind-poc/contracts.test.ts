import { describe, expect, it } from "vitest";
import {
  SubmindEventSchema,
  SubmindManifestSchema,
  SubmindRunStateSchema,
} from "../../src/submind-poc/contracts.js";

describe("submind POC contracts", () => {
  it("rejects completed state without a manifest", () => {
    expect(() =>
      SubmindRunStateSchema.parse({
        schemaVersion: 1,
        runId: "run-1",
        state: "completed",
        sourceRepositoryPath: "/repo",
        branchName: "submind/poc-run-1",
        runDirectory: "/repo/.weavekit/submind-poc/run-1",
        agentPrefix: "submind-run-1-",
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects malformed persisted events", () => {
    expect(() =>
      SubmindEventSchema.parse({
        schemaVersion: 1,
        sequence: 0,
        runId: "run-1",
        type: "operation",
        timestamp: "not-a-date",
        data: {},
      }),
    ).toThrow();
  });

  it("requires four complete worker conversations for success", () => {
    expect(() =>
      SubmindManifestSchema.parse({
        schemaVersion: 1,
        runId: "run-1",
        outcome: "completed",
        sourceRepositoryPath: "/repo",
        worktreePath: "/worktree",
        branchName: "submind/poc-run-1",
        workspaceId: "workspace-1",
        orchestrator: { paneId: "pane-1", agentId: "agent-1", name: "submind-run-1-orchestrator" },
        workers: [],
        startedAt: "2026-08-06T00:00:00.000Z",
        completedAt: "2026-08-06T00:01:00.000Z",
      }),
    ).toThrow();
  });

  it("requires distinct worker and orchestrator identities", () => {
    const worker = {
      command: "command",
      paneId: "pane-1",
      agentId: "agent-1",
      name: "worker",
      question: "question?",
      answer: "answer",
      acknowledgement: "acknowledged",
      launchedAt: "2026-08-06T00:00:00.000Z",
      answeredAt: "2026-08-06T00:00:01.000Z",
      acknowledgedAt: "2026-08-06T00:00:02.000Z",
    };
    expect(() =>
      SubmindManifestSchema.parse({
        schemaVersion: 1,
        runId: "run-1",
        outcome: "completed",
        sourceRepositoryPath: "/repo",
        worktreePath: "/worktree",
        branchName: "submind/poc-run-1",
        workspaceId: "workspace-1",
        orchestrator: { paneId: "pane-1", agentId: "agent-1", name: "orchestrator" },
        workers: [
          { ...worker, kind: "copilot" },
          { ...worker, kind: "grok" },
          { ...worker, kind: "codex" },
          { ...worker, kind: "claude" },
        ],
        startedAt: "2026-08-06T00:00:00.000Z",
        completedAt: "2026-08-06T00:01:00.000Z",
      }),
    ).toThrow("five distinct agents and panes");
  });
});
