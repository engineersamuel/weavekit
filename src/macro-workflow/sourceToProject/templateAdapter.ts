import type {
  AdoptionTask,
  ModeTemplatePolicy,
  TemplateCandidate,
  TemplateExpansionCase,
  WorkflowNode,
} from "../../generated/baml_client/index.js";
import { materializeWorkflowPlan } from "../templates.js";
import { WorkflowGateKind, WorkflowHarnessKind, WorkflowNodeKind, type RuntimeWorkflowNode } from "../types.js";
import { SourceToProjectModelOperation, sourceToProjectNodeModelMetadata } from "./modelPolicy.js";

export type TemplateMode = "advisory" | "autonomous-pr";

export type SourceToProjectTemplateAdapter = {
  getBaselineCandidate: (mode: TemplateMode) => TemplateCandidate;
};

const BASELINE_OBJECTIVE = "Read one source artifact against one target project and produce ranked opportunities.";
const BASELINE_SOURCE = "source artifact";
const BASELINE_PROJECT = "target project";

export function createSourceToProjectTemplateAdapter(): SourceToProjectTemplateAdapter {
  return {
    getBaselineCandidate(mode) {
      const adoptionTasks: AdoptionTask[] = [];
      const plan = materializeWorkflowPlan("source-to-project", {
        objective: BASELINE_OBJECTIVE,
        source: BASELINE_SOURCE,
        project: BASELINE_PROJECT,
        mode,
      });

      return {
        id: "checked-in-baseline",
        templateId: "source-to-project",
        mode,
        summary: `Checked-in ${plan.templateId} baseline with ${plan.nodes.length} shared initial nodes.`,
        sharedInitialNodes: plan.nodes.map(toTemplateNode),
        modePolicies: [
          advisoryModePolicy(),
          autonomousPrModePolicy(),
        ],
        changedInitialDag: false,
        changedExpansionPolicy: false,
        requiresAutonomousPrReview: false,
        rationale: [
          `Materialized from checked-in workflow plan ${plan.id}.`,
          "The candidate preserves the current source-to-project initial DAG and documents the existing advisory expansion behavior for template optimization.",
        ].join(" "),
        suggestedCodeTouchpoints: [
          "src/macro-workflow/templates.ts",
          "src/macro-workflow/sourceToProject/harnesses.ts",
          "src/macro-workflow/grammar.ts",
        ],
        adoptionTasks,
      };
    },
  };
}

function toTemplateNode(node: RuntimeWorkflowNode): WorkflowNode {
  return {
    id: node.id,
    kind: node.kind,
    harness: node.harness,
    title: node.title,
    description: node.description,
    model: node.model,
    modelRationale: node.modelRationale,
    prompt: node.prompt,
    dependsOn: node.dependsOn,
    gates: node.gates,
    writeMode: node.writeMode,
    replanPolicy: node.replanPolicy,
  };
}

function nodeModelMetadata(operation: SourceToProjectModelOperation) {
  return sourceToProjectNodeModelMetadata(operation);
}

function advisoryModePolicy(): ModeTemplatePolicy {
  return {
    mode: "advisory",
    enabledForOptimization: true,
    expansionCases: [
      noAcceptedOpportunitiesExpansionCase(),
      singleSelectedPlanExpansionCase(),
    ],
    constraints: [
      "Initial source-to-project nodes must remain read-only.",
      "Advisory expansion must publish a report without creating implementation work.",
      "All report paths must remain downstream of council-review.",
    ],
  };
}

function autonomousPrModePolicy(): ModeTemplatePolicy {
  return {
    mode: "autonomous-pr",
    enabledForOptimization: false,
    expansionCases: [],
    constraints: [
      "The checked-in static source-to-project template stops at council-review for autonomous-pr mode.",
      "Autonomous PR expansion requires explicit accepted opportunities from council-review.",
      "Autonomous PR implementation must prepare a worktree before any single-writer implementation node runs.",
      "Implementation changes require downstream verification before reporting.",
    ],
  };
}

function noAcceptedOpportunitiesExpansionCase(): TemplateExpansionCase {
  return {
    id: "no-accepted-opportunities",
    trigger: "council-review",
    conditionSummary: "Council review passes, but no opportunities satisfy the source-to-project acceptance thresholds.",
    nodes: [
      {
        id: "report-no-accepted-opportunities",
        kind: WorkflowNodeKind.REPORT,
        harness: WorkflowHarnessKind.REPORTER,
        title: "Report source-to-project result",
        description: "Publish a deterministic report explaining that no opportunities passed the acceptance gates.",
        ...nodeModelMetadata(SourceToProjectModelOperation.DETERMINISTIC),
        prompt: "Publish the final advisory report for 0 accepted opportunities.",
        dependsOn: ["council-review"],
        gates: [WorkflowGateKind.OUTPUT_CONTRACT],
        writeMode: "read-only",
        replanPolicy: "never",
      },
    ],
    expectedPayloads: [
      "acceptedOpportunityCount",
      "rejectedOpportunityCount",
      "opportunityAcceptances",
      "sourceToProjectReportMarkdown",
    ],
    mustRunBeforeReport: true,
    rationale: "A no-op advisory outcome still needs a deterministic terminal report so the run has an auditable result.",
  };
}

function singleSelectedPlanExpansionCase(): TemplateExpansionCase {
  return {
    id: "single-selected-plan",
    trigger: "council-review",
    conditionSummary: "Council review passes with at least one accepted opportunity selected for advisory planning.",
    nodes: [
      {
        id: "plan-opportunity-accepted-opportunity",
        kind: WorkflowNodeKind.PLANNING,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Plan accepted-opportunity: Accepted opportunity",
        description: "Create an implementation plan artifact for accepted opportunity accepted-opportunity.",
        ...nodeModelMetadata(SourceToProjectModelOperation.PLAN_GENERATION),
        prompt: "Create a plan artifact for accepted opportunity accepted-opportunity.",
        dependsOn: ["council-review"],
        gates: [WorkflowGateKind.VERIFICATION],
        writeMode: "read-only",
        replanPolicy: "on-verification-failure",
      },
      {
        id: "review-opportunity-accepted-opportunity",
        kind: WorkflowNodeKind.DELIBERATION,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Review accepted-opportunity: Accepted opportunity",
        description: "Review the plan for accepted opportunity accepted-opportunity against source fit, actionability, and complexity.",
        ...nodeModelMetadata(SourceToProjectModelOperation.FINAL_RECOMMENDATION_REVIEW),
        prompt: "Review the plan for accepted opportunity accepted-opportunity.",
        dependsOn: ["plan-opportunity-accepted-opportunity"],
        gates: [WorkflowGateKind.REVIEW_ACCEPTED],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        id: "report-opportunity-accepted-opportunity",
        kind: WorkflowNodeKind.REPORT,
        harness: WorkflowHarnessKind.REPORTER,
        title: "Report accepted-opportunity: Accepted opportunity",
        description: "Publish a deterministic markdown report for accepted opportunity accepted-opportunity.",
        ...nodeModelMetadata(SourceToProjectModelOperation.DETERMINISTIC),
        prompt: "Write the accepted-opportunity Accepted opportunity source-to-project report as markdown.",
        dependsOn: ["review-opportunity-accepted-opportunity"],
        gates: [WorkflowGateKind.OUTPUT_CONTRACT],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        id: "visual-design-opportunity-accepted-opportunity",
        kind: WorkflowNodeKind.VISUALIZATION,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Visual design accepted-opportunity: Accepted opportunity",
        description: "Create a visual design plan from the accepted opportunity accepted-opportunity report.",
        ...nodeModelMetadata(SourceToProjectModelOperation.VISUAL_DESIGN),
        prompt: "Create a visual design plan from the accepted-opportunity source-to-project report.",
        dependsOn: ["report-opportunity-accepted-opportunity"],
        gates: [WorkflowGateKind.OUTPUT_CONTRACT],
        writeMode: "read-only",
        replanPolicy: "never",
      },
    ],
    expectedPayloads: [
      "plans",
      "planSelection",
      "finalRecommendationReview",
      "sourceToProjectReportMarkdown",
      "visualPlanUrl",
    ],
    mustRunBeforeReport: true,
    rationale: "A selected advisory opportunity follows the checked-in fan-out shape: plan, review, report, and visual-design nodes without introducing write-capable implementation nodes.",
  };
}
