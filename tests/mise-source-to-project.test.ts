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

async function installCommandCapture(binDir: string, capturePath: string, command: "nub" | "nubx"): Promise<void> {
  const commandPath = join(binDir, command);
  await writeFile(commandPath, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    ": > \"$CAPTURE_NUB_ARGS\"",
    `printf '%s\\n' '${command}' >> "$CAPTURE_NUB_ARGS"`,
    "for arg in \"$@\"; do",
    "  printf '%s\\n' \"$arg\" >> \"$CAPTURE_NUB_ARGS\"",
    "done",
    "",
  ].join("\n"));
  await chmod(commandPath, 0o755);
}

async function runSourceToProjectTask(env: Record<string, string | undefined> = {}): Promise<string[]> {
  const repoRoot = process.cwd();
  const tempDir = await mkdtemp(join(tmpdir(), "weavekit-mise-source-"));
  tempDirs.push(tempDir);
  const binDir = join(tempDir, "bin");
  await mkdir(binDir);
  const capturePath = join(tempDir, "nub-args.txt");
  await installCommandCapture(binDir, capturePath, "nub");
  await installCommandCapture(binDir, capturePath, "nubx");

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

async function runMiseTaskScript(scriptPath: string, args: string[], env: Record<string, string | undefined> = {}): Promise<string[]> {
  const repoRoot = process.cwd();
  const tempDir = await mkdtemp(join(tmpdir(), "weavekit-mise-task-"));
  tempDirs.push(tempDir);
  const binDir = join(tempDir, "bin");
  await mkdir(binDir);
  const capturePath = join(tempDir, "nub-args.txt");
  await installCommandCapture(binDir, capturePath, "nub");

  await execFileAsync(join(repoRoot, scriptPath), args, {
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

  it("targets the configured weavekit project by default", async () => {
    const args = await runSourceToProjectTask();

    expect(args).toContain("--project");
    expect(args[args.indexOf("--project") + 1]).toBe("weavekit");
    expect(args).not.toContain("--project-path");
  });

  it("runs the default source-to-project task with an embedded Portless dashboard", async () => {
    const args = await runSourceToProjectTask();

    expect(args.slice(0, 7)).toEqual([
      "nubx",
      "portless",
      "run",
      "--name",
      "weavekit-source-to-project",
      "nub",
      "src/cli.ts",
    ]);
    expect(args).toContain("--dashboard");
    expect(args).not.toContain("--dashboard-url");
  });

  it("publishes source-to-project runs to an explicit dashboard URL when configured", async () => {
    const args = await runSourceToProjectTask({
      WEAVEKIT_DASHBOARD_URL: "https://calm-meadow.weavekit-dashboard.localhost",
    });

    expect(args.slice(0, 4)).toEqual(["nub", "src/cli.ts", "workflow", "run"]);
    expect(args).toContain("--dashboard-url");
    expect(args[args.indexOf("--dashboard-url") + 1]).toBe("https://calm-meadow.weavekit-dashboard.localhost");
    expect(args).not.toContain("--dashboard");
    expect(args).not.toContain("portless");
  });

  it("omits source-to-project dashboard flags when dashboards are disabled", async () => {
    const args = await runSourceToProjectTask({ WEAVEKIT_DASHBOARD: "off" });

    expect(args.slice(0, 4)).toEqual(["nub", "src/cli.ts", "workflow", "run"]);
    expect(args).not.toContain("--dashboard");
    expect(args).not.toContain("--dashboard-url");
    expect(args).not.toContain("portless");
  });

  it("starts the standalone dashboard through Portless without a hard-coded port", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const miseConfig = await readFile(join(process.cwd(), ".mise.toml"), "utf8");

    expect(packageJson.scripts?.dashboard).toBe("nubx portless run --name weavekit-dashboard nub src/cli.ts workflow dashboard --watch-dir runs");
    expect(miseConfig).toContain("nubx portless run --name weavekit-dashboard nub src/cli.ts workflow dashboard");
    expect(miseConfig).toContain("--watch-dir runs");
    expect(miseConfig).not.toContain("--port 4321");
  });

  it("defines template optimizer tasks", async () => {
    const miseConfig = await readFile(join(process.cwd(), ".mise.toml"), "utf8");

    expect(miseConfig).toContain('[tasks."optimize-template"]');
    expect(miseConfig).toContain('[tasks."optimize-template:apply"]');
    expect(miseConfig).toContain(".mise/tasks/optimize-template");
    expect(miseConfig).toContain(".mise/tasks/optimize-template-apply");
  });

  it("routes optimize-template through the TypeScript optimizer script", async () => {
    const args = await runMiseTaskScript(".mise/tasks/optimize-template", ["--template", "source-to-project", "--mode", "advisory"]);

    expect(args).toEqual([
      "nub",
      "scripts/optimize-template.ts",
      "--template",
      "source-to-project",
      "--mode",
      "advisory",
    ]);
  });

  it("routes optimize-template apply through the TypeScript apply script", async () => {
    const args = await runMiseTaskScript(".mise/tasks/optimize-template-apply", ["run-123", "--dry-run"]);

    expect(args).toEqual([
      "nub",
      "scripts/optimize-template-apply.ts",
      "run-123",
      "--dry-run",
    ]);
  });
});
