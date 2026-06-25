import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDecisionCouncilSuccessMessage, parseDecisionCouncilCliArgs, readDecisionCouncilInputFile } from "../src/cli.js";

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
    });
  });

  it("parses persona set name", () => {
    const parsed = parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--persona-set", "strategic"]);

    expect(parsed.personaSetName).toBe("strategic");
  });

  it("leaves persona set name undefined when not supplied", () => {
    const parsed = parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md"]);

    expect(parsed.personaSetName).toBeUndefined();
  });

  it("rejects missing persona set value", () => {
    expect(() => parseDecisionCouncilCliArgs(["decision-council", "run", "--input", "x.md", "--persona-set"])).toThrow();
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
});
