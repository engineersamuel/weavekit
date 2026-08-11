import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MastermindExecutionDefaults } from "../../src/config.js";
import {
  buildDirectExecutionPrompt,
  directExecutionAgentName,
  ExecutorKind,
  HerdrDirectExecutor,
  parseDirectExecutionResult,
  startDirectExecutionWithApprovedPreflight,
  validateResultForRequest,
  type DirectExecutionRequest,
  type WorkspaceShell,
} from "../../src/submind/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Herdr direct executor", () => {
  it("starts Copilot in unattended autopilot with all permissions enabled", async () => {
    const worktreePath = await tempDirectory();
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    let agentStartAttempts = 0;
    const shell: WorkspaceShell = {
      async run(command, args, options) {
        calls.push({ command, args, cwd: options.cwd });
        if (args[0] === "workspace" && args[1] === "list") {
          return envelope({
            workspaces: [
              {
                workspace_id: "w-new",
                worktree: { checkout_path: worktreePath },
              },
            ],
          });
        }
        if (args[0] === "workspace" && args[1] === "get") {
          return envelope({
            workspace: {
              workspace_id: "w-new",
              active_tab_id: "w-new:t1",
            },
          });
        }
        if (args[0] === "pane" && args[1] === "list") {
          return envelope({
            panes: [
              {
                pane_id: "w-new:p1",
                tab_id: "w-new:t1",
                workspace_id: "w-new",
                cwd: worktreePath,
              },
            ],
          });
        }
        if (args[0] === "agent" && args[1] === "get") {
          throw new Error("agent not found");
        }
        if (args[0] === "agent" && args[1] === "start" && agentStartAttempts++ === 0) {
          throw new Error(
            '{"error":{"code":"agent_pane_busy","message":"agent target pane w-new:p1 is not an available shell"}}',
          );
        }
        return envelope({ ok: true });
      },
    };
    const executor = new HerdrDirectExecutor(executionConfig(), shell);
    const request = executionRequest(worktreePath);

    const handle = await startDirectExecutionWithApprovedPreflight(executor, request, {
      accepted: true,
      checkedAt: "2026-08-06T12:00:00.000Z",
      checks: [],
    });

    expect(handle).toMatchObject({
      executor: ExecutorKind.HERDR_COPILOT,
      agentName: "mm-workone-a1",
      lastObservedWorkspaceId: "w-new",
      lastObservedPaneId: "w-new:p1",
    });
    expect(calls.find((call) => call.args[1] === "start")?.args).toEqual([
      "agent",
      "start",
      "mm-workone-a1",
      "--kind",
      "copilot",
      "--pane",
      "w-new:p1",
      "--",
      "--autopilot",
      "--allow-all",
      "--no-ask-user",
      "--max-autopilot-continues",
      "7",
      "--allow-tool=write",
      "--allow-tool=shell(git:*)",
      "--deny-tool=shell(git push)",
      "--allow-url=github.com",
      "--deny-url=malicious.example",
    ]);
    expect(calls.filter((call) => call.args[1] === "start")).toHaveLength(2);
    expect(calls.find((call) => call.args[1] === "prompt")?.args).toEqual([
      "agent",
      "prompt",
      "mm-workone-a1",
      buildDirectExecutionPrompt(request),
      "--wait",
      "--until",
      "working",
      "--until",
      "blocked",
      "--until",
      "done",
      "--timeout",
      "30000",
    ]);
  });

  it("launches a custom harness command through the Herdr pane without Copilot flags", async () => {
    const worktreePath = await tempDirectory();
    const calls: Array<{ command: string; args: string[] }> = [];
    let agentLookups = 0;
    const shell: WorkspaceShell = {
      async run(command, args) {
        calls.push({ command, args });
        if (args[0] === "workspace" && args[1] === "list") {
          return envelope({
            workspaces: [{ workspace_id: "w-custom", worktree: { checkout_path: worktreePath } }],
          });
        }
        if (args[0] === "workspace" && args[1] === "get") {
          return envelope({ root_pane: { pane_id: "w-custom:p1" } });
        }
        if (args[0] === "agent" && args[1] === "get") {
          agentLookups += 1;
          if (agentLookups === 1) throw new Error("agent not found");
          return envelope({ agent: { agent_status: "idle" } });
        }
        return envelope({ ok: true });
      },
    };
    const config = {
      ...executionConfig(),
      harnessCommand: "codx",
      harnessArgs: ["--profile", "implementation"],
    };

    await startDirectExecutionWithApprovedPreflight(
      new HerdrDirectExecutor(config, shell),
      executionRequest(worktreePath),
      { accepted: true, checkedAt: new Date().toISOString(), checks: [] },
    );

    expect(calls.find((call) => call.args[1] === "run")?.args).toEqual([
      "pane",
      "run",
      "w-custom:p1",
      "'codx' '--profile' 'implementation'",
    ]);
    expect(calls.some((call) => call.args.includes("--autopilot"))).toBe(false);
    expect(calls.find((call) => call.args[1] === "rename")?.args).toEqual([
      "agent",
      "rename",
      "w-custom:p1",
      "mm-workone-a1",
    ]);
  });

  it("adopts an existing working agent without duplicating the prompt", async () => {
    const worktreePath = await tempDirectory();
    const prompt = vi.fn();
    const shell: WorkspaceShell = {
      async run(_command, args) {
        if (args[0] === "workspace" && args[1] === "list") {
          return envelope({
            workspaces: [{ workspace_id: "w1", worktree: { checkout_path: worktreePath } }],
          });
        }
        if (args[0] === "workspace" && args[1] === "get") {
          return envelope({ root_pane: { pane_id: "w1:p1" } });
        }
        if (args[0] === "agent" && args[1] === "get") {
          return envelope({
            agent: {
              agent_status: "working",
              cwd: worktreePath,
              pane_id: "w1:p1",
              workspace_id: "w1",
            },
          });
        }
        if (args[0] === "agent" && args[1] === "prompt") {
          prompt();
        }
        return envelope({ ok: true });
      },
    };

    await startDirectExecutionWithApprovedPreflight(
      new HerdrDirectExecutor(executionConfig(), shell),
      executionRequest(worktreePath),
      { accepted: true, checkedAt: new Date().toISOString(), checks: [] },
    );

    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not mistake a prior attempt marker for current prompt dispatch", async () => {
    const worktreePath = await tempDirectory();
    await mkdir(join(worktreePath, ".weavekit"));
    await writeFile(
      join(worktreePath, ".weavekit", "mastermind-attempt.json"),
      JSON.stringify({
        schemaVersion: 1,
        workId: "work-one",
        attemptId: "attempt-zero",
        attemptNumber: 0,
      }),
    );
    const shell: WorkspaceShell = {
      async run(_command, args) {
        if (args[0] === "workspace" && args[1] === "list") {
          return envelope({
            workspaces: [{ workspace_id: "w1", worktree: { checkout_path: worktreePath } }],
          });
        }
        if (args[0] === "workspace" && args[1] === "get") {
          return envelope({ root_pane: { pane_id: "w1:p1" } });
        }
        if (args[0] === "agent" && args[1] === "get") {
          return envelope({
            agent: {
              agent_status: "idle",
              cwd: worktreePath,
              pane_id: "w1:p1",
              workspace_id: "w1",
            },
          });
        }
        return envelope({ ok: true });
      },
    };

    await expect(
      startDirectExecutionWithApprovedPreflight(
        new HerdrDirectExecutor(executionConfig(), shell),
        executionRequest(worktreePath),
        { accepted: true, checkedAt: new Date().toISOString(), checks: [] },
      ),
    ).rejects.toThrow("prompt dispatch is ambiguous");
  });

  it("normalizes statuses and confirms cancellation only after a terminal wait", async () => {
    const worktreePath = await tempDirectory();
    let status = "blocked";
    const calls: string[][] = [];
    const shell: WorkspaceShell = {
      async run(_command, args) {
        calls.push(args);
        if (args[0] === "agent" && args[1] === "get") {
          return envelope({ agent: { agent_status: status } });
        }
        if (args[0] === "agent" && args[1] === "read") {
          return "blocked on missing credential";
        }
        if (args[0] === "agent" && args[1] === "wait") {
          status = "idle";
        }
        return envelope({ ok: true });
      },
    };
    const executor = new HerdrDirectExecutor(executionConfig(), shell);
    const handle = {
      executor: ExecutorKind.HERDR_COPILOT,
      agentName: "mm-workone-a1",
      worktreePath,
    };

    await expect(executor.status(handle)).resolves.toMatchObject({
      state: "blocked",
      detail: "blocked on missing credential",
    });
    await expect(executor.cancel(handle)).resolves.toMatchObject({
      confirmed: true,
      status: { state: "idle" },
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        ["agent", "send-keys", "mm-workone-a1", "ctrl-c"],
        [
          "agent",
          "wait",
          "mm-workone-a1",
          "--until",
          "idle",
          "--until",
          "done",
          "--timeout",
          "5000",
        ],
      ]),
    );
  });

  it("validates manifest identity, success evidence, PR host, and artifact containment", async () => {
    const worktreePath = await tempDirectory();
    await mkdir(join(worktreePath, ".weavekit"));
    await writeFile(join(worktreePath, "artifact.txt"), "ok");
    const manifest = {
      schemaVersion: 1,
      workId: "work-one",
      attemptId: "attempt-one",
      attemptNumber: 1,
      outcome: "succeeded",
      summary: "Implemented.",
      artifactPaths: ["artifact.txt"],
      pullRequestUrl: "https://github.com/example/repo/pull/1",
      verification: [{ command: "nub run test", exitCode: 0, summary: "passed" }],
      knownRisks: [],
      remainingWork: [],
    };
    await writeFile(
      join(worktreePath, ".weavekit", "mastermind-result.json"),
      JSON.stringify(manifest),
    );
    const executor = new HerdrDirectExecutor(executionConfig(), {
      run: vi.fn(),
    });
    const result = await executor.collect({
      executor: ExecutorKind.HERDR_COPILOT,
      agentName: "mm-workone-a1",
      worktreePath,
    });

    expect(result).toEqual(manifest);
    expect(() => validateResultForRequest(result, executionRequest(worktreePath))).not.toThrow();
    expect(() =>
      validateResultForRequest(
        { ...result, attemptId: "stale-attempt" },
        executionRequest(worktreePath),
      ),
    ).toThrow("stale or different attempt");
    expect(() =>
      parseDirectExecutionResult({
        ...manifest,
        verification: [],
      }),
    ).toThrow("passing verification");
  });

  it("requires a final work summary and specific manual verification guidance", async () => {
    const worktreePath = await tempDirectory();
    const prompt = buildDirectExecutionPrompt(executionRequest(worktreePath));

    expect(prompt).toContain("Final response requirements:");
    expect(prompt).toContain("Summarize all work completed");
    expect(prompt).toContain("Report the validation performed and its results.");
    expect(prompt).toContain(
      "Give the user concrete, step-by-step instructions to manually verify the completed work.",
    );
    expect(prompt).toContain("including commands, paths, or expected behavior where useful.");
  });

  it("creates deterministic Herdr-valid names", () => {
    expect(directExecutionAgentName("123E4567-E89B-12D3-A456-426614174000", 12)).toMatch(
      /^[a-z][a-z0-9_-]{0,31}$/u,
    );
  });
});

function executionConfig(): MastermindExecutionDefaults {
  return {
    executorKind: ExecutorKind.HERDR_COPILOT,
    harnessKind: "copilot",
    maxAutopilotContinues: 7,
    allowTools: ["write", "shell(git:*)"],
    denyTools: ["shell(git push)"],
    allowUrls: ["github.com"],
    denyUrls: ["malicious.example"],
    pollIntervalMs: 1000,
    unknownStatusThreshold: 3,
    cancellationGraceMs: 5000,
    promptAcceptanceTimeoutMs: 30000,
    maxAttempts: 2,
  };
}

function executionRequest(worktreePath: string): DirectExecutionRequest {
  return {
    workId: "work-one",
    attemptId: "attempt-one",
    attemptNumber: 1,
    objective: "Implement the ticket.",
    projectId: "weavekit",
    ticket: {
      id: "issue-one",
      identifier: "WK-1",
      url: "https://linear.app/example/issue/WK-1",
      title: "Implement direct execution",
      description: "Build the durable slice.",
      labels: [],
      status: "Todo",
      teamId: "team-one",
    },
    review: {
      id: "review-one",
      workId: "work-one",
      originalSnapshot: {} as DirectExecutionRequest["ticket"],
      originalContentHash: "hash",
      dossier: { summary: "Ready." } as DirectExecutionRequest["review"]["dossier"],
      patch: {
        automatedVerification: ["nub run test"],
      } as DirectExecutionRequest["review"]["patch"],
      contentApplied: true,
      labelApplied: true,
      invalidated: false,
    },
    decision: {
      action: "IMPLEMENT_DIRECTLY",
      rationale: "One bounded worker is sufficient.",
      prerequisites: [],
      policyEvidence: [],
      suggestedExecutorShape: "direct",
      confidence: 0.95,
    } as DirectExecutionRequest["decision"],
    workspace: {
      kind: "existing-repository-worktree",
      sourceRepositoryPath: worktreePath,
      checkoutPath: worktreePath,
      branchName: "mastermind/wk-1-work-one",
      parentWorkspaceLookupPath: worktreePath,
      creatorAttemptId: "attempt-one",
    },
    validationCommands: ["nub run test"],
    preflightRequirements: [],
    resultManifestPath: ".weavekit/mastermind-result.json",
    allowedPullRequestHosts: ["github.com"],
  };
}

function envelope(result: Record<string, unknown>): string {
  return JSON.stringify({ id: "test", result });
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "weavekit-herdr-executor-"));
  directories.push(directory);
  return directory;
}
