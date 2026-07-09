import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runApply } from "../scripts/optimize-template-apply.js";

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

async function installAppendCommandCapture(binDir: string, command: "nub" | "nubx"): Promise<void> {
  const commandPath = join(binDir, command);
  await writeFile(commandPath, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf 'CALL\\n' >> \"$CAPTURE_NUB_ARGS\"",
    `printf '%s\\n' '${command}' >> "$CAPTURE_NUB_ARGS"`,
    "for arg in \"$@\"; do",
    "  printf '%s\\n' \"$arg\" >> \"$CAPTURE_NUB_ARGS\"",
    "done",
    "printf 'END\\n' >> \"$CAPTURE_NUB_ARGS\"",
    "",
  ].join("\n"));
  await chmod(commandPath, 0o755);
}

async function installSourceToProjectOptimizeNubCapture(
  binDir: string,
  _capturePath: string,
): Promise<void> {
  const nubPath = join(binDir, "nub");
  await writeFile(nubPath, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "printf 'CALL\\n' >> \"$CAPTURE_NUB_ARGS\"",
    "for arg in \"$@\"; do",
    "  printf '%s\\n' \"$arg\" >> \"$CAPTURE_NUB_ARGS\"",
    "done",
    "printf 'END\\n' >> \"$CAPTURE_NUB_ARGS\"",
    "if [[ \"${1:-}\" == \"scripts/optimize-template.ts\" ]]; then",
    "  run_dir=\"evals/template-optimizer/runs/run-123\"",
    "  mkdir -p \"$run_dir\"",
    "  printf '# Summary\\n' > \"$run_dir/summary.md\"",
    "  printf '# Apply\\n' > \"$run_dir/apply-dry-run.md\"",
    "  printf '{}\\n' > \"$run_dir/optimizer-run.json\"",
    "  printf '[weavekit] Template optimizer run: run-123\\n'",
    "  printf '[weavekit] Output: %s\\n' \"$run_dir\"",
    "elif [[ \"${1:-}\" == \"scripts/optimize-template-apply.ts\" ]]; then",
    "  printf '[weavekit] Template optimizer dry-run summary: evals/template-optimizer/runs/%s/apply-dry-run.md\\n' \"${2:-unknown}\"",
    "fi",
    "",
  ].join("\n"));
  await chmod(nubPath, 0o755);
}

async function installOpenCapture(binDir: string, _capturePath: string): Promise<void> {
  const openPath = join(binDir, "open");
  await writeFile(openPath, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    ": > \"$CAPTURE_OPEN_ARGS\"",
    "for arg in \"$@\"; do",
    "  printf '%s\\n' \"$arg\" >> \"$CAPTURE_OPEN_ARGS\"",
    "done",
    "",
  ].join("\n"));
  await chmod(openPath, 0o755);
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

async function runSourceToProjectTaskInFreshWorktree(): Promise<string[][]> {
  const repoRoot = process.cwd();
  const tempDir = await mkdtemp(join(tmpdir(), "weavekit-fresh-worktree-"));
  tempDirs.push(tempDir);
  const binDir = join(tempDir, "bin");
  await mkdir(binDir);
  const capturePath = join(tempDir, "nub-calls.txt");
  await installAppendCommandCapture(binDir, "nub");
  await installAppendCommandCapture(binDir, "nubx");

  await execFileAsync(join(repoRoot, ".mise/tasks/source-to-project"), ["Adapt https://example.com/source"], {
    cwd: tempDir,
    env: {
      ...process.env,
      CAPTURE_NUB_ARGS: capturePath,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  });

  return parseCapturedCalls(await readFile(capturePath, "utf8"));
}

async function runVerificationOptimizerTask(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stderr: string; capturedArgs: string[] }> {
  const repoRoot = process.cwd();
  const tempDir = await mkdtemp(join(tmpdir(), "weavekit-mise-verification-"));
  tempDirs.push(tempDir);
  const binDir = join(tempDir, "bin");
  await mkdir(binDir);
  const capturePath = join(tempDir, "nub-args.txt");
  await installCommandCapture(binDir, capturePath, "nub");
  await installCommandCapture(binDir, capturePath, "nubx");

  try {
    const result = await execFileAsync(join(repoRoot, ".mise/tasks/verification-optimizer"), args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
        CAPTURE_NUB_ARGS: capturePath,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
    const capturedArgs = (await readFile(capturePath, "utf8")).trimEnd().split("\n");
    return { code: 0, stderr: result.stderr, capturedArgs };
  } catch (error) {
    const err = error as { code?: number; stderr?: string };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stderr: err.stderr ?? "",
      capturedArgs: [],
    };
  }
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

function parseCapturedCalls(text: string): string[][] {
  const calls: string[][] = [];
  let current: string[] | undefined;
  for (const line of text.trimEnd().split("\n")) {
    if (line === "CALL") {
      current = [];
      continue;
    }
    if (line === "END") {
      if (current) {
        calls.push(current);
      }
      current = undefined;
      continue;
    }
    current?.push(line);
  }
  return calls;
}

async function runSourceToProjectOptimizeTask(args: string[] = []): Promise<{
  nubCalls: string[][];
  openArgs: string[];
}> {
  const repoRoot = process.cwd();
  const tempDir = await mkdtemp(join(tmpdir(), "weavekit-source-optimize-"));
  tempDirs.push(tempDir);
  const binDir = join(tempDir, "bin");
  await mkdir(binDir);
  const captureNubPath = join(tempDir, "nub-args.txt");
  const captureOpenPath = join(tempDir, "open-args.txt");
  await installSourceToProjectOptimizeNubCapture(binDir, captureNubPath);
  await installOpenCapture(binDir, captureOpenPath);

  await execFileAsync(join(repoRoot, ".mise/tasks/source-to-project-optimize-template"), args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAPTURE_NUB_ARGS: captureNubPath,
      CAPTURE_OPEN_ARGS: captureOpenPath,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  });

  return {
    nubCalls: parseCapturedCalls(await readFile(captureNubPath, "utf8")),
    openArgs: (await readFile(captureOpenPath, "utf8")).trimEnd().split("\n"),
  };
}

async function runSourceToProjectOptimizeOpenTask(runId: string): Promise<string[]> {
  const repoRoot = process.cwd();
  const tempDir = await mkdtemp(join(tmpdir(), "weavekit-source-optimize-open-"));
  tempDirs.push(tempDir);
  const binDir = join(tempDir, "bin");
  await mkdir(binDir);
  const captureOpenPath = join(tempDir, "open-args.txt");
  await installOpenCapture(binDir, captureOpenPath);

  await execFileAsync(join(repoRoot, ".mise/tasks/source-to-project-optimize-template-open"), [runId], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAPTURE_OPEN_ARGS: captureOpenPath,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  });

  return (await readFile(captureOpenPath, "utf8")).trimEnd().split("\n");
}

async function createOptimizerRunFixture(): Promise<{ runsRoot: string; runId: string; runDir: string }> {
  const runsRoot = await mkdtemp(join(tmpdir(), "weavekit-template-runs-"));
  tempDirs.push(runsRoot);
  const runId = "run-123";
  const runDir = join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "optimizer-run.json"),
    JSON.stringify({
      finalIncumbent: {
        id: "candidate-a",
        adoptionTasks: [
          {
            title: "Update source-to-project template",
            kind: "template",
            filesLikelyTouched: ["src/macro-workflow/templates.ts"],
            newFiles: [],
            description: "Apply the selected template improvements.",
            acceptanceChecks: ["typecheck passes"],
          },
        ],
      },
    }),
    "utf8",
  );
  return { runsRoot, runId, runDir };
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

  it("bootstraps dependencies before source-to-project runs in a fresh worktree", async () => {
    const calls = await runSourceToProjectTaskInFreshWorktree();

    expect(calls[0]).toEqual(["nub", "install", "--prefer-frozen-lockfile"]);
    expect(calls[1].slice(0, 7)).toEqual([
      "nubx",
      "portless",
      "run",
      "--name",
      "weavekit-source-to-project",
      "nub",
      "src/cli.ts",
    ]);
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

  it("defines a verification-optimizer task", async () => {
    const miseConfig = await readFile(join(process.cwd(), ".mise.toml"), "utf8");

    expect(miseConfig).toContain('[tasks."verification-optimizer"]');
    expect(miseConfig).toContain("Run verification-optimizer for a required project");
    expect(miseConfig).toContain(".mise/tasks/verification-optimizer");
  });

  it("requires a project for the verification-optimizer task", async () => {
    const result = await runVerificationOptimizerTask([]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: mise run verification-optimizer -- --project <id> [--mode advisory|autonomous-pr]");
  });

  it("runs verification-optimizer in advisory mode by default and suggests autonomous PR mode", async () => {
    const result = await runVerificationOptimizerTask(["--project", "weavekit"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Advisory mode selected. To let verification-optimizer implement one accepted improvement, rerun with --mode autonomous-pr.");
    expect(result.capturedArgs.slice(0, 4)).toEqual(["nub", "src/cli.ts", "workflow", "run"]);
    expect(result.capturedArgs).toContain("--template");
    expect(result.capturedArgs[result.capturedArgs.indexOf("--template") + 1]).toBe("verification-optimizer");
    expect(result.capturedArgs).toContain("--project");
    expect(result.capturedArgs[result.capturedArgs.indexOf("--project") + 1]).toBe("weavekit");
    expect(result.capturedArgs).toContain("--mode");
    expect(result.capturedArgs[result.capturedArgs.indexOf("--mode") + 1]).toBe("advisory");
  });

  it("passes autonomous PR mode through for the verification-optimizer task without the advisory hint", async () => {
    const result = await runVerificationOptimizerTask(["--project", "weavekit", "--mode", "autonomous-pr"]);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("Advisory mode selected");
    expect(result.capturedArgs).toContain("--mode");
    expect(result.capturedArgs[result.capturedArgs.indexOf("--mode") + 1]).toBe("autonomous-pr");
  });

  it("defines template optimizer tasks", async () => {
    const miseConfig = await readFile(join(process.cwd(), ".mise.toml"), "utf8");

    expect(miseConfig).toContain('[tasks."optimize-template"]');
    expect(miseConfig).toContain('[tasks."optimize-template:apply"]');
    expect(miseConfig).toContain('[tasks."source-to-project:optimize-template"]');
    expect(miseConfig).toContain('[tasks."source-to-project:optimize-template:open"]');
    expect(miseConfig).toContain('[tasks."source-to-project:optimize-template:ui"]');
    expect(miseConfig).toContain('[tasks."source-to-project:try-optimized-template"]');
    expect(miseConfig).toContain(".mise/tasks/optimize-template");
    expect(miseConfig).toContain(".mise/tasks/optimize-template-apply");
    expect(miseConfig).toContain(".mise/tasks/source-to-project-optimize-template");
    expect(miseConfig).toContain(".mise/tasks/source-to-project-optimize-template-open");
    expect(miseConfig).toContain(".mise/tasks/source-to-project-optimize-template-ui");
    expect(miseConfig).toContain(".mise/tasks/source-to-project-try-optimized-template");
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

  it("runs source-to-project template optimization, dry-run apply, and opens artifacts", async () => {
    const result = await runSourceToProjectOptimizeTask();

    expect(result.nubCalls).toEqual([
      [
        "scripts/optimize-template.ts",
        "--template",
        "source-to-project",
        "--mode",
        "advisory",
        "--iterations",
        "1",
        "--candidates-per-iteration",
        "1",
      ],
      ["scripts/optimize-template-apply.ts", "run-123", "--dry-run"],
    ]);
    expect(result.openArgs).toEqual([
      "evals/template-optimizer/runs/run-123/summary.md",
      "evals/template-optimizer/runs/run-123/apply-dry-run.md",
    ]);
  });

  it("opens source-to-project template optimizer artifacts for an existing run", async () => {
    const runDir = join("evals", "template-optimizer", "runs", "run-123");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "summary.md"), "# Summary\n", "utf8");
    await writeFile(join(runDir, "apply-dry-run.md"), "# Apply\n", "utf8");

    const openArgs = await runSourceToProjectOptimizeOpenTask("run-123");

    expect(openArgs).toEqual([
      "evals/template-optimizer/runs/run-123/summary.md",
      "evals/template-optimizer/runs/run-123/apply-dry-run.md",
    ]);
  });

  it("routes source-to-project template optimizer UI through the TypeScript UI script", async () => {
    const args = await runMiseTaskScript(".mise/tasks/source-to-project-optimize-template-ui", ["--port", "4323"]);

    expect(args).toEqual([
      "nub",
      "scripts/source-to-project-template-optimizer-ui.ts",
      "--port",
      "4323",
    ]);
  });

  it("routes source-to-project optimized-template trial through the TypeScript trial script", async () => {
    const args = await runMiseTaskScript(".mise/tasks/source-to-project-try-optimized-template", [
      "run-123",
      "--candidate",
      "candidate-a",
      "--",
      "Adapt https://example.com/source",
    ]);

    expect(args).toEqual([
      "nub",
      "scripts/source-to-project-try-optimized-template.ts",
      "run-123",
      "--candidate",
      "candidate-a",
      "--",
      "Adapt https://example.com/source",
    ]);
  });

  it("does not write an apply summary before failing live apply", async () => {
    const { runsRoot, runId, runDir } = await createOptimizerRunFixture();

    await expect(runApply({ runsRoot, runId, dryRun: false })).rejects.toThrow("live repository modification is not implemented");
    await expect(access(join(runDir, "apply-summary.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes an apply dry-run summary", async () => {
    const { runsRoot, runId, runDir } = await createOptimizerRunFixture();

    const result = await runApply({ runsRoot, runId, dryRun: true });

    expect(result).toEqual({ summaryPath: join(runDir, "apply-dry-run.md"), dryRun: true });
    await expect(readFile(join(runDir, "apply-dry-run.md"), "utf8")).resolves.toContain("Dry run only. No repository files were modified.");
  });
});
