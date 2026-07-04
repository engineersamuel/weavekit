import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  TemplateCandidate,
  TemplateOptimizationFixture,
  WorkflowNode,
} from "../../generated/baml_client/index.js";
import type { TemplateOptimizerResult } from "./engine.js";

export type TemplateOptimizerArtifactsArgsSnapshot = {
  template?: string;
  mode?: "advisory" | "autonomous-pr";
  iterations: number;
  candidatesPerIteration: number;
  judgeModel: string;
  generatorModel: string;
  minDecisionConfidence: number;
  outputRoot: string;
};

export type TemplateOptimizerRunArtifact = {
  status: "keep-current-template" | "candidate-ready";
  note: string;
  runId?: string;
  templateId?: string;
  mode?: "advisory" | "autonomous-pr";
  options: {
    iterations: number;
    candidatesPerIteration: number;
    judgeModel: string;
    generatorModel: string;
    minDecisionConfidence: number;
  };
  effectiveModels: {
    judge: string;
    generator: string;
  };
  constraintsSummary: string;
  fixtures: Array<{
    id: string;
    mode: TemplateOptimizationFixture["mode"];
    scenarioSummary: string;
  }>;
  fixtureIds: string[];
  baselineCandidateId: string;
  baseline: TemplateCandidate;
  baselineRecommendation: {
    candidateId: string;
    summary: string;
  };
  finalIncumbent: TemplateCandidate;
  leaderboardIds: string[];
  rejectedMoves: string[];
  iterations: Array<{
    index: number;
    candidateIndex: number;
    strategy: string;
    challengerId: string;
    replacedIncumbent: boolean;
    aggregateJudgment: TemplateOptimizerResult["iterations"][number]["aggregateJudgment"];
    fixtureJudgments: TemplateOptimizerResult["iterations"][number]["fixtureJudgments"];
    fixtureJudgmentIds: string[];
  }>;
  finalRecommendation: {
    candidateId: string;
    recommendation: "keep-current-template" | "adopt-candidate";
    rationale: string;
  };
  generatedAt: string;
};

export async function writeTemplateOptimizerArtifacts(args: {
  outputDir: string;
  runId?: string;
  args: TemplateOptimizerArtifactsArgsSnapshot;
  result: TemplateOptimizerResult;
  constraintsSummary: string;
  fixtures: TemplateOptimizationFixture[];
}): Promise<TemplateOptimizerRunArtifact> {
  await mkdir(args.outputDir, { recursive: true });
  const payload = buildTemplateOptimizerRunArtifact(args);
  await writeFile(
    join(args.outputDir, "optimizer-run.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(args.outputDir, "summary.md"), renderTemplateOptimizerSummary(payload), "utf8");
  return payload;
}

function buildTemplateOptimizerRunArtifact(args: {
  runId?: string;
  args: TemplateOptimizerArtifactsArgsSnapshot;
  result: TemplateOptimizerResult;
  constraintsSummary: string;
  fixtures: TemplateOptimizationFixture[];
}): TemplateOptimizerRunArtifact {
  const recommendation =
    args.result.finalIncumbent.id === args.result.baseline.id
      ? "keep-current-template"
      : "adopt-candidate";
  return {
    status: recommendation === "keep-current-template" ? "keep-current-template" : "candidate-ready",
    note: "Template optimizer completed with live BAML candidate generation and judging.",
    runId: args.runId,
    templateId: args.args.template,
    mode: args.args.mode,
    options: {
      iterations: args.args.iterations,
      candidatesPerIteration: args.args.candidatesPerIteration,
      judgeModel: args.args.judgeModel,
      generatorModel: args.args.generatorModel,
      minDecisionConfidence: args.args.minDecisionConfidence,
    },
    effectiveModels: {
      judge: args.args.judgeModel,
      generator: args.args.generatorModel,
    },
    constraintsSummary: args.constraintsSummary,
    fixtures: args.fixtures.map((fixture) => ({
      id: fixture.id,
      mode: fixture.mode,
      scenarioSummary: fixture.scenarioSummary,
    })),
    fixtureIds: args.fixtures.map((fixture) => fixture.id),
    baselineCandidateId: args.result.baseline.id,
    baseline: args.result.baseline,
    baselineRecommendation: {
      candidateId: args.result.baseline.id,
      summary: args.result.baseline.summary,
    },
    finalIncumbent: args.result.finalIncumbent,
    leaderboardIds: args.result.leaderboard.map((candidate) => candidate.id),
    rejectedMoves: args.result.rejectedMoves,
    iterations: args.result.iterations.map((iteration) => ({
      index: iteration.index,
      candidateIndex: iteration.candidateIndex,
      strategy: iteration.strategy,
      challengerId: iteration.challenger.id,
      replacedIncumbent: iteration.replacedIncumbent,
      aggregateJudgment: iteration.aggregateJudgment,
      fixtureJudgments: iteration.fixtureJudgments,
      fixtureJudgmentIds: iteration.fixtureJudgments.map((judgment) => judgment.fixtureId),
    })),
    finalRecommendation: {
      candidateId: args.result.finalIncumbent.id,
      recommendation,
      rationale: renderFinalRecommendationRationale(args.result),
    },
    generatedAt: new Date().toISOString(),
  };
}

function renderTemplateOptimizerSummary(run: TemplateOptimizerRunArtifact): string {
  return [
    "# Template Optimizer Run",
    "",
    `- Run: ${run.runId ?? "not recorded"}`,
    `- Template: ${run.templateId ?? "unknown"}`,
    `- Mode: ${run.mode ?? "unknown"}`,
    `- Status: ${run.status}`,
    `- Judge model: ${run.effectiveModels.judge}`,
    `- Generator model: ${run.effectiveModels.generator}`,
    `- Fixtures: ${renderInlineList(run.fixtureIds)}`,
    `- Leaderboard: ${renderInlineList(run.leaderboardIds, "none")}`,
    "",
    run.note,
    "",
    "## Final Recommendation",
    "",
    `- Candidate: ${run.finalRecommendation.candidateId}`,
    `- Recommendation: ${run.finalRecommendation.recommendation}`,
    `- Rationale: ${run.finalRecommendation.rationale}`,
    "",
    "## Fixture List",
    "",
    ...renderFixtureList(run.fixtures),
    "",
    "## Iteration Summary",
    "",
    ...renderIterationSummary(run.iterations),
    "",
    "## Rejected Moves",
    "",
    ...renderRejectedMoves(run.rejectedMoves),
    "",
    "## Shared Initial DAG",
    "",
    "```mermaid",
    renderSharedInitialNodesMermaid(run.finalIncumbent.sharedInitialNodes),
    "```",
    "",
  ].join("\n");
}

function renderFinalRecommendationRationale(result: TemplateOptimizerResult): string {
  if (result.finalIncumbent.id === result.baseline.id) {
    return result.rejectedMoves.length > 0
      ? `The checked-in baseline remains incumbent after ${result.rejectedMoves.length} rejected move(s).`
      : "The checked-in baseline remains incumbent.";
  }
  return result.finalIncumbent.rationale;
}

function renderFixtureList(
  fixtures: TemplateOptimizerRunArtifact["fixtures"],
): string[] {
  if (fixtures.length === 0) {
    return ["No fixtures recorded."];
  }
  return fixtures.map(
    (fixture) => `- ${fixture.id} (${fixture.mode}): ${fixture.scenarioSummary}`,
  );
}

function renderIterationSummary(
  iterations: TemplateOptimizerRunArtifact["iterations"],
): string[] {
  if (iterations.length === 0) {
    return ["No iterations ran."];
  }
  return iterations.map((iteration) => {
    const decision = iteration.replacedIncumbent ? "replaced incumbent" : "kept incumbent";
    const delta = iteration.aggregateJudgment.scoreDelta.toFixed(3);
    return `- ${iteration.index}.${iteration.candidateIndex} ${iteration.challengerId} (${iteration.strategy}): ${decision}, score delta ${delta}, confidence ${iteration.aggregateJudgment.decisionConfidence}`;
  });
}

function renderRejectedMoves(rejectedMoves: string[]): string[] {
  if (rejectedMoves.length === 0) {
    return ["No rejected moves recorded."];
  }
  return rejectedMoves.map((move) => `- ${move}`);
}

function renderSharedInitialNodesMermaid(nodes: WorkflowNode[]): string {
  if (nodes.length === 0) {
    return "flowchart TD\n  empty[No shared initial nodes recorded]";
  }

  const nodeIds = new Map(nodes.map((node, index) => [node.id, `node_${index}`]));
  const lines = ["flowchart TD"];
  for (const node of nodes) {
    const mermaidId = nodeIds.get(node.id)!;
    lines.push(`  ${mermaidId}["${escapeMermaidLabel(`${node.title} (${node.kind})`)}"]`);
  }
  for (const node of nodes) {
    const mermaidId = nodeIds.get(node.id)!;
    for (const dependency of node.dependsOn) {
      const dependencyId = nodeIds.get(dependency) ?? sanitizeMermaidId(dependency);
      lines.push(`  ${dependencyId} --> ${mermaidId}`);
    }
  }
  return lines.join("\n");
}

function renderInlineList(values: string[], emptyValue = "none"): string {
  return values.length > 0 ? values.join(", ") : emptyValue;
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/["\n\r]/g, " ");
}

function sanitizeMermaidId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}
