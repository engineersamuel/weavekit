import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalRepository, provisionHerdrWorktree } from "../../src/submind-poc/provision.js";
import type { SubmindRunState } from "../../src/submind-poc/contracts.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("submind Herdr provisioning", () => {
  it("rejects a missing repository", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("not a repository"));
    await expect(canonicalRepository("/missing", runner)).rejects.toThrow("Not a Git repository");
  });

  it("rejects ambiguous source workspaces matched by canonical path", async () => {
    const source = await tempDirectory();
    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args.slice(0, 2).join(" ") === "workspace list") {
        return JSON.stringify({
          result: {
            workspaces: [
              { workspace_id: "one", worktree: { repo_root: source } },
              { workspace_id: "two", worktree: { repo_root: source } },
            ],
          },
        });
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    await expect(provisionHerdrWorktree(runState(source), runner)).rejects.toThrow(
      "Multiple live Herdr workspaces",
    );
  });

  it("creates branch from HEAD and adopts it on reconciliation", async () => {
    const source = await tempDirectory();
    const checkout = await tempDirectory();
    const calls: string[][] = [];
    let created = false;
    const runner = vi.fn(async (command: string, args: string[]) => {
      calls.push(args);
      if (command === "git" && args.includes("--git-common-dir")) return source;
      if (args.slice(0, 2).join(" ") === "workspace list") {
        return JSON.stringify({
          result: { workspaces: [{ workspace_id: "parent", worktree: { repo_root: source } }] },
        });
      }
      if (args.slice(0, 2).join(" ") === "worktree list") {
        return JSON.stringify({
          result: { worktrees: created ? [{ branch: "submind/poc-run-one" }] : [] },
        });
      }
      if (args.slice(0, 2).join(" ") === "worktree create") created = true;
      if (args.slice(0, 2).join(" ").startsWith("worktree ")) {
        return JSON.stringify({
          result: {
            checkout_path: checkout,
            workspace_id: "child",
            root_pane_id: "pane-root",
            tab_id: "tab-root",
          },
        });
      }
      if (args.slice(0, 2).join(" ") === "tab rename") return "";
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    const first = await provisionHerdrWorktree(runState(source), runner);
    const second = await provisionHerdrWorktree(runState(source), runner);

    expect(first.worktreePath).toBe(await realpath(checkout));
    expect(second).toEqual(first);
    expect(calls.find((args) => args[1] === "create")).toEqual(
      expect.arrayContaining(["--branch", "submind/poc-run-one", "--base", "HEAD"]),
    );
    expect(calls.some((args) => args[1] === "open")).toBe(true);
    expect(calls.filter((args) => args.slice(0, 2).join(" ") === "tab rename")).toEqual([
      ["tab", "rename", "tab-root", "submind"],
      ["tab", "rename", "tab-root", "submind"],
    ]);
  });

  it("rejects ambiguous pane fallback candidates in the active tab", async () => {
    const source = await tempDirectory();
    const checkout = await tempDirectory();
    const runner = vi.fn(async (command: string, args: string[]) => {
      const operation = args.slice(0, 2).join(" ");
      if (operation === "workspace list") {
        return JSON.stringify({
          result: { workspaces: [{ workspace_id: "parent", worktree: { repo_root: source } }] },
        });
      }
      if (operation === "worktree list") return JSON.stringify({ result: { worktrees: [] } });
      if (operation === "worktree create") {
        return JSON.stringify({ result: { checkout_path: checkout, workspace_id: "child" } });
      }
      if (operation === "workspace get") {
        return JSON.stringify({ result: { workspace_id: "child", active_tab_id: "tab-active" } });
      }
      if (operation === "pane list") {
        return JSON.stringify({
          result: {
            panes: [
              { pane_id: "pane-one", workspace_id: "child", tab_id: "tab-active" },
              { pane_id: "pane-two", workspace_id: "child", tab_id: "tab-active" },
              { pane_id: "pane-other", workspace_id: "child", tab_id: "tab-other" },
            ],
          },
        });
      }
      if (operation === "tab rename") return "";
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    await expect(provisionHerdrWorktree(runState(source), runner)).rejects.toThrow(
      "exactly one pane in its active tab",
    );
  });

  it("adopts a unique workspace pane when active-tab metadata is absent", async () => {
    const source = await tempDirectory();
    const checkout = await tempDirectory();
    const runner = vi.fn(async (command: string, args: string[]) => {
      const operation = args.slice(0, 2).join(" ");
      if (
        ["workspace list", "workspace get", "pane list"].includes(operation) &&
        args.includes("--json")
      ) {
        throw new Error(`Unsupported --json flag: ${operation}`);
      }
      if (operation === "workspace list") {
        return JSON.stringify({
          result: { workspaces: [{ workspace_id: "parent", worktree: { repo_root: source } }] },
        });
      }
      if (operation === "worktree list") return JSON.stringify({ result: { worktrees: [] } });
      if (operation === "worktree create") {
        return JSON.stringify({ result: { checkout_path: checkout, workspace_id: "child" } });
      }
      if (operation === "workspace get") {
        return JSON.stringify({ result: { workspace_id: "child" } });
      }
      if (operation === "pane list") {
        return JSON.stringify({
          result: {
            panes: [{ pane_id: "pane-one", workspace_id: "child", tab_id: "tab-one" }],
          },
        });
      }
      if (operation === "tab rename") return "";
      if (command === "git" && args.includes("--git-common-dir")) return source;
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    await expect(provisionHerdrWorktree(runState(source), runner)).resolves.toMatchObject({
      rootPaneId: "pane-one",
    });
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "submind-provision-")));
  directories.push(directory);
  return directory;
}

function runState(sourceRepositoryPath: string): SubmindRunState {
  return {
    schemaVersion: 1,
    runId: "run-one",
    state: "provisioning",
    sourceRepositoryPath,
    branchName: "submind/poc-run-one",
    runDirectory: join(sourceRepositoryPath, ".weavekit", "submind-poc", "run-one"),
    agentPrefix: "submind-run-one-",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  };
}
