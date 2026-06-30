import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowProgressReporter, createWorkflowRunDescriptor, formatWorkflowCliSuccessMessage, parseWorkflowCliArgs, runWorkflowCli } from "../../src/cli.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("macro workflow CLI", () => {
  it("parses workflow plan arguments", () => {
    const parsed = parseWorkflowCliArgs(["workflow", "plan", "--input", "question.md", "--output", "runs/workflow"]);

    expect(parsed).toEqual({
      command: "plan",
      inputPath: "question.md",
      outputDir: "runs/workflow",
      staticTemplate: false,
      dryRun: true,
    });
  });

  it("parses a workflow template override", () => {
    const parsed = parseWorkflowCliArgs(["workflow", "run", "--input", "question.md", "--template", "implementation-review"]);

    expect(parsed).toEqual({
      command: "run",
      inputPath: "question.md",
      outputDir: "runs",
      staticTemplate: true,
      dryRun: false,
      template: "implementation-review",
    });
  });

  it("parses dashboard subcommand args for a standalone viewer", () => {
    const parsed = parseWorkflowCliArgs(["workflow", "dashboard", "--port", "4321", "--watch-dir", "runs"]);

    expect(parsed).toEqual({
      command: "dashboard",
      outputDir: "runs",
      staticTemplate: false,
      dryRun: false,
      dashboardPort: 4321,
      watchDir: "runs",
    });
  });

  it("parses a run that should publish to a separate dashboard server", () => {
    const parsed = parseWorkflowCliArgs(["workflow", "run", "--input", "question.md", "--dashboard-url", "http://127.0.0.1:4321"]);

    expect(parsed).toEqual({
      command: "run",
      inputPath: "question.md",
      outputDir: "runs",
      staticTemplate: false,
      dryRun: false,
      dashboardUrl: "http://127.0.0.1:4321",
    });
  });

  it("treats dashboard-port as enabling a local run dashboard", () => {
    const parsed = parseWorkflowCliArgs(["workflow", "run", "--input", "question.md", "--dashboard-port", "4321"]);

    expect(parsed).toEqual({
      command: "run",
      inputPath: "question.md",
      outputDir: "runs",
      staticTemplate: false,
      dryRun: false,
      dashboard: true,
      dashboardPort: 4321,
    });
  });

  it("formats a dry-run success message", () => {
    const message = formatWorkflowCliSuccessMessage({ outputDir: "runs/workflow" });
    expect(message).toContain("Macro workflow plan:");
    expect(message).toContain("runs/workflow");
  });

  it("creates a friendly run descriptor under the output root", () => {
    const descriptor = createWorkflowRunDescriptor("runs/latest", "ship replay dashboard follow mode");

    expect(descriptor.outputDir).toMatch(/^runs\/[0-9a-f-]+$/);
    expect(descriptor.runName).toBe("Ship Replay Dashboard Follow Mode");
  });

  it("emits progress updates while a long-running workflow action is in flight", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const reporter = createWorkflowProgressReporter({
      write(chunk: string | Uint8Array) {
        writes.push(String(chunk));
        return true;
      },
    } as NodeJS.WritableStream);

    reporter.start("Planning workflow DAG", 10);
    vi.advanceTimersByTime(10);
    reporter.stop();

    expect(writes[0]).toContain("Planning workflow DAG");
    expect(writes.some((message) => message.includes("still working"))).toBe(true);
  });

  it("writes state and replay artifacts for a plain static workflow run", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-cli-"));
    const inputPath = join(rootDir, "question.md");
    const outputRoot = join(rootDir, "runs");
    await writeFile(inputPath, "Ship replay dashboard follow mode", "utf8");

    try {
      await runWorkflowCli({
        command: "run",
        inputPath,
        outputDir: outputRoot,
        staticTemplate: true,
        dryRun: false,
        template: "implementation-review",
      });

      const runDirs = await readdir(outputRoot);
      expect(runDirs).toHaveLength(1);
      const outputDir = join(outputRoot, runDirs[0]!);
      const state = await readFile(join(outputDir, "workflow-state.json"), "utf8");
      const events = await readFile(join(outputDir, "workflow-events.jsonl"), "utf8");

      expect(state).toContain("\"status\": \"passed\"");
      expect(state).toContain("\"runName\": \"Ship Replay Dashboard Follow Mode\"");
      expect(events).toContain("\"kind\":\"planning-started\"");
      expect(events).toContain("\"kind\":\"run-completed\"");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
