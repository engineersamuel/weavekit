import type { RuntimeWorkflowPlan, WorkflowPlanTemplateId, WorkflowNodeWriteMode, WorkflowReplanPolicy } from "./types.js";
import { WorkflowGateKind, WorkflowHarnessKind, WorkflowNodeKind } from "./types.js";

export type WorkflowTemplate = {
  id: WorkflowPlanTemplateId;
  title: string;
  description: string;
  materialize: (objective: string) => RuntimeWorkflowPlan;
};

export type WorkflowTemplateInput = {
  objective: string;
};

const templates = {
  "implementation-review": {
    id: "implementation-review",
    title: "Implementation Review",
    description: "A deterministic workflow that gathers context, reviews implementation, and verifies the result.",
    materialize: (objective: string): RuntimeWorkflowPlan => ({
      id: `implementation-review-${objective.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "plan"}`,
      objective,
      templateId: "implementation-review",
      maxReplans: 2,
      nodes: [
        {
          id: "research",
          kind: WorkflowNodeKind.RESEARCH,
          harness: WorkflowHarnessKind.RESEARCH,
          title: "Research repository context",
          prompt: "Inspect repository context and implementation details relevant to the objective.",
          dependsOn: [],
          gates: [WorkflowGateKind.OUTPUT_CONTRACT],
          writeMode: "read-only" as WorkflowNodeWriteMode,
          replanPolicy: "on-contract-failure" as WorkflowReplanPolicy,
        },
        {
          id: "council",
          kind: WorkflowNodeKind.DELIBERATION,
          harness: WorkflowHarnessKind.DECISION_COUNCIL,
          title: "Review implementation",
          prompt: "Review the available implementation evidence and identify gaps or risks.",
          dependsOn: ["research"],
          gates: [WorkflowGateKind.REVIEW_ACCEPTED],
          writeMode: "read-only" as WorkflowNodeWriteMode,
          replanPolicy: "on-review-rejection" as WorkflowReplanPolicy,
        },
        {
          id: "implement",
          kind: WorkflowNodeKind.IMPLEMENTATION,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Implement fixes",
          prompt: "Apply the necessary implementation changes to address the objective.",
          dependsOn: ["council"],
          gates: [WorkflowGateKind.VERIFICATION],
          writeMode: "single-writer" as WorkflowNodeWriteMode,
          replanPolicy: "on-verification-failure" as WorkflowReplanPolicy,
        },
        {
          id: "verify",
          kind: WorkflowNodeKind.VERIFICATION,
          harness: WorkflowHarnessKind.VERIFIER,
          title: "Verify result",
          prompt: "Verify the implementation satisfies the stated objective and contract.",
          dependsOn: ["implement"],
          gates: [WorkflowGateKind.VERIFICATION],
          writeMode: "read-only" as WorkflowNodeWriteMode,
          replanPolicy: "on-verification-failure" as WorkflowReplanPolicy,
        },
        {
          id: "report",
          kind: WorkflowNodeKind.VISUALIZATION,
          harness: WorkflowHarnessKind.REPORTER,
          title: "Publish report",
          prompt: "Summarize the execution and verification outcome.",
          dependsOn: ["verify"],
          gates: [WorkflowGateKind.OUTPUT_CONTRACT],
          writeMode: "read-only" as WorkflowNodeWriteMode,
          replanPolicy: "never" as WorkflowReplanPolicy,
        },
      ],
    }),
  },
} satisfies Record<WorkflowPlanTemplateId, WorkflowTemplate>;

export function listWorkflowTemplates(): WorkflowTemplate[] {
  return Object.values(templates);
}

export function getWorkflowTemplate(id: WorkflowPlanTemplateId): WorkflowTemplate {
  const template = templates[id];
  if (!template) {
    throw new Error(`Unknown workflow template: ${id}`);
  }
  return template;
}

export function materializeWorkflowPlan(
  templateIdOrInput: WorkflowPlanTemplateId | WorkflowTemplateInput,
  maybeObjective?: string | WorkflowTemplateInput,
): RuntimeWorkflowPlan {
  const templateId = typeof templateIdOrInput === "string" ? templateIdOrInput : "implementation-review";
  const objective = typeof templateIdOrInput === "string"
    ? typeof maybeObjective === "string"
      ? maybeObjective
      : maybeObjective && typeof maybeObjective === "object" && "objective" in maybeObjective
        ? String(maybeObjective.objective)
        : ""
    : templateIdOrInput.objective;
  return getWorkflowTemplate(templateId).materialize(String(objective));
}
