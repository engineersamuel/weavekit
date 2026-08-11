import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubmindManifestSchema } from "../../src/submind-poc/contracts.js";
import { assertRequiredReceipts, validateWorkerLaunch } from "../../src/submind-poc/helper.js";
import { SubmindStore } from "../../src/submind-poc/store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("submind scoped helper", () => {
  it("allows only exact worker launch commands", () => {
    expect(() =>
      validateWorkerLaunch(
        {
          paneId: "pane-1",
          name: "submind-run-one-copilot",
          kind: "copilot",
          command: "copilot",
          args: ["--autopilot", "--allow-all", "--no-ask-user"],
          interactive: true,
        },
        "submind-run-one-",
      ),
    ).not.toThrow();
    expect(() =>
      validateWorkerLaunch(
        {
          paneId: "pane-4",
          name: "submind-run-one-claude-council",
          command: "trellage",
          args: ["--profile", "claude-council"],
          interactive: true,
        },
        "submind-run-one-",
      ),
    ).not.toThrow();
    expect(() =>
      validateWorkerLaunch(
        {
          paneId: "pane-2",
          name: "submind-run-one-grok",
          command: "grx",
          args: ["superpowers"],
          interactive: true,
        },
        "submind-run-one-",
      ),
    ).toThrow("outside POC allowlist");
  });

  it("rejects launch names outside run prefix", () => {
    expect(() =>
      validateWorkerLaunch(
        {
          paneId: "pane-3",
          name: "foreign-codex",
          command: "codx",
          args: [],
          interactive: true,
        },
        "submind-run-one-",
      ),
    ).toThrow("outside run scope");
  });

  it("rejects temporary launch-name suffixes", () => {
    expect(() =>
      validateWorkerLaunch(
        {
          paneId: "pane-3",
          name: "submind-run-one-codex-launch",
          command: "codx",
          args: [],
          interactive: true,
        },
        "submind-run-one-",
      ),
    ).toThrow("must be canonical");
  });

  it("requires each worker receipt sequence to follow both conversation phases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "submind-helper-"));
    directories.push(directory);
    const store = new SubmindStore(directory);
    const workers = [
      { kind: "copilot", paneId: "pane-copilot", agentId: "agent-copilot" },
      { kind: "grok", paneId: "pane-grok", agentId: "agent-grok" },
      { kind: "codex", paneId: "pane-codex", agentId: "agent-codex" },
      { kind: "claude", paneId: "pane-claude", agentId: "agent-claude" },
    ] as const;
    const append = async (operation: string, data: Record<string, unknown>) =>
      store.appendEvent({
        runId: "run-one",
        type: "receipt",
        timestamp: "2026-08-06T00:00:00.000Z",
        data: { source: "helper", operation, ...data },
      });
    for (const worker of workers) {
      const name = `submind-run-one-${worker.kind}`;
      await append("tab.accepted", {
        createdPaneId: worker.paneId,
        createdTabId: `tab-${worker.kind}`,
      });
      await append("launch.accepted", {
        paneId: worker.paneId,
        name,
      });
      await append("rename.accepted", { agentId: worker.agentId, name });
      if (worker.kind === "codex") {
        await append("plan.accepted", { agentId: worker.agentId });
      }
      const operations =
        worker.kind === "codex"
          ? [
              "prompt.accepted",
              "wait.accepted",
              "prompt.accepted",
              "read.accepted",
              "wait.accepted",
              "read.accepted",
            ]
          : [
              "prompt.accepted",
              "wait.accepted",
              "read.accepted",
              "prompt.accepted",
              "wait.accepted",
              "read.accepted",
            ];
      for (const operation of operations) await append(operation, { agentId: worker.agentId });
    }
    const manifest = SubmindManifestSchema.parse({
      schemaVersion: 1,
      runId: "run-one",
      outcome: "completed",
      sourceRepositoryPath: "/repo",
      worktreePath: "/worktree",
      branchName: "submind/poc-run-one",
      workspaceId: "workspace-one",
      orchestrator: {
        paneId: "pane-orchestrator",
        agentId: "agent-orchestrator",
        name: "submind-run-one-orchestrator",
      },
      workers: workers.map((worker) => ({
        ...worker,
        command:
          worker.kind === "copilot"
            ? "copilot --autopilot --allow-all --no-ask-user"
            : worker.kind === "grok"
              ? "grx superpowers --permission-mode bypassPermissions"
              : worker.kind === "codex"
                ? "codx"
                : "trellage --profile claude-council",
        name:
          worker.kind === "claude"
            ? "submind-run-one-claude-council"
            : `submind-run-one-${worker.kind}`,
        question: `favorite ${worker.kind}?`,
        answer: "answer",
        acknowledgement: "ack",
        launchedAt: "2026-08-06T00:00:00.000Z",
        answeredAt: "2026-08-06T00:00:01.000Z",
        acknowledgedAt: "2026-08-06T00:00:02.000Z",
      })),
      startedAt: "2026-08-06T00:00:00.000Z",
      completedAt: "2026-08-06T00:01:00.000Z",
    });

    await expect(assertRequiredReceipts(store, manifest)).rejects.toThrow(
      "Missing ordered helper receipt for submind-run-one-codex: prompt.accepted",
    );
  });
});
