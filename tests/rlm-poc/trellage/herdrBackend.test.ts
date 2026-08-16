import { describe, expect, it, vi } from "vitest";
import type { ScopedHerdr } from "../../../src/herdr/scope.js";
import { createHerdrTrellageBackend } from "../../../src/rlm-poc/trellage/herdrBackend.js";
import { TrellageHarness, TrellageMode } from "../../../src/rlm-poc/trellage/contracts.js";

describe("createHerdrTrellageBackend", () => {
  it("waits for the renamed agent name to appear before launch resolves", async () => {
    let snapshotStep = 0;
    let renameCalls = 0;
    const scoped = {
      createTab: vi.fn(async () => ({ id: "pane-run", tabId: "tab-run" })),
      launch: vi.fn(async () => ({})),
      rename: vi.fn(async () => {
        renameCalls += 1;
      }),
      closeTab: vi.fn(async () => undefined),
      sendKeys: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => {
        snapshotStep += 1;
        if (snapshotStep === 1) {
          return {
            workspaces: [{ id: "workspace-run" }],
            panes: [{ id: "pane-run", workspaceId: "workspace-run" }],
            agents: [],
          };
        }
        if (snapshotStep <= 3) {
          return {
            workspaces: [{ id: "workspace-run" }],
            panes: [{ id: "pane-run", workspaceId: "workspace-run" }],
            agents: [{ id: "pane-run", paneId: "pane-run", name: "grok", kind: "grok" }],
          };
        }
        return {
          workspaces: [{ id: "workspace-run" }],
          panes: [{ id: "pane-run", workspaceId: "workspace-run" }],
          agents: [{ id: "pane-run", paneId: "pane-run", name: "rlm-run-1-grok", kind: "grok" }],
        };
      }),
    } as unknown as ScopedHerdr;

    const backend = createHerdrTrellageBackend(scoped, {
      adoptionTimeoutMs: 5_000,
      sleep: async () => undefined,
    });

    await expect(
      backend.launch({
        cwd: "/worktree",
        label: "rlm-run-1-grok",
        profile: {
          harness: TrellageHarness.Grok,
          name: "hve",
          launcher: "grx",
          mode: TrellageMode.Native,
          description: "test",
          sandbox: true,
        },
      }),
    ).resolves.toMatchObject({ agentId: "pane-run", paneId: "pane-run", tabId: "tab-run" });

    expect(renameCalls).toBe(1);
    expect(snapshotStep).toBe(4);
  });

  it("waits for the harness itself, not just the launcher Herdr adopted", async () => {
    // `cpx` runs a memory-import step before Copilot starts, and Herdr reports a `copilot`/`idle`
    // agent for that whole window. Prompting there types the task into the launcher, so launch must
    // hold until Herdr stops answering agent-targeted input with `agent_not_ready`.
    let sendKeysCalls = 0;
    const scoped = {
      createTab: vi.fn(async () => ({ id: "pane-run", tabId: "tab-run" })),
      launch: vi.fn(async () => ({})),
      rename: vi.fn(async () => undefined),
      closeTab: vi.fn(async () => undefined),
      sendKeys: vi.fn(async (_agentId: string, keys: string[]) => {
        expect(keys).toEqual([]);
        sendKeysCalls += 1;
        if (sendKeysCalls < 3) {
          throw new Error("agent_not_ready: agent pane-run is not an active named agent");
        }
      }),
      snapshot: vi.fn(async () => ({
        workspaces: [{ id: "workspace-run" }],
        panes: [{ id: "pane-run", workspaceId: "workspace-run" }],
        agents: [
          { id: "pane-run", paneId: "pane-run", name: "rlm-run-1-copilot", kind: "copilot" },
        ],
      })),
    } as unknown as ScopedHerdr;

    const backend = createHerdrTrellageBackend(scoped, {
      adoptionTimeoutMs: 5_000,
      sleep: async () => undefined,
    });

    await expect(
      backend.launch({
        cwd: "/worktree",
        label: "rlm-run-1-copilot",
        profile: {
          harness: TrellageHarness.Copilot,
          name: "hve",
          launcher: "cpx",
          mode: TrellageMode.Native,
          description: "test",
          sandbox: true,
        },
      }),
    ).resolves.toMatchObject({ agentId: "pane-run", kind: "copilot" });

    expect(sendKeysCalls).toBe(5);
  });

  it("does not trust the brief readiness window that follows the rename", async () => {
    // `agent.rename` makes the agent pass Herdr's "active named agent" check for ~200ms before the
    // next detection sweep takes it back. A single accepted probe there would certify the launcher,
    // not the harness, so readiness must hold across consecutive probes.
    const accepted: boolean[] = [true, false, true, true, true];
    let sendKeysCalls = 0;
    const scoped = {
      createTab: vi.fn(async () => ({ id: "pane-run", tabId: "tab-run" })),
      launch: vi.fn(async () => ({})),
      rename: vi.fn(async () => undefined),
      closeTab: vi.fn(async () => undefined),
      sendKeys: vi.fn(async () => {
        const ok = accepted[sendKeysCalls] ?? true;
        sendKeysCalls += 1;
        if (!ok) throw new Error("agent_not_ready: agent pane-run is not an active named agent");
      }),
      snapshot: vi.fn(async () => ({
        workspaces: [{ id: "workspace-run" }],
        panes: [{ id: "pane-run", workspaceId: "workspace-run" }],
        agents: [
          { id: "pane-run", paneId: "pane-run", name: "rlm-run-1-copilot", kind: "copilot" },
        ],
      })),
    } as unknown as ScopedHerdr;

    const backend = createHerdrTrellageBackend(scoped, {
      adoptionTimeoutMs: 5_000,
      sleep: async () => undefined,
    });

    await expect(
      backend.launch({
        cwd: "/worktree",
        label: "rlm-run-1-copilot",
        profile: {
          harness: TrellageHarness.Copilot,
          name: "hve",
          launcher: "cpx",
          mode: TrellageMode.Native,
          description: "test",
          sandbox: true,
        },
      }),
    ).resolves.toMatchObject({ agentId: "pane-run" });

    expect(sendKeysCalls).toBe(5);
  });

  it("fails launch when the harness never accepts input", async () => {
    const scoped = {
      createTab: vi.fn(async () => ({ id: "pane-run", tabId: "tab-run" })),
      launch: vi.fn(async () => ({})),
      rename: vi.fn(async () => undefined),
      closeTab: vi.fn(async () => undefined),
      sendKeys: vi.fn(async () => {
        throw new Error("agent_not_ready: agent pane-run is not an active named agent");
      }),
      snapshot: vi.fn(async () => ({
        workspaces: [{ id: "workspace-run" }],
        panes: [{ id: "pane-run", workspaceId: "workspace-run" }],
        agents: [
          { id: "pane-run", paneId: "pane-run", name: "rlm-run-1-copilot", kind: "copilot" },
        ],
      })),
    } as unknown as ScopedHerdr;

    const backend = createHerdrTrellageBackend(scoped, {
      adoptionTimeoutMs: 5,
      sleep: async () => undefined,
    });

    await expect(
      backend.launch({
        cwd: "/worktree",
        label: "rlm-run-1-copilot",
        profile: {
          harness: TrellageHarness.Copilot,
          name: "hve",
          launcher: "cpx",
          mode: TrellageMode.Native,
          description: "test",
          sandbox: true,
        },
      }),
    ).rejects.toThrow("to accept input");
    expect(scoped.closeTab).toHaveBeenCalledWith("tab-run");
  });
});
