import type { RuntimeWorkflowPlan, WorkflowPlanTemplateId, WorkflowNodeWriteMode, WorkflowReplanPolicy } from "./types.js";
import { WorkflowGateKind, WorkflowHarnessKind, WorkflowNodeKind } from "./types.js";
import { SourceToProjectModelOperation, sourceToProjectNodeModelMetadata } from "./sourceToProject/modelPolicy.js";

export type WorkflowTemplate = {
  id: WorkflowPlanTemplateId;
  title: string;
  description: string;
  materialize: (objective: string, input?: WorkflowTemplateInput) => RuntimeWorkflowPlan;
};

export type WorkflowTemplateInput = {
  objective: string;
  source?: string;
  project?: string;
  projectPath?: string;
  mode?: "advisory" | "autonomous-pr";
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
          description: "Collect repository context, constraints, and evidence relevant to the requested implementation review.",
          model: "gpt-5.5",
          modelRationale: "Repository research uses the primary review reasoning model.",
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
          description: "Review the implementation evidence, summarize risks, and decide whether changes are needed.",
          model: "gpt-5.5",
          modelRationale: "Implementation review uses the strongest available GPT review model.",
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
          description: "Apply the needed code changes as the single writer in the workflow.",
          model: "gpt-5.3-codex",
          modelRationale: "Implementation work uses the Codex implementation tier.",
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
          description: "Run deterministic verification against the implementation contract.",
          model: "deterministic",
          modelRationale: "The verifier executes configured checks rather than an LLM call.",
          prompt: "Verify the implementation satisfies the stated objective and contract.",
          dependsOn: ["implement"],
          gates: [WorkflowGateKind.VERIFICATION],
          writeMode: "read-only" as WorkflowNodeWriteMode,
          replanPolicy: "on-verification-failure" as WorkflowReplanPolicy,
        },
        {
          id: "report",
          kind: WorkflowNodeKind.REPORT,
          harness: WorkflowHarnessKind.REPORTER,
          title: "Publish report",
          description: "Publish a deterministic summary of execution and verification results.",
          model: "deterministic",
          modelRationale: "The reporter formats recorded workflow state without a model call.",
          prompt: "Summarize the execution and verification outcome.",
          dependsOn: ["verify"],
          gates: [WorkflowGateKind.OUTPUT_CONTRACT],
          writeMode: "read-only" as WorkflowNodeWriteMode,
          replanPolicy: "never" as WorkflowReplanPolicy,
        },
      ],
    }),
  },
  "source-to-project": {
    id: "source-to-project",
    title: "Source to Project",
    description: "Read one Source artifact against one Target project and produce ranked opportunities, plans, and optional PRs.",
    materialize: makeSourceToProjectPlan,
  },
} satisfies Record<WorkflowPlanTemplateId, WorkflowTemplate>;

function makeSourceToProjectPlan(objective: string, input: WorkflowTemplateInput = { objective }): RuntimeWorkflowPlan {
  const mode = input.mode ?? "advisory";
  const advisoryNodes: RuntimeWorkflowPlan["nodes"] = [
    {
      id: "source-reading",
      kind: WorkflowNodeKind.RESEARCH,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Read source artifact",
      description: "Read the source artifact and extract grounded claims, assumptions, evidence, and transferable lessons.",
      ...sourceNodeMetadata(SourceToProjectModelOperation.SOURCE_READING),
      prompt: `Read and analyze source: ${input.source ?? ""}`,
      dependsOn: [],
      gates: [WorkflowGateKind.OUTPUT_CONTRACT],
      writeMode: "read-only" as WorkflowNodeWriteMode,
      replanPolicy: "on-contract-failure" as WorkflowReplanPolicy,
    },
    {
      id: "source-corroboration",
      kind: WorkflowNodeKind.RESEARCH,
      harness: WorkflowHarnessKind.RESEARCH,
      title: "Corroborate source claims",
      description: "Run bounded corroborating research for source claims and competing views.",
      ...sourceNodeMetadata(SourceToProjectModelOperation.SOURCE_CORROBORATION),
      prompt: "Run bounded corroborating research for the source claims.",
      dependsOn: ["source-reading"],
      gates: [WorkflowGateKind.OUTPUT_CONTRACT],
      writeMode: "read-only" as WorkflowNodeWriteMode,
      replanPolicy: "on-contract-failure" as WorkflowReplanPolicy,
    },
    {
      id: "project-research",
      kind: WorkflowNodeKind.RESEARCH,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Research target project",
      description: "Research the target project through the source lens and capture source-relevant change surfaces.",
      ...sourceNodeMetadata(SourceToProjectModelOperation.PROJECT_RESEARCH),
      prompt: `Research target project in relation to source findings: ${input.project ?? input.projectPath ?? ""}`,
      capabilities: {
        pluginCommands: [{
          plugin: "hve-core",
          command: "hve-core:task-research",
          promptInputName: "topic",
          args: { subagents: "auto" },
        }],
      },
      dependsOn: ["source-corroboration"],
      gates: [WorkflowGateKind.OUTPUT_CONTRACT],
      writeMode: "read-only" as WorkflowNodeWriteMode,
      replanPolicy: "on-contract-failure" as WorkflowReplanPolicy,
    },
    {
      id: "opportunity-mapping",
      kind: WorkflowNodeKind.PLANNING,
      harness: WorkflowHarnessKind.RESEARCH,
      title: "Map source lessons to project opportunities",
      description: "Map corroborated source lessons and project evidence into actionable opportunities and non-applicable lessons.",
      ...sourceNodeMetadata(SourceToProjectModelOperation.OPPORTUNITY_MAPPING),
      prompt: "Map source analysis and project brief into opportunities and non-applicable lessons.",
      dependsOn: ["source-reading", "source-corroboration", "project-research"],
      gates: [WorkflowGateKind.OUTPUT_CONTRACT],
      writeMode: "read-only" as WorkflowNodeWriteMode,
      replanPolicy: "on-contract-failure" as WorkflowReplanPolicy,
    },
    {
      id: "council-review",
      kind: WorkflowNodeKind.DELIBERATION,
      harness: WorkflowHarnessKind.DECISION_COUNCIL,
      title: "Rank and bundle opportunities",
      description: "Deterministically rank opportunities against source-to-project acceptance thresholds and bundle valid work.",
      ...sourceNodeMetadata(SourceToProjectModelOperation.DETERMINISTIC),
      prompt: "Review opportunities, rank them, and emit valid bundles.",
      dependsOn: ["opportunity-mapping"],
      gates: [WorkflowGateKind.REVIEW_ACCEPTED],
      writeMode: "read-only" as WorkflowNodeWriteMode,
      replanPolicy: "on-review-rejection" as WorkflowReplanPolicy,
    },
  ];

  return {
    id: `source-to-project-${objective.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "plan"}`,
    objective,
    templateId: "source-to-project",
    maxReplans: 2,
    nodes: [
      ...advisoryNodes,
    ],
  };
}

function sourceNodeMetadata(operation: SourceToProjectModelOperation) {
  return sourceToProjectNodeModelMetadata(operation);
}

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
  const input = typeof templateIdOrInput === "string" && maybeObjective && typeof maybeObjective === "object"
    ? maybeObjective
    : typeof templateIdOrInput === "object"
      ? templateIdOrInput
      : { objective: String(objective) };
  return getWorkflowTemplate(templateId).materialize(String(objective), input);
}
