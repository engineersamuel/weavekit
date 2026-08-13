import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("mise rlm task", () => {
  it("enables Trellage while borrowing the current isolated worktree", async () => {
    const { stdout } = await execFileAsync("mise", ["task", "info", "rlm", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const task = JSON.parse(stdout) as { env?: string[]; run?: string[] };

    expect(task.run).toEqual(["nub scripts/rlm-poc.ts --trellage --reuse-current-worktree -p"]);
    expect(task.env).toContain("COPILOT_HOME={{config_root}}/.weavekit/copilot-home");
  });
});
