import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTemplateOptimizerCandidateDynamicExpander,
  loadTemplateOptimizerCandidatePlan,
  materializeTemplateOptimizerCandidatePlan,
} from "../../../src/macro-workflow/templateOptimizer/candidatePlan.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("template optimizer candidate plan", () => {
  it("loads a final incumbent candidate and materializes a temporary runtime plan", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "weavekit-candidate-plan-"));
    tempDirs.push(runsRoot);
    const runId = "run-123";
    await mkdir(join(runsRoot, runId), { recursive: true });
    await writeFile(join(runsRoot, runId, "optimizer-run.json"), JSON.stringify({
      finalIncumbent: {
        id: "candidate-a",
        templateId: "source-to-project",
        mode: "advisory",
        sharedInitialNodes: [
          templateNode("source-intake-preflight", "verification", "verifier", []),
          templateNode("source-reading", "research", "copilot-sdk", ["source-intake-preflight"]),
          templateNode("council-review", "deliberation", "decision-council", ["source-reading"]),
        ],
        modePolicies: [
          {
            mode: "advisory",
            enabledForOptimization: true,
            constraints: [],
            expansionCases: [
              {
                id: "single-selected-plan",
                trigger: "council-review",
                conditionSummary: "One accepted opportunity.",
                nodes: [
                  templateNode("plan-opportunity-accepted-opportunity", "planning", "research", ["council-review"]),
                  templateNode("report-opportunity-accepted-opportunity", "report", "reporter", ["plan-opportunity-accepted-opportunity"]),
                ],
                expectedPayloads: ["sourceToProjectReportMarkdown"],
                mustRunBeforeReport: true,
                rationale: "Exercise candidate expansion.",
              },
            ],
          },
        ],
        changedInitialDag: true,
        changedExpansionPolicy: true,
        requiresAutonomousPrReview: false,
        summary: "Candidate summary",
        rationale: "Candidate rationale",
        suggestedCodeTouchpoints: [],
        adoptionTasks: [],
      },
    }), "utf8");

    const candidate = await loadTemplateOptimizerCandidatePlan({ runsRoot, runId, candidateId: "candidate-a" });
    const plan = materializeTemplateOptimizerCandidatePlan({
      candidate,
      objective: "Try optimized template",
      runId,
    });

    expect(plan.id).toBe("source-to-project-optimized-run-123-candidate-a");
    expect(plan.templateId).toBe("source-to-project");
    expect(plan.nodes.map((node) => node.id)).toEqual(["visual-plan-preflight", "source-reading", "council-review"]);
    expect(plan.nodes[0]).toMatchObject({
      id: "visual-plan-preflight",
      title: "Verify visual-plan capability",
      prompt: "Verify visual-plan skill installation before source-to-project execution.",
    });
    expect(plan.nodes[1]?.dependsOn).toEqual(["visual-plan-preflight"]);
    expect(plan.nodes[2]?.dependsOn).toEqual(["source-reading"]);
  });

  it("expands council-review through the candidate advisory multiple-selected-plans case", async () => {
    const candidate = candidateFixture({
      expansionCases: [
        expansionCase("single-selected-plan", [
          templateNode("plan-opportunity-accepted-opportunity", "planning", "research", ["council-review"]),
        ]),
        expansionCase("multiple-selected-plans", [
          templateNode("plan-opportunity-branch-accepted-opportunity", "planning", "research", ["council-review"]),
          templateNode("fan-in-opportunity-selection", "deliberation", "decision-council", ["plan-opportunity-branch-accepted-opportunity"]),
          templateNode("recommended-advisory-package", "planning", "research", ["fan-in-opportunity-selection"]),
          templateNode("final-recommendation-review-multiple-opportunities", "deliberation", "decision-council", ["recommended-advisory-package"]),
          templateNode("report-multiple-opportunities", "report", "reporter", ["final-recommendation-review-multiple-opportunities"]),
          templateNode("visual-multiple-opportunity-map", "visualization", "reporter", ["report-multiple-opportunities"]),
        ]),
      ],
    });
    const expander = createTemplateOptimizerCandidateDynamicExpander({
      candidate,
      mode: "advisory",
      thresholds: {
        minApplicability: 0.7,
        minConfidence: 0.65,
        minImpact: 0.5,
        minAcceptanceAverage: 0.85,
        maxRisk: 0.8,
      },
    });

    const expanded = await expander({
      node: templateNode("council-review", "deliberation", "decision-council", []) as never,
      result: {
        nodeId: "council-review",
        status: "passed",
        output: "Council accepted multiple opportunities.",
        payload: { councilReview: councilReviewFixture(2) },
      },
      currentPlan: { id: "plan", objective: "objective", templateId: "source-to-project", maxReplans: 0, nodes: [] },
      payloads: new Map(),
      completedNodeIds: new Set(),
    });

    expect(expanded?.map((node) => node.id)).toEqual([
      "plan-opportunity-branch-accepted-opportunity",
      "fan-in-opportunity-selection",
      "recommended-advisory-package",
      "final-recommendation-review-multiple-opportunities",
      "report-multiple-opportunities",
      "visual-multiple-opportunity-map",
    ]);
    expect(expanded?.[0]?.input).toMatchObject({
      opportunityAcceptance: {
        accepted: true,
        id: "opp-1",
      },
      opportunityAcceptances: [
        { accepted: true, id: "opp-1" },
        { accepted: true, id: "opp-2" },
      ],
    });
  });
});

function candidateFixture(args: { expansionCases: unknown[] }) {
  return {
    id: "candidate-a",
    templateId: "source-to-project",
    mode: "advisory",
    sharedInitialNodes: [],
    modePolicies: [
      {
        mode: "advisory",
        enabledForOptimization: true,
        constraints: [],
        expansionCases: args.expansionCases,
      },
    ],
    changedInitialDag: true,
    changedExpansionPolicy: true,
    requiresAutonomousPrReview: false,
    summary: "Candidate summary",
    rationale: "Candidate rationale",
    suggestedCodeTouchpoints: [],
    adoptionTasks: [],
  } as never;
}

function expansionCase(id: string, nodes: unknown[]) {
  return {
    id,
    trigger: "council-review",
    conditionSummary: `${id} condition`,
    nodes,
    expectedPayloads: [],
    mustRunBeforeReport: true,
    rationale: `${id} rationale`,
  };
}

function councilReviewFixture(count: number) {
  return {
    opportunities: Array.from({ length: count }, (_, index) => ({
      id: `opp-${index + 1}`,
      title: `Opportunity ${index + 1}`,
      lesson: "Transfer loop practice.",
      projectChange: "Adapt loops to workflow DAGs.",
      changeSurface: "src",
      score: { applicability: 0.95, impact: 0.9, confidence: 0.9, implementationCost: 0.3, risk: 0.2 },
      evidence: [{ id: `e-${index + 1}`, source: "fixture" }],
      speculative: false,
    })),
    nonApplicableLessons: [],
    bundles: [],
    rankingRationale: "Fixture ranking.",
  };
}

function templateNode(
  id: string,
  kind: string,
  harness: string,
  dependsOn: string[],
) {
  return {
    id,
    kind,
    harness,
    title: id,
    description: `${id} description`,
    model: "deterministic",
    modelRationale: "fixture",
    prompt: `${id} prompt`,
    dependsOn,
    gates: ["output-contract"],
    writeMode: "read-only",
    replanPolicy: "never",
  };
}
