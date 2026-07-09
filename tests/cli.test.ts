#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDecisionCouncilSuccessMessage, parseDecisionCouncilCliArgs, parseEntityCliArgs, readDecisionCouncilInputFile } from "../src/cli.js";

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
  it("parses entity validate", () => {
    expect(parseEntityCliArgs(["entity", "validate"])).toEqual({ command: "validate" });
  });

  it("rejects unknown entity command", () => {
    expect(() => parseEntityCliArgs(["entity", "list"])).toThrow("Usage: weavekit entity validate");
  });

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
      maxRounds: undefined,
      smoke: false,
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
      maxRounds: undefined,
      smoke: false,
    });
  });

  it("rejects removed named selection options", () => {
    const removedFlag = `--persona${"-set"}`;
    expect(() => parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", removedFlag, "strategic"])).toThrow(
      "Static persona sets are not supported.",
    );
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

  it("--smoke defaults max rounds to one without changing persona selection mode", () => {
    const parsed = parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--smoke"]);

    expect(parsed.smoke).toBe(true);
    expect(parsed.maxRounds).toBe(1);
  });

  it("--smoke honors explicit --max-rounds overrides", () => {
    const parsed = parseDecisionCouncilCliArgs([
      "decision-council",
      "run",
      "--input",
      "x.md",
      "--smoke",
      "--max-rounds",
      "2",
    ]);

    expect(parsed.smoke).toBe(true);
    expect(parsed.maxRounds).toBe(2);
  });

  it("reports decision council run usage", () => {
    expect(() => parseDecisionCouncilCliArgs(["decision-council", "plan", "--input", "x.md"])).toThrow(
      /Usage: weavekit decision-council run/,
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

});
