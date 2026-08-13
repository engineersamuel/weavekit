import { describe, expect, it, vi } from "vitest";
import type { ProvisionedRun } from "../../../src/herdr/provision.js";
import { TrellageWorktreeRegistry } from "../../../src/rlm-poc/trellage/worktrees.js";

type RunCall = { command: string; args: string[]; cwd: string };

function createRegistry(
  overrides: {
    status?: string;
    commits?: string;
    onRun?: (call: RunCall) => void;
    removeFails?: boolean;
    provision?: () => Promise<ProvisionedRun>;
  } = {},
) {
  const calls: RunCall[] = [];
  const provision = vi.fn(
    overrides.provision ??
      (async () => ({
        worktreePath: "/worktrees/demo",
        workspaceId: "w9",
        rootPaneId: "w9:p1",
      })),
  );
  const registry = new TrellageWorktreeRegistry({
    runId: "run-1",
    provision: provision as never,
    canonicalize: async (path: string) => `/canonical${path}`,
    run: async (command, args, cwd) => {
      const call = { command, args, cwd };
      calls.push(call);
      overrides.onRun?.(call);
      if (args[0] === "rev-parse") return "base-sha\n";
      if (args[0] === "status") return overrides.status ?? "";
      if (args[0] === "rev-list") return overrides.commits ?? "0";
      if (args[0] === "worktree" && overrides.removeFails) throw new Error("worktree busy");
      return "";
    },
  });
  return { registry, calls, provision };
}

describe("TrellageWorktreeRegistry", () => {
  it("provisions one worktree per repository and reuses it", async () => {
    const { registry, provision } = createRegistry();

    const first = await registry.acquire("/repo");
    const second = await registry.acquire("/repo");

    expect(provision).toHaveBeenCalledOnce();
    expect(first).toBe(second);
    expect(first.branchName).toBe("rlm/run-1");
    expect(first.baseSha).toBe("base-sha");
  });

  it("borrows the opted-in current worktree instead of provisioning another one", async () => {
    const calls: RunCall[] = [];
    const registry = new TrellageWorktreeRegistry({
      runId: "run-1",
      currentWorktree: {
        worktreePath: "/current/worktree",
        workspaceId: "current-workspace",
      },
      provision: async () => ({
        worktreePath: "/unexpected/provisioned",
        workspaceId: "unexpected-workspace",
        rootPaneId: "unexpected-pane",
      }),
      canonicalize: async (path: string) => `/canonical${path}`,
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        if (args.join(" ") === "rev-parse HEAD") return "borrowed-base\n";
        if (args.join(" ") === "branch --show-current") return "worktree/rlm\n";
        if (args[0] === "status") return "";
        if (args[0] === "rev-list") return "0";
        if (command === "herdr") throw new Error("borrowed worktree must never be removed");
        return "";
      },
    });

    const worktree = await registry.acquire("/repo");
    const [disposition] = await registry.finalize();

    expect(worktree).toMatchObject({
      worktreePath: "/current/worktree",
      workspaceId: "current-workspace",
      repositoryPath: "/canonical/repo",
      branchName: "worktree/rlm",
      baseSha: "borrowed-base",
      reused: true,
    });
    expect(disposition).toMatchObject({ changed: false, removed: false, summary: "no changes" });
    expect(calls.some((call) => call.command === "herdr")).toBe(false);
  });

  it("shares one provisioning attempt across concurrent callers", async () => {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let finish!: (value: ProvisionedRun) => void;
    const finished = new Promise<ProvisionedRun>((resolve) => {
      finish = resolve;
    });
    const { registry, provision } = createRegistry({
      provision: () => {
        signalStarted();
        return finished;
      },
    });

    const pending = Promise.all([registry.acquire("/repo"), registry.acquire("/repo")]);
    await started;
    finish({ worktreePath: "/worktrees/demo", workspaceId: "w9", rootPaneId: "w9:p1" });
    const [first, second] = await pending;

    expect(provision).toHaveBeenCalledOnce();
    expect(first).toBe(second);
  });

  it("lets a later call retry after a failed provision", async () => {
    let attempt = 0;
    const { registry } = createRegistry({
      provision: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("herdr unavailable");
        return { worktreePath: "/worktrees/demo", workspaceId: "w9", rootPaneId: "w9:p1" };
      },
    });

    await expect(registry.acquire("/repo")).rejects.toThrow("herdr unavailable");
    await expect(registry.acquire("/repo")).resolves.toMatchObject({
      worktreePath: "/worktrees/demo",
    });
  });

  it("serializes mutating access to one repository", async () => {
    const { registry } = createRegistry();
    const order: string[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const first = registry.withExclusiveAccess("/repo", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = registry.withExclusiveAccess("/repo", async () => {
      order.push("second-start");
    });

    openGate();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("still runs queued work after the holder fails", async () => {
    const { registry } = createRegistry();

    const failing = registry.withExclusiveAccess("/repo", async () => {
      throw new Error("delegated harness crashed");
    });
    const queued = registry.withExclusiveAccess("/repo", async () => "ran anyway");

    await expect(failing).rejects.toThrow("delegated harness crashed");
    await expect(queued).resolves.toBe("ran anyway");
  });

  it("reclaims a worktree nothing touched", async () => {
    const { registry, calls } = createRegistry();
    await registry.acquire("/repo");

    const [disposition] = await registry.finalize();

    expect(disposition).toMatchObject({ changed: false, removed: true, summary: "no changes" });
    expect(calls.some((call) => call.args.join(" ").startsWith("worktree remove"))).toBe(true);
    // `herdr worktree remove` leaves the branch behind, so every run would otherwise leak a ref.
    expect(calls.some((call) => call.args.join(" ") === "branch --delete --force rlm/run-1")).toBe(
      true,
    );
  });

  it("leaves the branch alone when the worktree is kept", async () => {
    const { registry, calls } = createRegistry({ status: " M src/index.ts\n" });
    await registry.acquire("/repo");

    await registry.finalize();

    expect(calls.some((call) => call.args[0] === "branch")).toBe(false);
  });

  it("keeps a worktree that holds uncommitted work", async () => {
    const { registry, calls } = createRegistry({ status: " M src/index.ts\n?? notes.md\n" });
    await registry.acquire("/repo");

    const [disposition] = await registry.finalize();

    expect(disposition).toMatchObject({ changed: true, removed: false });
    expect(disposition!.summary).toContain("2 uncommitted file(s)");
    expect(calls.some((call) => call.args[0] === "worktree")).toBe(false);
  });

  it("keeps a worktree whose branch moved ahead of its base", async () => {
    const { registry } = createRegistry({ commits: "3" });
    await registry.acquire("/repo");

    const [disposition] = await registry.finalize();

    expect(disposition).toMatchObject({ changed: true, removed: false });
    expect(disposition!.summary).toContain("3 commit(s)");
  });

  it("keeps a worktree whose state cannot be read rather than deleting it", async () => {
    const { registry } = createRegistry({
      onRun: (call) => {
        if (call.args[0] === "status") throw new Error("not a git repository");
      },
    });
    await registry.acquire("/repo");

    const [disposition] = await registry.finalize();

    expect(disposition).toMatchObject({ changed: true, removed: false });
    expect(disposition!.summary).toContain("state unavailable");
  });

  it("reports a failed removal without throwing", async () => {
    const { registry } = createRegistry({ removeFails: true });
    await registry.acquire("/repo");

    const [disposition] = await registry.finalize();

    expect(disposition).toMatchObject({ removed: false });
    expect(disposition!.removalError).toContain("worktree busy");
  });
});
