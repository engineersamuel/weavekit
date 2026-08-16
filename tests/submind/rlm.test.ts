import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MastermindRlmExecutionDefaults } from "../../src/config.js";
import {
  ExecutorKind,
  RlmDirectExecutor,
  startDirectExecutionWithApprovedPreflight,
  type DirectExecutionRequest,
  type RlmProcessLauncher,
} from "../../src/submind/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("RLM direct executor", () => {
  it("spawns a detached rlm-poc process rooted at the worktree with a written prompt file", async () => {
    const worktreePath = await tempDirectory();
    const spawnCalls: Array<{ command: string; args: string[]; cwd: string; logPath: string }> = [];
    const launcher = fakeLauncher({
      spawn(command, args, options) {
        spawnCalls.push({ command, args, cwd: options.cwd, logPath: options.logPath });
        return { pid: 4242 };
      },
    });
    const executor = new RlmDirectExecutor(
      executionConfig(),
      launcher,
      { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      "/repo/scripts/rlm-poc.ts",
      "/usr/bin/node",
    );
    const request = executionRequest(worktreePath);
    const weavekitDir = join(worktreePath, ".weavekit");
    await mkdir(weavekitDir, { recursive: true });
    await Promise.all([
      writeFile(join(weavekitDir, "mastermind-result.json"), "stale result"),
      writeFile(join(weavekitDir, "mastermind-rlm-output.json"), "stale output"),
      writeFile(join(weavekitDir, "mastermind-attempt.json"), "stale attempt"),
      writeFile(join(weavekitDir, "mastermind-rlm.log"), "stale log"),
    ]);

    const handle = await startDirectExecutionWithApprovedPreflight(executor, request, {
      accepted: true,
      checkedAt: "2026-08-06T12:00:00.000Z",
      checks: [],
    });

    expect(handle).toMatchObject({
      executor: ExecutorKind.RLM_SUBMIND,
      worktreePath,
      pid: 4242,
    });
    expect(handle.logPath).toContain(".weavekit");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.command).toBe("/usr/bin/node");
    expect(spawnCalls[0]?.cwd).toBe(worktreePath);
    expect(spawnCalls[0]?.args).toEqual([
      "/repo/scripts/rlm-poc.ts",
      "--prompt-file",
      join(worktreePath, ".weavekit", "mastermind-rlm-prompt.txt"),
      "--cwd",
      worktreePath,
      "--output-json",
      join(worktreePath, ".weavekit", "mastermind-rlm-output.json"),
      "--max-depth",
      "3",
      "--max-total-calls",
      "20",
      "--trellage",
    ]);

    const prompt = await readFile(
      join(worktreePath, ".weavekit", "mastermind-rlm-prompt.txt"),
      "utf8",
    );
    expect(prompt).not.toContain('nested "general" profile session');
    expect(prompt).toContain("Implement this reviewed Linear ticket directly");
    expect(prompt).toContain("A successful `gh auth status` is sufficient proof");
    expect(prompt).toContain(request.workId);
    await expect(readFile(join(weavekitDir, "mastermind-result.json"), "utf8")).rejects.toThrow();
    await expect(
      readFile(join(weavekitDir, "mastermind-rlm-output.json"), "utf8"),
    ).rejects.toThrow();
    await expect(readFile(join(weavekitDir, "mastermind-attempt.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(weavekitDir, "mastermind-rlm.log"), "utf8")).resolves.toBe("");
  });

  it("omits --trellage when the config disables it", async () => {
    const worktreePath = await tempDirectory();
    const spawnCalls: string[][] = [];
    const executor = new RlmDirectExecutor(
      { ...executionConfig(), enableTrellage: false },
      fakeLauncher({
        spawn(_command, args) {
          spawnCalls.push(args);
          return { pid: 1 };
        },
      }),
    );
    await startDirectExecutionWithApprovedPreflight(executor, executionRequest(worktreePath), {
      accepted: true,
      checkedAt: "2026-08-06T12:00:00.000Z",
      checks: [],
    });
    expect(spawnCalls[0]).not.toContain("--trellage");
  });

  it("reports working while the process is alive with no output file", async () => {
    const worktreePath = await tempDirectory();
    const executor = new RlmDirectExecutor(
      executionConfig(),
      fakeLauncher({ isAlive: () => true }),
    );
    const status = await executor.status({
      executor: ExecutorKind.RLM_SUBMIND,
      agentName: "mm-rlm-workone-a1",
      worktreePath,
      pid: 999,
    });
    expect(status.state).toBe("working");
  });

  it("reports unknown once the process exits without writing output", async () => {
    const worktreePath = await tempDirectory();
    const executor = new RlmDirectExecutor(
      executionConfig(),
      fakeLauncher({ isAlive: () => false }),
    );
    const status = await executor.status({
      executor: ExecutorKind.RLM_SUBMIND,
      agentName: "mm-rlm-workone-a1",
      worktreePath,
      pid: 999,
    });
    expect(status.state).toBe("unknown");
    expect(status.detail).toContain("exited without writing");
  });

  it("reports done once the captured output JSON says the run succeeded", async () => {
    const worktreePath = await tempDirectory();
    await writeOutputJson(worktreePath, {
      ok: true,
      result: { finalText: "All done.", traceId: "trace-1" },
      observedAt: "2026-08-06T12:05:00.000Z",
    });
    const executor = new RlmDirectExecutor(executionConfig(), fakeLauncher());
    const status = await executor.status({
      executor: ExecutorKind.RLM_SUBMIND,
      agentName: "mm-rlm-workone-a1",
      worktreePath,
      pid: 999,
    });
    expect(status.state).toBe("done");
  });

  it("reports blocked once the captured output JSON says the run failed", async () => {
    const worktreePath = await tempDirectory();
    await writeOutputJson(worktreePath, {
      ok: false,
      error: "Copilot SDK session errored out.",
      observedAt: "2026-08-06T12:05:00.000Z",
    });
    const executor = new RlmDirectExecutor(executionConfig(), fakeLauncher());
    const status = await executor.status({
      executor: ExecutorKind.RLM_SUBMIND,
      agentName: "mm-rlm-workone-a1",
      worktreePath,
      pid: 999,
    });
    expect(status.state).toBe("blocked");
    expect(status.detail).toContain("Copilot SDK session errored out.");
  });

  it("collects the structured manifest when the delegated session honored the contract", async () => {
    const worktreePath = await tempDirectory();
    const request = executionRequest(worktreePath);
    const manifest = {
      schemaVersion: 1,
      workId: request.workId,
      attemptId: request.attemptId,
      attemptNumber: request.attemptNumber,
      outcome: "succeeded",
      summary: "Implemented the ticket.",
      artifactPaths: [],
      verification: [{ command: "nub run test", exitCode: 0, summary: "passed" }],
      knownRisks: [],
      remainingWork: [],
    };
    await mkdir(join(worktreePath, ".weavekit"), { recursive: true });
    await writeFile(
      join(worktreePath, ".weavekit", "mastermind-result.json"),
      JSON.stringify(manifest),
    );
    const executor = new RlmDirectExecutor(executionConfig(), fakeLauncher());

    const result = await executor.collect(
      { executor: ExecutorKind.RLM_SUBMIND, agentName: "mm-rlm-workone-a1", worktreePath },
      request,
    );

    expect(result).toEqual(manifest);
  });

  it("attaches the Submind Langfuse trace reference to a manifest result when the captured output JSON has one", async () => {
    const worktreePath = await tempDirectory();
    const request = executionRequest(worktreePath);
    const manifest = {
      schemaVersion: 1,
      workId: request.workId,
      attemptId: request.attemptId,
      attemptNumber: request.attemptNumber,
      outcome: "succeeded",
      summary: "Implemented the ticket.",
      artifactPaths: [],
      verification: [{ command: "nub run test", exitCode: 0, summary: "passed" }],
      knownRisks: [],
      remainingWork: [],
    };
    await mkdir(join(worktreePath, ".weavekit"), { recursive: true });
    await writeFile(
      join(worktreePath, ".weavekit", "mastermind-result.json"),
      JSON.stringify(manifest),
    );
    await writeOutputJson(worktreePath, {
      ok: true,
      result: { finalText: "All done.", conversationId: "conv-1", traceId: "trace-3" },
      observedAt: "2026-08-06T12:05:00.000Z",
    });
    const executor = new RlmDirectExecutor(executionConfig(), fakeLauncher());

    const result = await executor.collect(
      { executor: ExecutorKind.RLM_SUBMIND, agentName: "mm-rlm-workone-a1", worktreePath },
      request,
    );

    expect(result.submindTrace).toMatchObject({
      traceId: "trace-3",
      conversationId: "conv-1",
    });
  });

  it("falls back to a needs-human result carrying Submind's captured final text when no manifest was written", async () => {
    const worktreePath = await tempDirectory();
    const request = executionRequest(worktreePath);
    await writeOutputJson(worktreePath, {
      ok: true,
      result: { finalText: "I looked around but made no changes.", traceId: "trace-2" },
      observedAt: "2026-08-06T12:05:00.000Z",
    });
    const executor = new RlmDirectExecutor(executionConfig(), fakeLauncher());

    const result = await executor.collect(
      { executor: ExecutorKind.RLM_SUBMIND, agentName: "mm-rlm-workone-a1", worktreePath },
      request,
    );

    expect(result.outcome).toBe("needs-human");
    expect(result.workId).toBe(request.workId);
    expect(result.attemptId).toBe(request.attemptId);
    expect(result.attemptNumber).toBe(request.attemptNumber);
    expect(result.summary).toContain("I looked around but made no changes.");
    expect(result.submindTrace?.traceId).toBe("trace-2");
  });

  it("falls back to a needs-human result describing the failure when the run errored", async () => {
    const worktreePath = await tempDirectory();
    const request = executionRequest(worktreePath);
    await writeOutputJson(worktreePath, {
      ok: false,
      error: "Copilot SDK session errored out.",
      observedAt: "2026-08-06T12:05:00.000Z",
    });
    const executor = new RlmDirectExecutor(executionConfig(), fakeLauncher());

    const result = await executor.collect(
      { executor: ExecutorKind.RLM_SUBMIND, agentName: "mm-rlm-workone-a1", worktreePath },
      request,
    );

    expect(result.outcome).toBe("needs-human");
    expect(result.summary).toContain("Copilot SDK session errored out.");
  });

  it("throws when collection is attempted before either the manifest or output JSON exists", async () => {
    const worktreePath = await tempDirectory();
    const request = executionRequest(worktreePath);
    const executor = new RlmDirectExecutor(executionConfig(), fakeLauncher());

    await expect(
      executor.collect(
        { executor: ExecutorKind.RLM_SUBMIND, agentName: "mm-rlm-workone-a1", worktreePath },
        request,
      ),
    ).rejects.toThrow("neither a result manifest nor a captured Submind output");
  });

  it("sends SIGTERM and confirms cancellation once the process reports as dead", async () => {
    const worktreePath = await tempDirectory();
    const signals: NodeJS.Signals[] = [];
    let alive = true;
    const executor = new RlmDirectExecutor(
      executionConfig(),
      fakeLauncher({
        kill: (_pid, signal) => {
          signals.push(signal);
          alive = false;
        },
        isAlive: () => alive,
      }),
    );

    const { confirmed } = await executor.cancel({
      executor: ExecutorKind.RLM_SUBMIND,
      agentName: "mm-rlm-workone-a1",
      worktreePath,
      pid: 555,
    });

    expect(confirmed).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);
  });
});

function fakeLauncher(overrides: Partial<RlmProcessLauncher> = {}): RlmProcessLauncher {
  return {
    spawn: overrides.spawn ?? (() => ({ pid: 1 })),
    isAlive: overrides.isAlive ?? (() => false),
    kill: overrides.kill ?? (() => {}),
  };
}

async function writeOutputJson(worktreePath: string, payload: unknown): Promise<void> {
  await mkdir(join(worktreePath, ".weavekit"), { recursive: true });
  await writeFile(
    join(worktreePath, ".weavekit", "mastermind-rlm-output.json"),
    JSON.stringify(payload),
  );
}

function executionConfig(): MastermindRlmExecutionDefaults {
  return {
    executorKind: ExecutorKind.RLM_SUBMIND,
    profile: "general",
    maxDepth: 3,
    maxTotalCalls: 20,
    enableTrellage: true,
    pollIntervalMs: 1000,
    unknownStatusThreshold: 3,
    cancellationGraceMs: 200,
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
      action: "DELEGATE_SUBMIND",
      rationale: "This work needs the recursive Submind harness.",
      prerequisites: [],
      policyEvidence: [],
      suggestedExecutorShape: "delegate",
      confidence: 0.9,
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

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "weavekit-rlm-executor-"));
  directories.push(directory);
  return directory;
}
