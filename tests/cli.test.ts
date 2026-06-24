import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatCouncilSuccessMessage, parseCouncilCliArgs, readCouncilInputFile } from "../src/cli.js";

describe("CLI", () => {
  it("parses council run arguments", () => {
    const parsed = parseCouncilCliArgs([
      "council",
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
    });
  });

  it("parses JSON log format", () => {
    const parsed = parseCouncilCliArgs([
      "council",
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
    });
  });

  it("reads Markdown input into CouncilInput", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-cli-"));
    const inputPath = join(dir, "question.md");

    try {
      await writeFile(inputPath, "# Question\n\nShould we use Flue?", "utf8");
      const input = await readCouncilInputFile(inputPath);
      expect(input.prompt).toContain("Should we use Flue?");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("formats final output with a Markdown report link", () => {
    const message = formatCouncilSuccessMessage({
      recommendation: "Use Flue for v0.",
      outputDir: "runs/example",
    });

    expect(message).toContain("Use Flue for v0.");
    expect(message).toContain("Markdown report: runs/example/CouncilReport.md");
  });
});
