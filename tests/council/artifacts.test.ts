import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCouncilReportMarkdown, writeCouncilArtifacts } from "../../src/council/artifacts.js";
import type { CouncilRunState } from "../../src/council/types.js";

const report = {
  recommendation: "Use Flue for v0.",
  rationale: ["It gives typed workflow steps."],
  strongestObjections: ["The API may change."],
  unresolvedQuestions: ["How stable is the Copilot SDK?"],
  confidence: 0.72,
  convergence: 0.81,
  nextExperiment: "Run one council on the Weavekit design.",
  // Sentinel: a whitespace-only string triggers the fallback renderer (trim().length === 0),
  // so these fixture tests exercise the built-in Markdown template rather than pass-through.
  finalReportMarkdown: " ",
  failedPersonas: [],
};

describe("council artifacts", () => {
  it("renders a decision-ready Markdown report", () => {
    const markdown = renderCouncilReportMarkdown(report);

    expect(markdown).toContain("# Design Council Report");
    expect(markdown).toContain("## Recommendation");
    expect(markdown).toContain("Use Flue for v0.");
    expect(markdown).toContain("## Strongest Objections");
    expect(markdown).not.toContain("Raw transcript");
  });

  it("produces distinct transcript files when a round contains duplicate personaIds", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "weavekit-artifacts-dup-"));
    const state: CouncilRunState = {
      input: { prompt: "Question", context: [], constraints: [] },
      personas: [],
      maxRounds: 1,
      rounds: [
        {
          brief: { roundNumber: 1, prompt: "Question", focus: "Initial critique" },
          rawResults: [
            {
              personaId: "socratic",
              text: "First answer",
              transcript: ["assistant: First answer"],
              metadata: { model: "gpt-5" },
            },
            {
              personaId: "socratic",
              text: "Second answer",
              transcript: ["assistant: Second answer"],
              metadata: { model: "gpt-5" },
            },
          ],
          critiques: [],
          failures: [],
          assessment: {
            roundNumber: 1,
            consensus: "Continue",
            disagreements: [],
            confidence: 0.5,
            convergence: 0.4,
            shouldContinue: false,
            diminishingReturns: false,
            nextRoundBrief: "",
          },
        },
      ],
      finalReport: report,
      stopReason: "consensus",
    };

    try {
      const artifacts = await writeCouncilArtifacts({ outputDir, state });

      expect(artifacts.debugTranscriptPaths).toHaveLength(2);
      expect(artifacts.debugTranscriptPaths[0]).not.toBe(artifacts.debugTranscriptPaths[1]);

      await expect(readFile(artifacts.debugTranscriptPaths[0]!, "utf8")).resolves.toContain("First answer");
      await expect(readFile(artifacts.debugTranscriptPaths[1]!, "utf8")).resolves.toContain("Second answer");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("writes Markdown, JSON state, and debug transcripts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "weavekit-artifacts-"));
    const state: CouncilRunState = {
      input: { prompt: "Question", context: [], constraints: [] },
      personas: [],
      maxRounds: 3,
      rounds: [
        {
          brief: { roundNumber: 1, prompt: "Question", focus: "Initial critique" },
          rawResults: [
            {
              personaId: "socratic",
              text: "Raw answer",
              transcript: ["assistant: Raw answer"],
              metadata: { model: "gpt-5" },
            },
          ],
          critiques: [],
          failures: [],
          assessment: {
            roundNumber: 1,
            consensus: "Continue",
            disagreements: [],
            confidence: 0.5,
            convergence: 0.4,
            shouldContinue: true,
            diminishingReturns: false,
            nextRoundBrief: "Focus on risks.",
          },
        },
      ],
      finalReport: report,
      stopReason: "consensus",
    };

    try {
      const artifacts = await writeCouncilArtifacts({ outputDir, state });

      await expect(readFile(artifacts.reportPath, "utf8")).resolves.toContain("Use Flue for v0.");
      await expect(readFile(artifacts.statePath, "utf8")).resolves.toContain("\"stopReason\": \"consensus\"");
      await expect(readFile(artifacts.debugTranscriptPaths[0]!, "utf8")).resolves.toContain("assistant: Raw answer");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
