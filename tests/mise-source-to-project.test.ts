import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function installNubCapture(binDir: string, capturePath: string): Promise<void> {
  const nubPath = join(binDir, "nub");
  await writeFile(nubPath, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    ": > \"$CAPTURE_NUB_ARGS\"",
    "for arg in \"$@\"; do",
    "  printf '%s\\n' \"$arg\" >> \"$CAPTURE_NUB_ARGS\"",
    "done",
    "",
  ].join("\n"));
  await chmod(nubPath, 0o755);
}

async function runSourceToProjectTask(env: Record<string, string | undefined> = {}): Promise<string[]> {
  const repoRoot = process.cwd();
  const tempDir = await mkdtemp(join(tmpdir(), "weavekit-mise-source-"));
  tempDirs.push(tempDir);
  const binDir = join(tempDir, "bin");
  await mkdir(binDir);
  const capturePath = join(tempDir, "nub-args.txt");
  await installNubCapture(binDir, capturePath);

  await execFileAsync(join(repoRoot, ".mise/tasks/source-to-project"), ["Adapt https://example.com/source"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      CAPTURE_NUB_ARGS: capturePath,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  });

  return (await readFile(capturePath, "utf8")).trimEnd().split("\n");
}

describe("mise source-to-project task", () => {
  it("defines a doctor task for entity wiring validation", async () => {
    const miseConfig = await readFile(join(process.cwd(), ".mise.toml"), "utf8");

    expect(miseConfig).toContain("[tasks.doctor]");
    expect(miseConfig).toContain("Validate workflow entity manifests");
    expect(miseConfig).toContain("nub src/cli.ts entity validate");
  });

  it("defines an SDK doctor task for live skill-loading validation", async () => {
    const miseConfig = await readFile(join(process.cwd(), ".mise.toml"), "utf8");

    expect(miseConfig).toContain('[tasks."doctor:sdk"]');
    expect(miseConfig).toContain("Validate configured entity skills against a live Copilot SDK session");
    expect(miseConfig).toContain("nub scripts/entity-sdk-doctor.ts");
  });

  it("tells agents to run doctor before workflows", async () => {
    const instructions = await readFile(join(process.cwd(), "AGENTS.md"), "utf8");

    expect(instructions).toContain("mise run doctor");
    expect(instructions).toContain("before running workflow or decision-council commands");
    expect(instructions).toContain("entities/**/*.yaml");
  });

  it("targets the current checkout by default", async () => {
    const args = await runSourceToProjectTask();

    expect(args).toContain("--project-path");
    expect(args[args.indexOf("--project-path") + 1]).toBe(process.cwd());
    expect(args).not.toContain("--project");
  });
});
