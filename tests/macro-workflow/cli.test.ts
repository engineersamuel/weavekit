import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowProgressReporter, formatWorkflowCliSuccessMessage, parseWorkflowCliArgs } from "../../src/cli.js";

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
      outputDir: "runs/latest",
      staticTemplate: true,
      dryRun: false,
      template: "implementation-review",
    });
  });

  it("formats a dry-run success message", () => {
    const message = formatWorkflowCliSuccessMessage({ outputDir: "runs/workflow" });
    expect(message).toContain("Macro workflow plan:");
    expect(message).toContain("runs/workflow");
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
});
