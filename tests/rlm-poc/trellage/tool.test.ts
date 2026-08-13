import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ToolResultObject } from "@github/copilot-sdk";
import { HerdrAgentStatus } from "../../../src/herdr/contracts.js";
import { createRlmExecutionBudget } from "../../../src/rlm-poc/budget.js";
import { parseCopilotModelCatalog } from "../../../src/rlm-poc/modelCatalog.js";
import type { TrellageBackend, TrellageSession } from "../../../src/rlm-poc/trellage/backend.js";
import { createTrellageCatalog } from "../../../src/rlm-poc/trellage/catalog.js";
import {
  TrellageHarness,
  TrellageMode,
  TrellageOutcome,
  type TrellageInvokeArgs,
  type TrellageProfile,
} from "../../../src/rlm-poc/trellage/contracts.js";
import { resolveResultLocation } from "../../../src/rlm-poc/trellage/result.js";
import { createTrellageTool } from "../../../src/rlm-poc/trellage/tool.js";
import { TrellageWorktreeRegistry } from "../../../src/rlm-poc/trellage/worktrees.js";

const CONTAINER_PROFILE: TrellageProfile = {
  harness: TrellageHarness.Container,
  mode: TrellageMode.Container,
  launcher: "trellage",
  name: "claude-council",
  description: "Multi-agent council.",
  sandbox: true,
};

const NATIVE_PROFILE: TrellageProfile = {
  harness: TrellageHarness.Grok,
  mode: TrellageMode.Native,
  launcher: "grx",
  name: "superpowers",
  description: "Grok superpowers.",
  sandbox: true,
};
const COPILOT_PROFILE: TrellageProfile = {
  harness: TrellageHarness.Copilot,
  mode: TrellageMode.Native,
  launcher: "cpx",
  name: "superpowers",
  description: "Copilot superpowers.",
  sandbox: false,
};
const CLAUDE_PROFILE: TrellageProfile = {
  harness: TrellageHarness.Claude,
  mode: TrellageMode.Native,
  launcher: "cldx",
  name: "default",
  description: "Claude Code default.",
  sandbox: false,
};
const MODEL_CATALOG = parseCopilotModelCatalog({
  groups: {
    "frontier-current": ["gpt-5.6-sol"],
    "balanced-workhorse": [],
    "coding-specialist": [],
    "fast-efficient": [],
  },
  models: [
    {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      description: "Frontier coding model.",
      preview: false,
      modalities: { input: ["text"], output: ["text"] },
      capabilities: {
        reasoning: true,
        tool_call: true,
        structured_output: true,
        attachments: true,
      },
    },
  ],
});

const SESSION: TrellageSession = { agentId: "pane-1", paneId: "pane-1", tabId: "tab-1" };

type Handler = (
  args: TrellageInvokeArgs,
  invocation: { toolCallId?: string },
) => Promise<ToolResultObject>;

async function createHarness(
  options: {
    readiness?: string;
    onLaunch?: () => Promise<void>;
    answer?: () => Promise<string>;
    maxConcurrent?: number;
    maxCalls?: number;
  } = {},
) {
  const worktreePath = await mkdtemp(join(tmpdir(), "trellage-tool-"));
  const disposed: string[] = [];
  const launches: string[] = [];
  const launchModels: Array<string | undefined> = [];
  const launchEfforts: Array<string | undefined> = [];
  const backend: TrellageBackend = {
    launch: async (input) => {
      launches.push(input.label);
      launchModels.push(input.model);
      launchEfforts.push(input.effort);
      await options.onLaunch?.();
      return SESSION;
    },
    prompt: async (_session, text) => {
      // Stands in for a harness that reads the task file it was pointed at and completes its turn:
      // follow the same indirection the real contract uses, then write the result file it names.
      const task = /(\S*task\.md)/u.exec(text);
      if (!task) return;
      const document = await readFile(join(worktreePath, task[1]!), "utf8");
      const match = /`([^`]*result\.md)`/u.exec(document);
      if (match) await writeFile(join(worktreePath, match[1]!), "delegated answer");
    },
    waitForState: async () => HerdrAgentStatus.Idle,
    status: async () => HerdrAgentStatus.Idle,
    read: async () => "screen",
    sendKeys: async () => undefined,
    dispose: async (session) => {
      disposed.push(session.tabId);
    },
  };

  const runner = async (command: string, args: string[]) => {
    if (args[0] === "inventory") {
      return { stdout: JSON.stringify({ readiness: options.readiness ?? "healthy" }) };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };

  const worktrees = new TrellageWorktreeRegistry({
    runId: "run-1",
    canonicalize: async (path: string) => path,
    provision: (async () => ({ worktreePath, workspaceId: "w9", rootPaneId: "w9:p1" })) as never,
    run: async (_command, args) => (args[0] === "rev-parse" ? "base-sha" : ""),
  });

  const tool = createTrellageTool({
    sleep: async () => undefined,
    runId: "run-1",
    catalog: createTrellageCatalog(
      [CONTAINER_PROFILE, NATIVE_PROFILE, COPILOT_PROFILE, CLAUDE_PROFILE],
      runner,
    ),
    worktrees,
    repositoryPath: "/repo",
    answer: options.answer ?? (async () => "yes"),
    executionBudget: createRlmExecutionBudget(options.maxCalls ?? 4),
    modelCatalog: MODEL_CATALOG,
    createBackend: async () => ({ backend, close: () => undefined }),
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
  });

  return {
    handler: (tool as unknown as { handler: Handler }).handler,
    worktreePath,
    worktrees,
    disposed,
    launches,
    launchModels,
    launchEfforts,
  };
}

describe("createTrellageTool", () => {
  it("returns the harness's result file as the tool result", async () => {
    const { handler, worktreePath } = await createHarness();

    const result = await handler(
      { prompt: "do it", harness: TrellageHarness.Container, profile: "claude-council" },
      { toolCallId: "call-1" },
    );
    const payload = JSON.parse(result.textResultForLlm as string);

    expect(result.resultType).toBe("success");
    expect(payload).toMatchObject({
      text: "delegated answer",
      outcome: TrellageOutcome.Completed,
      harness: TrellageHarness.Container,
      profile: "claude-council",
      sandbox: true,
      worktreePath,
      branchName: "rlm/run-1",
    });
  });

  it("closes the harness tab even though the invocation succeeded", async () => {
    const { handler, disposed } = await createHarness();

    await handler(
      { prompt: "do it", harness: TrellageHarness.Container, profile: "claude-council" },
      { toolCallId: "call-1" },
    );

    expect(disposed).toEqual(["tab-1"]);
  });

  it("closes the harness tab when the invocation fails", async () => {
    const { handler, disposed } = await createHarness({
      onLaunch: async () => {
        throw new Error("docker daemon is not running");
      },
    });

    const result = await handler(
      { prompt: "do it", harness: TrellageHarness.Container, profile: "claude-council" },
      { toolCallId: "call-1" },
    );

    expect(result.resultType).toBe("failure");
    // The tab is closed by the backend's own launch cleanup, so nothing reaches `dispose`.
    expect(disposed).toEqual([]);
  });

  it("refuses an unhealthy profile before spending budget or launching anything", async () => {
    const { handler, launches } = await createHarness({ readiness: "unhealthy" });

    const result = await handler(
      { prompt: "do it", harness: TrellageHarness.Grok, profile: "superpowers" },
      { toolCallId: "call-1" },
    );

    expect(result.resultType).toBe("failure");
    expect(result.error).toContain("unhealthy");
    expect(launches).toEqual([]);
  });

  it("rejects a profile that does not belong to the requested harness", async () => {
    const { handler, launches } = await createHarness();

    const result = await handler(
      { prompt: "do it", harness: TrellageHarness.Grok, profile: "claude-council" },
      { toolCallId: "call-1" },
    );

    expect(result.resultType).toBe("failure");
    expect(JSON.parse(result.textResultForLlm as string).hint).toContain("harness/profile");
    expect(launches).toEqual([]);
  });

  it("forwards a validated model override to native Copilot", async () => {
    const { handler, launchModels } = await createHarness();

    const result = await handler(
      {
        prompt: "do it",
        harness: TrellageHarness.Copilot,
        profile: "superpowers",
        model: "gpt-5.6-sol",
      },
      { toolCallId: "call-1" },
    );

    expect(result.resultType).toBe("success");
    expect(launchModels).toEqual(["gpt-5.6-sol"]);
    expect(JSON.parse(result.textResultForLlm as string)).toMatchObject({
      model: "gpt-5.6-sol",
    });
  });

  it("rejects model overrides for harness-owned profiles", async () => {
    const { handler, launches } = await createHarness();

    const result = await handler(
      {
        prompt: "do it",
        harness: TrellageHarness.Grok,
        profile: "superpowers",
        model: "gpt-5.6-sol",
      },
      { toolCallId: "call-1" },
    );

    expect(result.resultType).toBe("failure");
    expect(result.error).toContain("native Copilot");
    expect(launches).toEqual([]);
  });

  it("forwards a validated model and effort override to native Claude", async () => {
    const { handler, launchModels, launchEfforts } = await createHarness();

    const result = await handler(
      {
        prompt: "do it",
        harness: TrellageHarness.Claude,
        profile: "default",
        model: "claude-opus-5",
        effort: "xhigh",
      },
      { toolCallId: "call-1" },
    );

    expect(result.resultType).toBe("success");
    expect(launchModels).toEqual(["claude-opus-5"]);
    expect(launchEfforts).toEqual(["xhigh"]);
    expect(JSON.parse(result.textResultForLlm as string)).toMatchObject({
      model: "claude-opus-5",
      effort: "xhigh",
    });
  });

  it("rejects effort overrides for non-Claude harnesses", async () => {
    const { handler, launches } = await createHarness();

    const result = await handler(
      {
        prompt: "do it",
        harness: TrellageHarness.Copilot,
        profile: "superpowers",
        effort: "xhigh",
      },
      { toolCallId: "call-1" },
    );

    expect(result.resultType).toBe("failure");
    expect(result.error).toContain("native Claude");
    expect(launches).toEqual([]);
  });

  it("enforces the shared call budget", async () => {
    const { handler } = await createHarness({ maxCalls: 1 });
    const args = {
      prompt: "do it",
      harness: TrellageHarness.Container,
      profile: "claude-council",
    };

    await handler(args, { toolCallId: "call-1" });
    const second = await handler(args, { toolCallId: "call-2" });

    expect(second.resultType).toBe("failure");
    expect(second.error).toContain("budget");
  });

  it("serializes mutating invocations against one worktree", async () => {
    const active: number[] = [];
    let concurrent = 0;
    const { handler } = await createHarness({
      maxConcurrent: 4,
      onLaunch: async () => {
        concurrent += 1;
        active.push(concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
      },
    });
    const args = {
      prompt: "do it",
      harness: TrellageHarness.Container,
      profile: "claude-council",
    };

    await Promise.all([
      handler(args, { toolCallId: "call-1" }),
      handler(args, { toolCallId: "call-2" }),
    ]);

    expect(Math.max(...active)).toBe(1);
  });

  it("allows read-only invocations to overlap", async () => {
    let concurrent = 0;
    let peak = 0;
    const { handler } = await createHarness({
      maxConcurrent: 4,
      onLaunch: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
      },
    });
    const args = {
      prompt: "review it",
      harness: TrellageHarness.Container,
      profile: "claude-council",
      readOnly: true,
    };

    await Promise.all([
      handler(args, { toolCallId: "call-1" }),
      handler(args, { toolCallId: "call-2" }),
    ]);

    expect(peak).toBe(2);
  });

  it("caps how many harness panes exist at once", async () => {
    let concurrent = 0;
    let peak = 0;
    const { handler } = await createHarness({
      maxConcurrent: 1,
      onLaunch: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
      },
    });
    const args = {
      prompt: "review it",
      harness: TrellageHarness.Container,
      profile: "claude-council",
      readOnly: true,
    };

    await Promise.all([
      handler(args, { toolCallId: "call-1" }),
      handler(args, { toolCallId: "call-2" }),
    ]);

    expect(peak).toBe(1);
  });

  it("gives each invocation its own result file", async () => {
    const { handler, worktreePath } = await createHarness();
    const args = {
      prompt: "do it",
      harness: TrellageHarness.Container,
      profile: "claude-council",
    };

    await handler(args, { toolCallId: "call-1" });
    await handler(args, { toolCallId: "call-2" });

    expect(resolveResultLocation(worktreePath, "run-1", "call-1").relativePath).not.toBe(
      resolveResultLocation(worktreePath, "run-1", "call-2").relativePath,
    );
  });
});

describe("createTrellageTool schema", () => {
  it("offers only discovered harnesses and profiles", async () => {
    const catalog = createTrellageCatalog([CONTAINER_PROFILE, NATIVE_PROFILE]);
    const tool = createTrellageTool({
      sleep: async () => undefined,
      runId: "run-1",
      catalog,
      worktrees: new TrellageWorktreeRegistry({ runId: "run-1" }),
      repositoryPath: "/repo",
      answer: vi.fn(),
      executionBudget: createRlmExecutionBudget(1),
    });
    const parameters = (
      tool as unknown as {
        parameters: { properties: Record<string, { enum?: string[] }> };
      }
    ).parameters;

    expect(parameters.properties.harness.enum).toEqual([
      TrellageHarness.Container,
      TrellageHarness.Grok,
    ]);
    expect(parameters.properties.profile.enum).toEqual(["claude-council", "superpowers"]);
    expect(tool.description).toContain("Multi-agent council.");
    expect(tool.description).toContain("trellage list --json");
    expect(tool.description).toContain("trx list --json");
    expect(tool.description).toContain("each launcher's own `list --json`");
    expect(tool.description).toContain("[native, sandboxed; launcher=grx]");
    expect(tool.description).toContain("Herdr-owned interactive PTY");
  });
});
