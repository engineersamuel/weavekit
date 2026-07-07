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
import type { TemplateOptimizerWithLiveGateResult } from "../../../src/macro-workflow/templateOptimizer/liveGate.js";

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

  it("writes live gate rejection details without promoting a fixture winner", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "template-optimizer-live-artifacts-"));
    tempDirs.push(outputDir);

    await writeTemplateOptimizerArtifacts({
      outputDir,
      runId: "template-optimizer-live-test-run",
      args: {
        template: "source-to-project",
        mode: "advisory",
        iterations: 1,
        candidatesPerIteration: 1,
        judgeModel: "gpt-5.5",
        generatorModel: "gpt-5.5",
        minDecisionConfidence: 0,
        maxLiveTrials: 1,
        minLiveDelta: 0.1,
        minLiveDecisionConfidence: 0.6,
        outputRoot: "runs",
      },
      constraintsSummary: "constraints",
      fixtures: [fixture],
      result: liveRejectedResult,
    });

    const optimizerRunJson = await readFile(join(outputDir, "optimizer-run.json"), "utf8");
    const optimizerRun = JSON.parse(optimizerRunJson) as {
      status?: unknown;
      finalIncumbent?: { id?: unknown };
      liveDecision?: { incumbentScore?: unknown; challengerScore?: unknown; adoptionDecision?: unknown };
      liveRejectedMoves?: unknown[];
    };
    expect(optimizerRun.status).toBe("live-candidate-rejected");
    expect(optimizerRun.finalIncumbent?.id).toBe("checked-in-baseline");
    expect(optimizerRun.liveDecision).toMatchObject({
      incumbentScore: 8.0,
      challengerScore: 6.6,
      adoptionDecision: "keep-incumbent",
    });
    expect(optimizerRun.liveRejectedMoves?.[0]).toContain("missed static DAG coverage");

    const summary = await readFile(join(outputDir, "summary.md"), "utf8");
    expect(summary).toContain("## Live Gate");
    expect(summary).toContain("Adoption decision: keep-incumbent");
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

const liveRejectedResult: TemplateOptimizerWithLiveGateResult = {
  baseline,
  finalIncumbent: baseline,
  iterations: [],
  rejectedMoves: [],
  leaderboard: [baseline, { ...baseline, id: "source-to-project-advisory-coverage-challenger" }],
  status: "live-candidate-rejected",
  fixtureDecision: {
    candidateId: "source-to-project-advisory-coverage-challenger",
    replacementDecision: "replace-with-challenger",
    incumbentAggregateScore: 0.5,
    challengerAggregateScore: 0.7,
    scoreDelta: 0.2,
    decisionConfidence: 0.8,
  },
  liveDecision: {
    incumbentCandidateId: "checked-in-baseline",
    challengerCandidateId: "source-to-project-advisory-coverage-challenger",
    incumbentRunId: "baseline-live-run",
    challengerRunId: "challenger-live-run",
    winner: "incumbent",
    incumbentScore: 8.0,
    challengerScore: 6.6,
    scoreDelta: -1.4,
    decisionConfidence: 0.85,
    threshold: {
      minimumLiveDelta: 0.1,
      minimumLiveDecisionConfidence: 0.6,
    },
    adoptionDecision: "keep-incumbent",
    rationale: "The optimized live run missed static DAG coverage.",
    critiqueForNextChallenger: "Recover static DAG and dynamic workflow coverage.",
  },
  liveRejectedMoves: [
    "Rejected source-to-project-advisory-coverage-challenger: missed static DAG coverage",
  ],
  liveGate: {
    enabled: true,
    maxLiveTrials: 1,
    attemptedLiveTrials: 1,
    minimumLiveDelta: 0.1,
    minimumLiveDecisionConfidence: 0.6,
  },
};
