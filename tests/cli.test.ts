#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDecisionCouncilSuccessMessage, formatWorkQueueBackendError, parseDecisionCouncilCliArgs, readDecisionCouncilInputFile } from "../src/cli.js";
import { WorkQueueBackendError } from "../src/work-queue/backend.js";

function runCommand(command: string, args: string[]): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

describe("CLI", () => {
  it("parses decision-council run arguments", () => {
    const parsed = parseDecisionCouncilCliArgs([
      "decision-council",
      "run",
      "--input",
      "question.md",
      "--output",
      "runs/question",
    ]);

    expect(parsed).toEqual({
      inputPath: "question.md",
      outputDir: "runs/question",
      logFormat: "pretty",
      personaSetName: undefined,
      maxRounds: undefined,
      smoke: false,
      workItemId: undefined,
      claimWorkItem: false,
      closeWorkItem: false,
      createFollowUpWorkItem: false,
      syncWorkQueue: false,
    });
  });

  it("parses JSON log format", () => {
    const parsed = parseDecisionCouncilCliArgs([
      "decision-council",
      "run",
      "--input",
      "question.md",
      "--log-format",
      "json",
    ]);

    expect(parsed).toEqual({
      inputPath: "question.md",
      outputDir: "runs/latest",
      logFormat: "json",
      personaSetName: undefined,
      maxRounds: undefined,
      smoke: false,
      workItemId: undefined,
      claimWorkItem: false,
      closeWorkItem: false,
      createFollowUpWorkItem: false,
      syncWorkQueue: false,
    });
  });

  it("parses persona set name", () => {
    const parsed = parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--persona-set", "strategic"]);

    expect(parsed.personaSetName).toBe("strategic");
  });

  it("parses the dialectic persona set name", () => {
    const parsed = parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--persona-set", "dialectic"]);

    expect(parsed.personaSetName).toBe("dialectic");
  });

  it("leaves persona set name undefined when not supplied", () => {
    const parsed = parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md"]);

    expect(parsed.personaSetName).toBeUndefined();
  });

  it("rejects missing persona set value", () => {
    expect(() => parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--persona-set"])).toThrow();
  });

  it("parses --max-rounds as a positive integer", () => {
    const parsed = parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--max-rounds", "1"]);

    expect(parsed.maxRounds).toBe(1);
  });

  it("rejects non-positive --max-rounds", () => {
    expect(() => parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--max-rounds", "0"])).toThrow();
  });

  it("rejects non-integer --max-rounds", () => {
    expect(() => parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--max-rounds", "abc"])).toThrow();
  });

  it("rejects missing --max-rounds value", () => {
    expect(() => parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--max-rounds"])).toThrow();
  });

  it("--smoke defaults to the smoke persona set and a single round", () => {
    const parsed = parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--smoke"]);

    expect(parsed.smoke).toBe(true);
    expect(parsed.personaSetName).toBe("smoke");
    expect(parsed.maxRounds).toBe(1);
  });

  it("--smoke honors explicit --persona-set and --max-rounds overrides", () => {
    const parsed = parseDecisionCouncilCliArgs([
      "decision-council",
      "run",
      "--input",
      "x.md",
      "--smoke",
      "--persona-set",
      "default",
      "--max-rounds",
      "2",
    ]);

    expect(parsed.smoke).toBe(true);
    expect(parsed.personaSetName).toBe("default");
    expect(parsed.maxRounds).toBe(2);
  });

  it("reports usage with dynamic chooser and deterministic override guidance", () => {
    expect(() => parseDecisionCouncilCliArgs(["decision-council", "plan", "--input", "x.md"])).toThrow(
      /omit --persona-set for dynamic persona selection; provide --persona-set <name> for deterministic static selection\./,
    );
  });

  it("reads Markdown input into DecisionCouncilInput", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-cli-"));
    const inputPath = join(dir, "question.md");

    try {
      await writeFile(inputPath, "# Question\n\nShould we use Flue?", "utf8");
      const input = await readDecisionCouncilInputFile(inputPath);
      expect(input.prompt).toContain("Should we use Flue?");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("formats final output with a Markdown report link", () => {
    const message = formatDecisionCouncilSuccessMessage({
      recommendation: "Use Flue for v0.",
      outputDir: "runs/example",
    });

    expect(message).toContain("Use Flue for v0.");
    expect(message).toContain("Markdown report: runs/example/DecisionCouncilReport.md");
  });

  it("starts the source CLI without loading Flue skill assets", async () => {
    const result = await runCommand("nub", ["run", "council", "decision-council"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage: weavekit decision-council run");
    expect(result.stderr).not.toContain("Unknown file extension");
    expect(result.stderr).not.toContain("SKILL.md");
  });

  it("recognizes work queue command dispatch separately from decision-council", () => {
    expect(() => parseDecisionCouncilCliArgs(["work", "ready"])).toThrow("Usage: weavekit decision-council run");
  });

  it("parses explicit work item lifecycle flags", () => {
    const parsed = parseDecisionCouncilCliArgs([
      "decision-council",
      "run",
      "--input",
      "x.md",
      "--work-item",
      "bd-root",
      "--claim-work-item",
      "--close-work-item",
      "--create-follow-up-work-item",
      "--sync-work-queue",
    ]);

    expect(parsed.workItemId).toBe("bd-root");
    expect(parsed.claimWorkItem).toBe(true);
    expect(parsed.closeWorkItem).toBe(true);
    expect(parsed.createFollowUpWorkItem).toBe(true);
    expect(parsed.syncWorkQueue).toBe(true);
  });

  it("rejects a missing work item id", () => {
    expect(() =>
      parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--work-item"]),
    ).toThrow("Missing value for --work-item <id>.");
  });

  it("rejects --claim-work-item without --work-item", () => {
    expect(() =>
      parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--claim-work-item"]),
    ).toThrow("require --work-item <id>");
  });

  it("rejects --close-work-item without --work-item", () => {
    expect(() =>
      parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--close-work-item"]),
    ).toThrow("require --work-item <id>");
  });

  it("rejects --create-follow-up-work-item without --work-item", () => {
    expect(() =>
      parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--create-follow-up-work-item"]),
    ).toThrow("require --work-item <id>");
  });

  it("rejects --sync-work-queue without --work-item", () => {
    expect(() =>
      parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--sync-work-queue"]),
    ).toThrow("require --work-item <id>");
  });

  it("accepts lifecycle flags when --work-item is provided", () => {
    const parsed = parseDecisionCouncilCliArgs([
      "decision-council", "run", "--input", "x.md",
      "--work-item", "bd-abc",
      "--claim-work-item", "--sync-work-queue",
    ]);
    expect(parsed.workItemId).toBe("bd-abc");
    expect(parsed.claimWorkItem).toBe(true);
    expect(parsed.syncWorkQueue).toBe(true);
  });
});

describe("formatWorkQueueBackendError", () => {
  it("includes exit code, stdout, and stderr from causeDetails", () => {
    const err = new WorkQueueBackendError("bd ready failed with exit code 2", {
      args: ["ready"],
      exitCode: 2,
      stdout: "some output",
      stderr: "error text",
    });

    const formatted = formatWorkQueueBackendError(err);

    expect(formatted).toContain("bd ready failed with exit code 2");
    expect(formatted).toContain("exit code: 2");
    expect(formatted).toContain("stdout: some output");
    expect(formatted).toContain("stderr: error text");
  });

  it("omits stdout/stderr lines when they are empty", () => {
    const err = new WorkQueueBackendError("bd show failed with exit code 1", {
      args: ["show", "bd-x"],
      exitCode: 1,
      stdout: "",
      stderr: "",
    });

    const formatted = formatWorkQueueBackendError(err);

    expect(formatted).toContain("bd show failed with exit code 1");
    expect(formatted).toContain("exit code: 1");
    expect(formatted).not.toContain("stdout:");
    expect(formatted).not.toContain("stderr:");
  });

  it("returns just the message when causeDetails has no numeric exitCode", () => {
    const err = new WorkQueueBackendError("bd ready returned invalid JSON", { stdout: "bad", error: new Error("x") });

    const formatted = formatWorkQueueBackendError(err);

    expect(formatted).toContain("bd ready returned invalid JSON");
    expect(formatted).not.toContain("exit code:");
  });
});
