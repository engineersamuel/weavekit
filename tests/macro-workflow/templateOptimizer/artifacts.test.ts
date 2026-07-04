import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  TemplateCandidate,
  TemplateOptimizationFixture,
} from "../../../src/generated/baml_client/index.js";
import { writeTemplateOptimizerArtifacts } from "../../../src/macro-workflow/templateOptimizer/artifacts.js";
import type { TemplateOptimizerResult } from "../../../src/macro-workflow/templateOptimizer/engine.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("template optimizer artifacts", () => {
  it("writes machine-readable run output and markdown summary", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "template-optimizer-artifacts-"));
    tempDirs.push(outputDir);

    await writeTemplateOptimizerArtifacts({
      outputDir,
      runId: "template-optimizer-test-run",
      args: {
        template: "source-to-project",
        mode: "advisory",
        iterations: 1,
        candidatesPerIteration: 1,
        judgeModel: "gpt-5.5",
        generatorModel: "claude-opus-4.8",
        minDecisionConfidence: 0,
        outputRoot: "runs",
      },
      constraintsSummary: "constraints",
      fixtures: [fixture],
      result,
    });

    const optimizerRunJson = await readFile(join(outputDir, "optimizer-run.json"), "utf8");
    const optimizerRun = JSON.parse(optimizerRunJson) as {
      baselineCandidateId?: unknown;
      finalIncumbent?: unknown;
      options?: { judgeModel?: unknown; generatorModel?: unknown };
    };
    expect(optimizerRun.baselineCandidateId).toBe("checked-in-baseline");
    expect(optimizerRun.finalIncumbent).toMatchObject({ id: "checked-in-baseline" });
    expect(optimizerRun.options).toMatchObject({
      judgeModel: "gpt-5.5",
      generatorModel: "claude-opus-4.8",
    });

    const summary = await readFile(join(outputDir, "summary.md"), "utf8");
    expect(summary).toContain("# Template Optimizer Run");
    expect(summary).toContain("```mermaid");
  });
});

const baseline: TemplateCandidate = {
  id: "checked-in-baseline",
  templateId: "source-to-project",
  mode: "advisory",
  summary: "Baseline source-to-project advisory template.",
  sharedInitialNodes: [],
  modePolicies: [],
  changedInitialDag: false,
  changedExpansionPolicy: false,
  requiresAutonomousPrReview: false,
  rationale: "Keep the checked-in template.",
  suggestedCodeTouchpoints: [],
  adoptionTasks: [],
};

const fixture: TemplateOptimizationFixture = {
  id: "strong-fit",
  mode: "advisory",
  scenarioSummary: "A source-to-project run with clear advisory opportunities.",
  sourceLessons: [],
  projectConstraints: [],
  opportunities: [],
  idealFeatures: ["Specific recommendation."],
  mustPreserve: ["Advisory mode does not edit files."],
  failureModes: ["Adds implementation work."],
};

const result: TemplateOptimizerResult = {
  baseline,
  finalIncumbent: baseline,
  iterations: [],
  rejectedMoves: [],
  leaderboard: [baseline],
};
