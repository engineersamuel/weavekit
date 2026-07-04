import { materializeWorkflowPlan } from "../templates.js";
import { WorkflowGateKind, WorkflowHarnessKind, WorkflowNodeKind, type RuntimeWorkflowNode } from "../types.js";

export type TemplateMode = "advisory" | "autonomous-pr";

export type TemplateExpansionCase = {
  id: string;
  trigger: string;
  conditionSummary: string;
  nodes: RuntimeWorkflowNode[];
  expectedPayloads: string[];
  mustRunBeforeReport: boolean;
  rationale: string;
};

export type ModeTemplatePolicy = {
  mode: TemplateMode;
  enabledForOptimization: boolean;
  expansionCases: TemplateExpansionCase[];
  constraints: string[];
};

export type AdoptionTask = {
  title: string;
  kind: "template" | "expander" | "test" | "docs";
  filesLikelyTouched: string[];
  newFiles: string[];
  description: string;
  acceptanceChecks: string[];
};

export type TemplateCandidate = {
  id: string;
  templateId: "source-to-project";
  mode: TemplateMode;
  summary: string;
  sharedInitialNodes: RuntimeWorkflowNode[];
  modePolicies: ModeTemplatePolicy[];
  changedInitialDag: boolean;
  changedExpansionPolicy: boolean;
  requiresAutonomousPrReview: boolean;
  rationale: string;
  suggestedCodeTouchpoints: string[];
  adoptionTasks: AdoptionTask[];
};

export type SourceToProjectTemplateAdapter = {
  getBaselineCandidate: (mode: TemplateMode) => TemplateCandidate;
};

const BASELINE_OBJECTIVE = "Read one source artifact against one target project and produce ranked opportunities.";
const BASELINE_SOURCE = "source artifact";
const BASELINE_PROJECT = "target project";

export function createSourceToProjectTemplateAdapter(): SourceToProjectTemplateAdapter {
  return {
    getBaselineCandidate(mode) {
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
        sharedInitialNodes: plan.nodes,
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
        adoptionTasks: [],
      };
    },
  };
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
        model: "deterministic",
        modelRationale: "The reporter formats recorded workflow state without a model call.",
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
    conditionSummary: "Council review passes with at least one accepted opportunity or bundle selected for advisory planning.",
    nodes: [
      {
        id: "plan-selected-opportunities",
        kind: WorkflowNodeKind.PLANNING,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Plan selected opportunities",
        description: "Create read-only plan artifacts for selected source-to-project opportunities and bundles.",
        model: "gpt-5.5",
        modelRationale: "Plan generation uses the source-to-project planning model tier.",
        prompt: "Create plan artifacts for selected opportunities and bundles.",
        dependsOn: ["council-review"],
        gates: [WorkflowGateKind.VERIFICATION],
        writeMode: "read-only",
        replanPolicy: "on-verification-failure",
      },
      {
        id: "final-recommendation-review",
        kind: WorkflowNodeKind.DELIBERATION,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Review final recommendation",
        description: "Review selected plan artifacts for source fit, actionability, and complexity before reporting.",
        model: "gpt-5.5",
        modelRationale: "Final recommendation review uses the source-to-project review model tier.",
        prompt: "Review final recommendations.",
        dependsOn: ["plan-selected-opportunities"],
        gates: [WorkflowGateKind.REVIEW_ACCEPTED],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      {
        id: "report-source-to-project",
        kind: WorkflowNodeKind.REPORT,
        harness: WorkflowHarnessKind.REPORTER,
        title: "Report source-to-project recommendations",
        description: "Publish the final advisory source-to-project report for selected plans.",
        model: "deterministic",
        modelRationale: "The reporter formats recorded workflow state without a model call.",
        prompt: "Publish the final advisory source-to-project report.",
        dependsOn: ["final-recommendation-review"],
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
    ],
    mustRunBeforeReport: true,
    rationale: "A selected advisory plan must be planned, reviewed, and reported without introducing write-capable implementation nodes.",
  };
}
