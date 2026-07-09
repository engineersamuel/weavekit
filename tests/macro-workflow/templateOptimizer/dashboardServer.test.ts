import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTemplateOptimizerDashboardServer,
  listTemplateOptimizerDashboardRuns,
  type TemplateOptimizerDashboardServer,
} from "../../../src/macro-workflow/templateOptimizer/dashboardServer.js";
import type { TemplateOptimizerRunArtifact } from "../../../src/macro-workflow/templateOptimizer/artifacts.js";

const tempDirs: string[] = [];
const servers: TemplateOptimizerDashboardServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("template optimizer dashboard server", () => {
  it("lists optimizer runs newest first with comparison metrics", async () => {
    const runsRoot = await createRunsRoot();
    await writeOptimizerRunFixture(runsRoot, {
      runId: "run-old",
      generatedAt: "2026-07-04T12:00:00.000Z",
      status: "keep-current-template",
      scoreDelta: -0.125,
      rejectedMoves: ["candidate regressed source corroboration"],
    });
    await writeOptimizerRunFixture(runsRoot, {
      runId: "run-new",
      generatedAt: "2026-07-04T13:00:00.000Z",
      status: "candidate-ready",
      scoreDelta: 0.35,
      rejectedMoves: [],
    });

    const runs = await listTemplateOptimizerDashboardRuns(runsRoot);

    expect(runs.map((run) => run.runId)).toEqual(["run-new", "run-old"]);
    expect(runs[0]).toMatchObject({
      runId: "run-new",
      templateId: "source-to-project",
      status: "candidate-ready",
      finalRecommendation: "adopt-candidate",
      finalCandidateId: "candidate-run-new",
      iterationCount: 1,
      scoreDelta: 0.35,
      criticalRegressionCount: 0,
    });
    expect(runs[1]?.criticalRegressionCount).toBe(1);
  });

  it("serves the run browser, selected run detail, and safe artifacts", async () => {
    const runsRoot = await createRunsRoot();
    await writeOptimizerRunFixture(runsRoot, {
      runId: "run-123",
      generatedAt: "2026-07-04T14:00:00.000Z",
      status: "candidate-ready",
      scoreDelta: 0.42,
      rejectedMoves: [],
    });
    const server = await createTemplateOptimizerDashboardServer({ runsRoot });
    servers.push(server);

    const htmlResponse = await fetch(server.url);
    const html = await htmlResponse.text();
    const bundleResponse = await fetch(new URL("/dist/main.js", server.url));
    const bundle = await bundleResponse.text();
    const stylesResponse = await fetch(new URL("/styles.css", server.url));
    const reactFlowCssResponse = await fetch(
      new URL("/node_modules/@xyflow/react/dist/style.css", server.url),
    );
    const runsResponse = await fetch(new URL("/api/runs", server.url));
    const runsPayload = await runsResponse.json();
    const runResponse = await fetch(new URL("/api/run?runId=run-123", server.url));
    const runPayload = await runResponse.json();
    const summaryResponse = await fetch(
      new URL("/api/artifact?runId=run-123&file=summary.md", server.url),
    );
    const summary = await summaryResponse.text();
    const traversalResponse = await fetch(
      new URL("/api/artifact?runId=run-123&file=../optimizer-run.json", server.url),
    );

    expect(htmlResponse.status).toBe(200);
    expect(html).toContain("Source-to-project template optimizer");
    expect(html).toContain("/node_modules/@xyflow/react/dist/style.css");
    expect(html).toContain("/dist/main.js");
    expect(bundleResponse.status).toBe(200);
    expect(bundle).toContain("ReactFlow");
    expect(bundle).toContain("elk.algorithm");
    expect(bundle).toContain("Before / After Template");
    expect(bundle).toContain("Proposed Graph Inspector");
    expect(bundle).toContain("Why This Is Better");
    expect(bundle).toContain("Candidate Scores");
    expect(bundle).toContain("HITL Apply Path");
    expect(stylesResponse.status).toBe(200);
    expect(reactFlowCssResponse.status).toBe(200);
    expect(runsPayload.latestRunId).toBe("run-123");
    expect(runsPayload.runs[0]).toMatchObject({ runId: "run-123", scoreDelta: 0.42 });
    expect(runPayload.run.runId).toBe("run-123");
    expect(runPayload.baselineGraph.nodes.map((node: { id: string }) => node.id)).toEqual([
      "source-intake",
      "project-fit",
      "advisory:implementation-expansion:implementation-plan",
    ]);
    expect(runPayload.candidateComparisons).toEqual([
      {
        id: "baseline",
        role: "baseline",
        summary: "Existing static DAG.",
        recommendation: "current-template",
      },
      {
        id: "candidate-run-123",
        role: "challenger",
        strategy: "fixture-guided",
        scoreDelta: 0.42,
        decisionConfidence: 0.82,
        replacedIncumbent: true,
        criticalRegressionCount: 0,
      },
      {
        id: "candidate-run-123",
        role: "final-incumbent",
        summary: "candidate-run-123 summary",
        recommendation: "adopt-candidate",
      },
    ]);
    expect(runPayload.finalGraph.nodes.map((node: { id: string }) => node.id)).toEqual([
      "source-intake",
      "project-fit",
      "advisory:implementation-expansion:implementation-plan",
    ]);
    expect(runPayload.finalGraph.edges).toContainEqual({
      from: "project-fit",
      to: "advisory:implementation-expansion:implementation-plan",
    });
    expect(runPayload.graphComparison).toMatchObject({
      baseline: {
        totalNodes: 3,
        sharedInitialNodes: 2,
        expansionNodes: 1,
        edges: 2,
        expansionCases: 1,
      },
      proposed: {
        totalNodes: 3,
        sharedInitialNodes: 2,
        expansionNodes: 1,
        edges: 2,
        expansionCases: 1,
      },
      addedNodes: [],
      removedNodes: [],
    });
    expect(runPayload.summaryMarkdown).toContain("# Summary run-123");
    expect(runPayload.applyDryRunMarkdown).toContain("# Apply run-123");
    expect(summaryResponse.status).toBe(200);
    expect(summaryResponse.headers.get("content-type")).toContain("text/markdown");
    expect(summary).toContain("# Summary run-123");
    expect(traversalResponse.status).toBe(404);
  });
});

async function createRunsRoot(): Promise<string> {
  const runsRoot = await mkdtemp(join(tmpdir(), "template-optimizer-dashboard-"));
  tempDirs.push(runsRoot);
  return runsRoot;
}

async function writeOptimizerRunFixture(
  runsRoot: string,
  options: {
    runId: string;
    generatedAt: string;
    status: TemplateOptimizerRunArtifact["status"];
    scoreDelta: number;
    rejectedMoves: string[];
  },
) {
  const runDir = join(runsRoot, options.runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "optimizer-run.json"),
    `${JSON.stringify(createRunArtifact(options), null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(runDir, "summary.md"), `# Summary ${options.runId}\n`, "utf8");
  await writeFile(join(runDir, "apply-dry-run.md"), `# Apply ${options.runId}\n`, "utf8");
}

function createRunArtifact(options: {
  runId: string;
  generatedAt: string;
  status: TemplateOptimizerRunArtifact["status"];
  scoreDelta: number;
  rejectedMoves: string[];
}): TemplateOptimizerRunArtifact {
  return {
    runId: options.runId,
    templateId: "source-to-project",
    mode: "advisory",
    status: options.status,
    note: "Fixture optimizer run.",
    options: {
      iterations: 1,
      candidatesPerIteration: 1,
      judgeModel: "gpt-5.4",
      generatorModel: "gpt-5.4",
      minDecisionConfidence: 0.6,
    },
    effectiveModels: {
      judge: "gpt-5.4",
      generator: "gpt-5.4",
    },
    constraintsSummary: "Preserve source-to-project semantics.",
    fixtures: [
      {
        id: "fixture-a",
        mode: "advisory",
        scenarioSummary: "Adapt a source into a target project.",
      },
    ],
    fixtureIds: ["fixture-a"],
    baselineCandidateId: "baseline",
    baseline: createCandidate("baseline"),
    baselineRecommendation: {
      candidateId: "baseline",
      summary: "Existing static DAG.",
    },
    finalIncumbent: createCandidate(`candidate-${options.runId}`),
    leaderboardIds: [`candidate-${options.runId}`, "baseline"],
    rejectedMoves: options.rejectedMoves,
    liveRejectedMoves: [],
    iterations: [
      {
        index: 1,
        candidateIndex: 1,
        strategy: "fixture-guided",
        challengerId: `candidate-${options.runId}`,
        replacedIncumbent: options.status === "candidate-ready",
        aggregateJudgment: {
          incumbentId: "baseline",
          challengerId: `candidate-${options.runId}`,
          incumbentAggregateScore: 0.5,
          challengerAggregateScore: 0.5 + options.scoreDelta,
          scoreDelta: options.scoreDelta,
          criticalRegressionCount: options.rejectedMoves.length,
          replacementDecision:
            options.status === "candidate-ready" ? "replace-with-challenger" : "keep-incumbent",
          rationale: "The challenger improves fixture coverage.",
          rejectedMoveSummary: options.rejectedMoves.join("; ") || undefined,
          decisionConfidence: 0.82,
        },
        fixtureJudgments: [
          {
            fixtureId: "fixture-a",
            incumbentScore: 0.5,
            challengerScore: 0.5 + options.scoreDelta,
            criteriaScores: [
              {
                criterion: "Coverage",
                score: 0.82,
                rationale: "Better plan shape.",
              },
            ],
            criticalRegression: options.rejectedMoves.length > 0,
            criticalRegressionReason: options.rejectedMoves[0],
            winner: "challenger",
            rationale: "Better plan shape.",
            critiqueForNextChallenger: "Preserve all existing checks.",
            fixtureGapNotes: [],
            decisionConfidence: 0.82,
          },
        ],
        fixtureJudgmentIds: ["fixture-a"],
      },
    ],
    finalRecommendation: {
      candidateId: `candidate-${options.runId}`,
      recommendation:
        options.status === "candidate-ready" ? "adopt-candidate" : "keep-current-template",
      rationale: "Fixture recommendation.",
    },
    generatedAt: options.generatedAt,
  };
}

function createCandidate(id: string): TemplateOptimizerRunArtifact["finalIncumbent"] {
  return {
    id,
    templateId: "source-to-project",
    mode: "advisory",
    summary: `${id} summary`,
    sharedInitialNodes: [
      {
        id: "source-intake",
        kind: "research",
        harness: "research",
        title: "Source Intake",
        description: "Understand the source material.",
        model: "gpt-5.4",
        modelRationale: "Fixture model.",
        prompt: "Review the source.",
        dependsOn: [],
        gates: [],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        id: "project-fit",
        kind: "design",
        harness: "architect",
        title: "Project Fit",
        description: "Map source ideas to the target project.",
        model: "gpt-5.4",
        modelRationale: "Fixture model.",
        prompt: "Map source to project.",
        dependsOn: ["source-intake"],
        gates: [],
        writeMode: "read-only",
        replanPolicy: "never",
      },
    ],
    modePolicies: [
      {
        mode: "advisory",
        enabledForOptimization: true,
        constraints: ["Run after project fit is known."],
        expansionCases: [
          {
            id: "implementation-expansion",
            trigger: "project-fit",
            conditionSummary: "The source contains implementation patterns worth adapting.",
            nodes: [
              {
                id: "implementation-plan",
                kind: "design",
                harness: "architect",
                title: "Implementation Plan",
                description: "Plan project-specific implementation work.",
                model: "gpt-5.4",
                modelRationale: "Fixture model.",
                prompt: "Plan the implementation.",
                dependsOn: ["project-fit"],
                gates: [],
                writeMode: "read-only",
                replanPolicy: "never",
              },
            ],
            expectedPayloads: ["implementationPlan"],
            mustRunBeforeReport: true,
            rationale: "The final template needs an expansion path.",
          },
        ],
      },
    ],
    changedInitialDag: id !== "baseline",
    changedExpansionPolicy: false,
    requiresAutonomousPrReview: false,
    rationale: `${id} rationale`,
    suggestedCodeTouchpoints: ["src/macro-workflow/templates.ts"],
    adoptionTasks: [
      {
        title: "Update source-to-project template",
        kind: "template",
        filesLikelyTouched: ["src/macro-workflow/templates.ts"],
        newFiles: [],
        description: "Apply the selected static DAG improvements.",
        acceptanceChecks: ["typecheck passes"],
      },
    ],
  };
}
