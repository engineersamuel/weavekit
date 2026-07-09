import { describe, expect, it } from "vitest";
import { prepareAutonomousWorktree } from "../../../src/macro-workflow/sourceToProject/worktree.js";

describe("autonomous worktree preparation", () => {
  it("rebases from configured mainline and records copied env filenames", async () => {
    const commands: string[] = [];
    const result = await prepareAutonomousWorktree(
      {
        sourceWorkingTree: "/repo/weavekit",
        worktreeRoot: "/tmp/worktrees",
        branchName: "source-to-project/opp-1",
        mainline: "origin main",
      },
      {
        async run(command, args) {
          commands.push([command, ...args].join(" "));
          if (command === "git" && args[0] === "rev-parse") return "abc123\n";
          return "";
        },
        async globEnvFiles() {
          return ["/repo/weavekit/.env", "/repo/weavekit/.env.local"];
        },
        async copyFile() {},
      },
    );

    expect(commands).toContain("git pull --rebase origin main");
    expect(result.baselineCommit).toBe("abc123");
    expect(result.copiedEnvFiles).toEqual([".env", ".env.local"]);
  });

  it("fails closed when no env files can be copied", async () => {
    await expect(
      prepareAutonomousWorktree(
        {
          sourceWorkingTree: "/repo/weavekit",
          worktreeRoot: "/tmp/worktrees",
          branchName: "source-to-project/opp-1",
          mainline: "origin main",
        },
        {
          async run() {
            return "";
          },
          async globEnvFiles() {
            return [];
          },
          async copyFile() {},
        },
      ),
    ).rejects.toThrow("No .env* files found to copy");
  });
});
