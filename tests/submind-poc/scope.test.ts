import { describe, expect, it, vi } from "vitest";
import { ScopedHerdr, type HerdrRequester } from "../../src/submind-poc/scope.js";

describe("ScopedHerdr", () => {
  it("normalizes the installed Herdr 0.8 session snapshot envelope", async () => {
    const request = vi.fn().mockResolvedValue({
      type: "session_snapshot",
      snapshot: {
        workspaces: [
          {
            workspace_id: "workspace-run",
            worktree: { checkout_path: "/worktree" },
          },
        ],
        panes: [
          {
            pane_id: "pane-run",
            workspace_id: "workspace-run",
            cwd: "/worktree",
            agent: "copilot",
            agent_status: "idle",
            interactive_ready: true,
            name: "submind-run-1-orchestrator",
          },
          {
            pane_id: "pane-other",
            workspace_id: "workspace-other",
            agent: "codex",
            agent_status: "working",
          },
        ],
        agents: [
          {
            pane_id: "pane-run",
            workspace_id: "workspace-run",
            agent: "copilot",
            agent_status: "idle",
            interactive_ready: true,
            name: "submind-run-1-orchestrator",
          },
          {
            pane_id: "pane-other",
            workspace_id: "workspace-other",
            agent: "codex",
            agent_status: "working",
          },
        ],
      },
    });
    const scoped = new ScopedHerdr(
      { request },
      { workspaceId: "workspace-run", worktreePath: "/worktree", agentPrefix: "submind-run-1-" },
    );

    await expect(scoped.snapshot()).resolves.toMatchObject({
      workspaces: [{ id: "workspace-run", cwd: "/worktree" }],
      panes: [{ id: "pane-run", workspaceId: "workspace-run" }],
      agents: [
        {
          id: "pane-run",
          name: "submind-run-1-orchestrator",
          paneId: "pane-run",
          kind: "copilot",
          status: "idle",
          interactiveReady: true,
        },
      ],
    });
  });

  it("rejects foreign pane and agent targets", async () => {
    const request = vi.fn().mockResolvedValue({
      workspaces: [{ id: "workspace-run", cwd: "/worktree" }],
      panes: [
        { id: "pane-run", workspaceId: "workspace-run", cwd: "/worktree" },
        { id: "pane-foreign", workspaceId: "workspace-other", cwd: "/other" },
      ],
      agents: [
        { id: "agent-run", name: "submind-run-1-worker", paneId: "pane-run" },
        { id: "agent-foreign", name: "other-worker", paneId: "pane-foreign" },
      ],
    });
    const scoped = new ScopedHerdr(
      { request },
      { workspaceId: "workspace-run", worktreePath: "/worktree", agentPrefix: "submind-run-1-" },
    );

    await expect(scoped.prompt("agent-foreign", "hello")).rejects.toThrow("outside run scope");
    await expect(scoped.split("pane-foreign", "right")).rejects.toThrow("outside run scope");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("maps helper operations to socket methods after scope checks", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        workspaces: [{ id: "workspace-run", cwd: "/worktree" }],
        panes: [{ id: "pane-run", workspaceId: "workspace-run", cwd: "/worktree" }],
        agents: [{ id: "agent-run", name: "submind-run-1-worker", paneId: "pane-run" }],
      })
      .mockResolvedValueOnce({ accepted: true })
      .mockResolvedValueOnce({ accepted: true });
    const scoped = new ScopedHerdr(
      { request },
      { workspaceId: "workspace-run", worktreePath: "/worktree", agentPrefix: "submind-run-1-" },
    );

    await scoped.prompt("agent-run", "favorite color?");

    expect(request.mock.lastCall?.slice(0, 2)).toEqual([
      "agent.prompt",
      { target: "agent-run", text: "favorite color?" },
    ]);
  });

  it("submits interactive Copilot prompts with Enter", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        workspaces: [{ id: "workspace-run", cwd: "/worktree" }],
        panes: [{ id: "pane-run", workspaceId: "workspace-run", cwd: "/worktree" }],
        agents: [
          {
            id: "pane-run",
            name: "submind-run-1-copilot",
            paneId: "pane-run",
            kind: "copilot",
          },
        ],
      })
      .mockResolvedValueOnce({ accepted: true });
    const scoped = new ScopedHerdr(
      { request },
      { workspaceId: "workspace-run", worktreePath: "/worktree", agentPrefix: "submind-run-1-" },
    );

    await scoped.prompt("pane-run", "favorite color?");

    expect(request.mock.calls.slice(-2).map((call) => call.slice(0, 2))).toEqual([
      ["pane.send_input", { pane_id: "pane-run", text: "favorite color?", keys: [] }],
      ["pane.send_input", { pane_id: "pane-run", text: "", keys: ["Enter"] }],
    ]);
  });

  it("uses Herdr 0.8 request parameters for pane and agent operations", async () => {
    const snapshot = {
      workspaces: [{ id: "workspace-run", cwd: "/worktree" }],
      panes: [{ id: "pane-run", workspaceId: "workspace-run", cwd: "/worktree" }],
      agents: [{ id: "pane-run", name: "submind-run-1-worker", paneId: "pane-run", kind: "codex" }],
    };
    const requestMock = vi.fn(async (method: string) => {
      if (method === "agent.read") return { type: "pane_read", read: { text: "worker output" } };
      if (method === "tab.create") {
        return {
          type: "tab_created",
          tab: { tab_id: "tab-worker" },
          root_pane: { pane_id: "pane-worker" },
        };
      }
      return snapshot;
    });
    const request = requestMock as HerdrRequester["request"];
    const scoped = new ScopedHerdr(
      { request },
      { workspaceId: "workspace-run", worktreePath: "/worktree", agentPrefix: "submind-run-1-" },
    );

    await scoped.split("pane-run", "right");
    expect(requestMock.mock.lastCall?.slice(0, 2)).toEqual([
      "pane.split",
      { target_pane_id: "pane-run", direction: "right", focus: false },
    ]);

    await expect(scoped.createTab("submind-run-1-codex")).resolves.toEqual({
      id: "pane-worker",
      tabId: "tab-worker",
    });
    expect(requestMock.mock.lastCall?.slice(0, 2)).toEqual([
      "tab.create",
      {
        workspace_id: "workspace-run",
        cwd: "/worktree",
        label: "submind-run-1-codex",
        env: {},
        focus: false,
      },
    ]);

    await scoped.rename("pane-run", "submind-run-1-renamed");
    expect(requestMock.mock.lastCall?.slice(0, 2)).toEqual([
      "agent.rename",
      { target: "pane-run", name: "submind-run-1-renamed" },
    ]);

    await scoped.submitPendingInput("pane-run");
    expect(requestMock.mock.lastCall?.slice(0, 2)).toEqual([
      "pane.send_input",
      { pane_id: "pane-run", text: "", keys: ["Enter"] },
    ]);

    await scoped.enableCodexPlanMode("pane-run");
    expect(requestMock.mock.lastCall?.slice(0, 2)).toEqual([
      "pane.send_input",
      { pane_id: "pane-run", text: "/plan", keys: ["Enter"] },
    ]);

    await scoped.wait("pane-run", ["idle", "done"], 120_000);
    expect(requestMock.mock.lastCall?.slice(0, 2)).toEqual([
      "agent.wait",
      { target: "pane-run", until: ["idle", "done"], timeout_ms: 120_000 },
    ]);

    await scoped.read("pane-run", { lines: 120 });
    expect(requestMock.mock.lastCall?.slice(0, 2)).toEqual([
      "agent.read",
      { target: "pane-run", source: "visible", lines: 120 },
    ]);

    await scoped.launch({
      paneId: "pane-run",
      name: "submind-run-1-codex",
      command: "codx",
      args: [],
      interactive: true,
    });
    expect(requestMock.mock.lastCall?.slice(0, 2)).toEqual([
      "pane.send_input",
      { pane_id: "pane-run", text: "codx", keys: ["Enter"] },
    ]);
  });

  it("uses the Herdr pane target as the stable agent ID", async () => {
    const responses = [
      {
        workspaces: [{ id: "workspace-run", cwd: "/worktree" }],
        panes: [{ id: "pane-run", workspaceId: "workspace-run", cwd: "/worktree" }],
        agents: [],
      },
      { type: "agent_started", agent: { pane_id: "pane-run", name: "submind-run-1-copilot" } },
    ];
    const request: HerdrRequester["request"] = vi.fn(async (_method, _params, schema) =>
      schema.parse(responses.shift()),
    );
    const scoped = new ScopedHerdr(
      { request },
      { workspaceId: "workspace-run", worktreePath: "/worktree", agentPrefix: "submind-run-1-" },
    );

    await expect(
      scoped.launch({
        paneId: "pane-run",
        name: "submind-run-1-copilot",
        kind: "copilot",
        command: "copilot",
        args: ["--autopilot", "--allow-all", "--no-ask-user"],
      }),
    ).resolves.toEqual({ id: "pane-run" });
  });

  it("rejects agent start responses without a pane target", async () => {
    const responses = [
      {
        workspaces: [{ id: "workspace-run", cwd: "/worktree" }],
        panes: [{ id: "pane-run", workspaceId: "workspace-run", cwd: "/worktree" }],
        agents: [],
      },
      { type: "agent_started", agent: { name: "submind-run-1-copilot" } },
    ];
    const request: HerdrRequester["request"] = vi.fn(async (_method, _params, schema) =>
      schema.parse(responses.shift()),
    );
    const scoped = new ScopedHerdr(
      { request },
      { workspaceId: "workspace-run", worktreePath: "/worktree", agentPrefix: "submind-run-1-" },
    );

    await expect(
      scoped.launch({
        paneId: "pane-run",
        name: "submind-run-1-copilot",
        kind: "copilot",
        command: "copilot",
        args: [],
      }),
    ).rejects.toThrow("no agent ID");
  });
});
