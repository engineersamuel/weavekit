import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SubmindController,
  buildOrchestratorPrompt,
  orchestratorArgs,
  randomSubmindOrchestratorModel,
  stageSubmindSkill,
} from "../../src/submind-poc/controller.js";
import {
  SubmindOrchestratorModel,
  type SubmindManifest,
  type SubmindRunState,
} from "../../src/submind-poc/contracts.js";
import { SubmindStore } from "../../src/submind-poc/store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("SubmindController", () => {
  it("persists intent before provisioning and records orchestrator acceptance", async () => {
    const controlRoot = await tempDirectory();
    const source = await tempDirectory();
    const worktree = await tempDirectory();
    const observations: string[] = [];
    const provision = vi.fn(async (state: SubmindRunState) => {
      const persisted = await new SubmindStore(state.runDirectory).readState();
      observations.push(persisted.state);
      return { worktreePath: worktree, workspaceId: "workspace-1", rootPaneId: "pane-1" };
    });
    const stageSkill = vi.fn();
    const startOrchestrator = vi.fn().mockResolvedValue({ agentId: "agent-orchestrator" });
    const promptOrchestrator = vi.fn().mockResolvedValue(undefined);
    const controller = new SubmindController({
      controlRoot,
      canonicalRepository: vi.fn().mockResolvedValue(source),
      provision,
      stageSkill,
      preflight: vi.fn().mockResolvedValue(undefined),
      startOrchestrator,
      promptOrchestrator,
      selectOrchestratorModel: () => SubmindOrchestratorModel.GPT_5_6_SOL,
      now: () => new Date("2026-08-06T00:00:00.000Z"),
      runId: () => "run-one",
    });

    const result = await controller.start(source, true);

    expect(observations).toEqual(["provisioning"]);
    expect(result.state).toBe("orchestrating");
    expect(result.branchName).toBe("submind/poc-run-one");
    expect(stageSkill).toHaveBeenNthCalledWith(
      1,
      worktree,
      "mastermind-submind",
      expect.stringContaining("# Mastermind Submind"),
    );
    expect(stageSkill).toHaveBeenNthCalledWith(
      2,
      worktree,
      "submind-poc",
      expect.stringContaining("# Durable Submind POC"),
    );
    expect(startOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: "pane-1",
        name: "submind-run-one-orchestrator",
        command: "copilot",
        args: [
          "--autopilot",
          "--allow-all",
          "--no-ask-user",
          "--model",
          "gpt-5.6-sol",
          "--reasoning-effort",
          "high",
        ],
      }),
    );
    expect(promptOrchestrator).toHaveBeenCalledOnce();
  });

  it("reconciles a valid manifest as success and never trusts lifecycle status alone", async () => {
    const controlRoot = await tempDirectory();
    const runDirectory = join(controlRoot, ".weavekit", "submind-poc", "run-one");
    const store = new SubmindStore(runDirectory);
    await store.initialize(runState(runDirectory));
    const controller = new SubmindController(controllerDependencies(controlRoot));

    const withoutManifest = await controller.status("run-one");
    expect(withoutManifest.state).toBe("orchestrating");

    await store.appendEvent({
      runId: "run-one",
      type: "receipt",
      timestamp: "2026-08-06T00:01:00.000Z",
      data: {
        source: "helper",
        operation: "manifest.complete",
        outcome: "completed",
        verified: true,
      },
    });
    await store.writeManifest(validManifest());
    const completed = await controller.status("run-one");
    expect(completed.state).toBe("completed");
  });

  it("reconciles a valid manifest before resuming provisioning mutations", async () => {
    const controlRoot = await tempDirectory();
    const runDirectory = join(controlRoot, ".weavekit", "submind-poc", "run-one");
    const store = new SubmindStore(runDirectory);
    const provisioning = { ...runState(runDirectory), state: "provisioning" as const };
    await store.initialize(provisioning);
    await store.appendEvent({
      runId: "run-one",
      type: "receipt",
      timestamp: "2026-08-06T00:01:00.000Z",
      data: { source: "helper", operation: "manifest.complete", verified: true },
    });
    await store.writeManifest(validManifest());
    const provision = vi.fn();
    const controller = new SubmindController({
      ...controllerDependencies(controlRoot),
      provision,
    });

    await expect(controller.status("run-one")).resolves.toMatchObject({ state: "completed" });
    expect(provision).not.toHaveBeenCalled();
  });

  it("persists failure when interactive alias preflight fails", async () => {
    const controlRoot = await tempDirectory();
    const source = await tempDirectory();
    const worktree = await tempDirectory();
    const controller = new SubmindController({
      ...controllerDependencies(controlRoot),
      canonicalRepository: vi.fn().mockResolvedValue(source),
      provision: vi.fn().mockResolvedValue({
        worktreePath: worktree,
        workspaceId: "workspace-1",
        rootPaneId: "pane-1",
      }),
      preflight: vi.fn().mockRejectedValue(new Error("Unavailable interactive-shell command: grx")),
      now: () => new Date("2026-08-06T00:00:00.000Z"),
      runId: () => "run-one",
    });

    await expect(controller.start(source, true)).rejects.toThrow("Unavailable interactive-shell");
    await expect(
      new SubmindStore(join(controlRoot, ".weavekit", "submind-poc", "run-one")).readState(),
    ).resolves.toMatchObject({ state: "failed", failure: expect.stringContaining("grx") });
  });

  it("does not duplicate launches when detached start is reconciled later", async () => {
    const controlRoot = await tempDirectory();
    const runDirectory = join(controlRoot, ".weavekit", "submind-poc", "run-one");
    const store = new SubmindStore(runDirectory);
    await store.initialize(runState(runDirectory));
    const startOrchestrator = vi.fn();
    const controller = new SubmindController({
      ...controllerDependencies(controlRoot),
      startOrchestrator,
    });

    await controller.status("run-one");
    await controller.status("run-one");

    expect(startOrchestrator).not.toHaveBeenCalled();
  });

  it("fails reconciliation on a malformed final manifest", async () => {
    const controlRoot = await tempDirectory();
    const runDirectory = join(controlRoot, ".weavekit", "submind-poc", "run-one");
    const store = new SubmindStore(runDirectory);
    await store.initialize(runState(runDirectory));
    await store.appendEvent({
      runId: "run-one",
      type: "receipt",
      timestamp: "2026-08-06T00:01:00.000Z",
      data: { source: "helper", operation: "manifest.complete", verified: true },
    });
    await writeFile(store.manifestPath, "{}\n");

    const state = await new SubmindController(controllerDependencies(controlRoot)).status(
      "run-one",
    );

    expect(state.state).toBe("failed");
    expect(state.failure).toContain("Malformed submind manifest");
  });

  it("persists wait timeout as terminal failure", async () => {
    const controlRoot = await tempDirectory();
    const runDirectory = join(controlRoot, ".weavekit", "submind-poc", "run-one");
    await new SubmindStore(runDirectory).initialize(runState(runDirectory));
    const controller = new SubmindController(controllerDependencies(controlRoot));

    const state = await controller.wait("run-one", 0);

    expect(state).toMatchObject({
      state: "failed",
      failure: "Timed out waiting for submind run: run-one",
    });
  });
});

describe("orchestrator prompt", () => {
  it("uses only approved orchestrator models with high reasoning effort", () => {
    expect(randomSubmindOrchestratorModel(0)).toBe(SubmindOrchestratorModel.GPT_5_6_SOL);
    expect(randomSubmindOrchestratorModel(1)).toBe(SubmindOrchestratorModel.CLAUDE_OPUS_5);
    expect(orchestratorArgs(SubmindOrchestratorModel.CLAUDE_OPUS_5)).toEqual([
      "--autopilot",
      "--allow-all",
      "--no-ask-user",
      "--model",
      "claude-opus-5",
      "--reasoning-effort",
      "high",
    ]);
  });

  it("stages each instruction skill in the assigned worktree", async () => {
    const worktree = await tempDirectory();

    await stageSubmindSkill(worktree, "mastermind-submind", "operating instructions\n");

    await expect(
      readFile(join(worktree, ".github", "skills", "mastermind-submind", "SKILL.md"), "utf8"),
    ).resolves.toBe("operating instructions\n");
  });

  it("delegates all reasoning and worker control through the scoped helper", () => {
    const prompt = buildOrchestratorPrompt({
      runId: "run-one",
      controlRoot: "/control",
      helperScript: "/control/scripts/submind-poc.ts",
      agentPrefix: "submind-run-one-",
      orchestratorModel: SubmindOrchestratorModel.GPT_5_6_SOL,
      manifestPath: "/control/.weavekit/submind-poc/run-one/manifest.json",
      sourceRepositoryPath: "/repo",
      worktreePath: "/worktree",
      branchName: "submind/poc-run-one",
      workspaceId: "workspace-1",
      orchestratorPaneId: "pane-1",
      orchestratorAgentId: "agent-1",
      orchestratorName: "submind-run-one-orchestrator",
    });

    expect(prompt).toContain(
      "nub /control/scripts/submind-poc.ts helper --control-root /control --run run-one",
    );
    expect(prompt).toContain("Use the mastermind-submind skill first");
    expect(prompt).toContain("Orchestrator model: gpt-5.6-sol");
    expect(prompt).toContain("copilot --autopilot --allow-all --no-ask-user");
    expect(prompt).toContain("grx superpowers --permission-mode bypassPermissions");
    expect(prompt).toContain("codx");
    expect(prompt).toContain("trellage --profile claude-council");
    expect(prompt).toContain("favorite color");
    expect(prompt).toContain("favorite movie");
    expect(prompt).toContain("favorite book");
    expect(prompt).toContain("favorite programming language");
    expect(prompt).toContain("Never call Herdr CLI or socket directly");
  });
});

describe("ambiguous orchestrator mutations", () => {
  it("keeps launch ambiguity reconcilable instead of persisting terminal failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "submind-controller-"));
    directories.push(root);
    const preflight = vi.fn().mockResolvedValue(undefined);
    const startOrchestrator = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Herdr socket disconnected with ambiguous operation state: agent.start"),
      )
      .mockResolvedValueOnce({ agentId: "agent-adopted" });
    const controller = new SubmindController({
      controlRoot: root,
      canonicalRepository: async () => "/repo",
      provision: async () => ({
        worktreePath: "/worktree",
        workspaceId: "workspace-one",
        rootPaneId: "pane-one",
      }),
      stageSkill: async () => undefined,
      preflight,
      startOrchestrator,
      promptOrchestrator: async () => undefined,
      now: () => new Date("2026-08-06T00:00:00.000Z"),
      runId: () => "run-ambiguous",
    });

    await expect(controller.start("/repo", true)).rejects.toThrow("ambiguous operation state");
    const state = await new SubmindStore(
      join(root, ".weavekit", "submind-poc", "run-ambiguous"),
    ).readState();
    expect(state.state).toBe("provisioning");
    expect(state.failure).toBeUndefined();

    await expect(controller.status("run-ambiguous")).resolves.toMatchObject({
      state: "orchestrating",
      orchestratorAgentId: "agent-adopted",
    });
    expect(preflight).toHaveBeenCalledTimes(1);
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "submind-controller-"));
  directories.push(directory);
  return directory;
}

function controllerDependencies(controlRoot: string) {
  return {
    controlRoot,
    canonicalRepository: vi.fn(),
    provision: vi.fn(),
    stageSkill: vi.fn(),
    preflight: vi.fn(),
    startOrchestrator: vi.fn(),
    promptOrchestrator: vi.fn(),
  };
}

function runState(runDirectory: string) {
  return {
    schemaVersion: 1 as const,
    runId: "run-one",
    state: "orchestrating" as const,
    sourceRepositoryPath: "/repo",
    branchName: "submind/poc-run-one",
    runDirectory,
    agentPrefix: "submind-run-one-",
    orchestratorModel: SubmindOrchestratorModel.GPT_5_6_SOL,
    worktreePath: "/worktree",
    workspaceId: "workspace-1",
    rootPaneId: "pane-1",
    orchestratorAgentId: "agent-orchestrator",
    orchestratorPromptAcceptedAt: "2026-08-06T00:00:00.000Z",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  };
}

function validManifest(): SubmindManifest {
  const workers = [
    ["copilot", "favorite color?", "blue"],
    ["grok", "favorite movie?", "Arrival"],
    ["codex", "favorite book?", "Dune"],
    ["claude", "favorite programming language?", "TypeScript"],
  ] as const;
  const records: SubmindManifest["workers"] = workers.map(([kind, question, answer], index) => ({
    kind,
    command:
      kind === "copilot"
        ? "copilot --autopilot --allow-all --no-ask-user"
        : kind === "grok"
          ? "grx superpowers --permission-mode bypassPermissions"
          : kind === "codex"
            ? "codx"
            : "trellage --profile claude-council",
    paneId: `pane-${index + 2}`,
    agentId: `agent-${index + 2}`,
    name: kind === "claude" ? "submind-run-one-claude-council" : `submind-run-one-${kind}`,
    question,
    answer,
    acknowledgement: `Noted: ${answer}`,
    launchedAt: "2026-08-06T00:00:00.000Z",
    answeredAt: "2026-08-06T00:00:10.000Z",
    acknowledgedAt: "2026-08-06T00:00:20.000Z",
  }));
  return {
    schemaVersion: 1 as const,
    runId: "run-one",
    outcome: "completed" as const,
    sourceRepositoryPath: "/repo",
    worktreePath: "/worktree",
    branchName: "submind/poc-run-one",
    workspaceId: "workspace-1",
    orchestrator: {
      paneId: "pane-1",
      agentId: "agent-orchestrator",
      name: "submind-run-one-orchestrator",
    },
    workers: records,
    startedAt: "2026-08-06T00:00:00.000Z",
    completedAt: "2026-08-06T00:01:00.000Z",
  };
}
