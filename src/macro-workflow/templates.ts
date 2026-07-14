import type { DeepResearchProvider } from "../config.js";
import type {
  RuntimeWorkflowPlan,
  WorkflowPlanTemplateId,
  WorkflowNodeWriteMode,
  WorkflowReplanPolicy,
} from "./types.js";
import { WorkflowGateKind, WorkflowHarnessKind, WorkflowNodeKind } from "./types.js";
import {
  SourceToProjectModelOperation,
  sourceToProjectNodeModelMetadata,
} from "./sourceToProject/modelPolicy.js";

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
  providers?: DeepResearchProvider[];
  maxIterations?: number;
  questionsPerIteration?: number;
  maxResultsPerQuestion?: number;
  providerRetryAttempts?: number;
  visualize?: boolean;
  externalResearch?: boolean;
  deepResearchRunId?: string;
};

const templates = {
  "implementation-review": {
    id: "implementation-review",
    title: "Implementation Review",
    description:
      "A deterministic workflow that gathers context, reviews implementation, and verifies the result.",
    materialize: (objective: string): RuntimeWorkflowPlan => ({
      id: workflowPlanId("implementation-review", objective),
      objective,
      templateId: "implementation-review",
      maxReplans: 2,
      nodes: [
        {
          id: "research",
          kind: WorkflowNodeKind.RESEARCH,
          harness: WorkflowHarnessKind.RESEARCH,
          title: "Research repository context",
          description:
            "Collect repository context, constraints, and evidence relevant to the requested implementation review.",
          model: "gpt-5.5",
          modelRationale: "Repository research uses the primary review reasoning model.",
          prompt:
            "Inspect repository context and implementation details relevant to the objective.",
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
          description:
            "Review the implementation evidence, summarize risks, and decide whether changes are needed.",
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
    description:
      "Read one Source artifact against one Target project and produce ranked opportunities, plans, and optional PRs.",
    materialize: makeSourceToProjectPlan,
  },
  router: {
    id: "router",
    title: "Router",
    description:
      "Classify any prompt into a recommended next action with route-specific prompt rewrites and handoff guidance.",
    materialize: makeRouterPlan,
  },
  "verification-optimizer": {
    id: "verification-optimizer",
    title: "Verification Optimizer",
    description:
      "Audit one project and implement a strict high-confidence verification-only improvement.",
    materialize: makeVerificationOptimizerPlan,
  },
  "x-article-summary": {
    id: "x-article-summary",
    title: "X Article Summary",
    description:
      "Fetch a single X status through workflow preprocessing and summarize the resolved article markdown.",
    materialize: makeXArticleSummaryPlan,
  },
  "deep-research": {
    id: "deep-research",
    title: "Deep Research",
    description:
      "Run an iterative, provider-backed research loop and compile a cited Markdown report.",
    materialize: makeDeepResearchPlan,
  },
} satisfies Record<WorkflowPlanTemplateId, WorkflowTemplate>;

const DEFAULT_DEEP_RESEARCH_CONFIG = {
  providers: ["grok", "exa", "copilot-last30days"] as DeepResearchProvider[],
  maxIterations: 3,
  questionsPerIteration: 5,
  maxResultsPerQuestion: 5,
  providerRetryAttempts: 1,
  visualize: false,
};

function makeXArticleSummaryPlan(objective: string): RuntimeWorkflowPlan {
  return {
    id: workflowPlanId("x-article-summary", objective),
    objective,
    templateId: "x-article-summary",
    maxReplans: 0,
    nodes: [
      {
        id: "summarize-x-article",
        kind: WorkflowNodeKind.RESEARCH,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Summarize X article",
        description: "Summarize the X article content resolved by workflow prompt preprocessing.",
        model: "deterministic",
        modelRationale:
          "This smoke workflow summarizes the already-prefetched markdown without another model call.",
        prompt: [
          "Summarize this X article.",
          "Use the resolved X post markdown that workflow prompt preprocessing appended to the objective.",
          "",
          objective,
        ].join("\n"),
        dependsOn: [],
        gates: [WorkflowGateKind.OUTPUT_CONTRACT],
        writeMode: "read-only" as WorkflowNodeWriteMode,
        replanPolicy: "never" as WorkflowReplanPolicy,
      },
    ],
  };
}

function makeVerificationOptimizerPlan(
  objective: string,
  input: WorkflowTemplateInput = { objective },
): RuntimeWorkflowPlan {
  const project = input.project ?? input.projectPath ?? "";
  const includeInitialReview = !input.externalResearch;
  const nodes: RuntimeWorkflowPlan["nodes"] = [
    {
      id: "project-verification-audit",
      kind: WorkflowNodeKind.RESEARCH,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Audit project verification",
      description:
        "Inspect only the target project and summarize its current verification surface.",
      ...verificationOptimizerNodeMetadata(
        "gpt-5.5",
        "Verification audit uses a strong repository analysis model.",
      ),
      prompt: `Audit the verification surface for target project: ${project}`,
      dependsOn: [],
      gates: [WorkflowGateKind.OUTPUT_CONTRACT],
      writeMode: "read-only" as WorkflowNodeWriteMode,
      replanPolicy: "on-contract-failure" as WorkflowReplanPolicy,
    },
    {
      id: "verification-opportunity-mapping",
      kind: WorkflowNodeKind.PLANNING,
      harness: WorkflowHarnessKind.RESEARCH,
      title: "Map verification opportunities",
      description:
        "Map the audit into at most one strict high-confidence verification-only improvement candidate.",
      ...verificationOptimizerNodeMetadata(
        "gpt-5.5",
        "Opportunity mapping uses typed BAML distillation and review.",
      ),
      prompt: "Map the verification audit into strict verification-only opportunities.",
      dependsOn: ["project-verification-audit"],
      gates: [WorkflowGateKind.OUTPUT_CONTRACT],
      writeMode: "read-only" as WorkflowNodeWriteMode,
      replanPolicy: "on-contract-failure" as WorkflowReplanPolicy,
    },
  ];
  if (includeInitialReview) {
    nodes.push(buildVerificationReviewNode("verification-opportunity-mapping"));
  }
  return {
    id: workflowPlanId("verification-optimizer", objective),
    objective,
    templateId: "verification-optimizer",
    maxReplans: 2,
    nodes,
  };
}

function buildVerificationReviewNode(dependency: string): RuntimeWorkflowPlan["nodes"][number] {
  return {
    id: "verification-review",
    kind: WorkflowNodeKind.DELIBERATION,
    harness: WorkflowHarnessKind.DECISION_COUNCIL,
    title: "Review verification recommendation",
    description:
      "Apply strict gates and select at most one high-confidence verification-only improvement.",
    ...verificationOptimizerNodeMetadata(
      "deterministic",
      "Strict review is deterministic after typed opportunity mapping.",
    ),
    prompt: "Review verification opportunities against strict acceptance gates.",
    dependsOn: [dependency],
    gates: [WorkflowGateKind.REVIEW_ACCEPTED],
    writeMode: "read-only" as WorkflowNodeWriteMode,
    replanPolicy: "on-review-rejection" as WorkflowReplanPolicy,
  };
}

function makeDeepResearchPlan(
  objective: string,
  input: WorkflowTemplateInput = { objective },
): RuntimeWorkflowPlan {
  const config = {
    providers: input.providers?.length ? input.providers : DEFAULT_DEEP_RESEARCH_CONFIG.providers,
    maxIterations: readPositiveInteger(
      input.maxIterations,
      DEFAULT_DEEP_RESEARCH_CONFIG.maxIterations,
    ),
    questionsPerIteration: readPositiveInteger(
      input.questionsPerIteration,
      DEFAULT_DEEP_RESEARCH_CONFIG.questionsPerIteration,
    ),
    maxResultsPerQuestion: readPositiveInteger(
      input.maxResultsPerQuestion,
      DEFAULT_DEEP_RESEARCH_CONFIG.maxResultsPerQuestion,
    ),
    providerRetryAttempts: readNonNegativeInteger(
      input.providerRetryAttempts,
      DEFAULT_DEEP_RESEARCH_CONFIG.providerRetryAttempts,
    ),
    visualize: input.visualize ?? DEFAULT_DEEP_RESEARCH_CONFIG.visualize,
  };
  const runId = normalizeOptionalNodeId(input.deepResearchRunId);
  return {
    id: workflowPlanId("deep-research", objective),
    objective,
    templateId: "deep-research",
    maxReplans: 0,
    nodes: [
      {
        id: deepResearchNodeId(runId, "questions-1"),
        kind: WorkflowNodeKind.RESEARCH,
        harness: WorkflowHarnessKind.RESEARCH,
        title: "Generate research questions",
        description: "Generate the first bounded question batch for iterative deep research.",
        model: "gpt-5.5",
        modelRationale: "Question generation uses the primary research synthesis model.",
        prompt: "Generate the first research question set for the objective.",
        input: {
          deepResearchStep: "generate-questions",
          ...(runId ? { deepResearchRunId: runId, objective } : {}),
          iteration: 1,
          config,
        },
        dependsOn: [],
        gates: [WorkflowGateKind.OUTPUT_CONTRACT],
        writeMode: "read-only" as WorkflowNodeWriteMode,
        replanPolicy: "never" as WorkflowReplanPolicy,
      },
    ],
  };
}

function makeRouterPlan(objective: string): RuntimeWorkflowPlan {
  return {
    id: workflowPlanId("router", objective),
    objective,
    templateId: "router",
    maxReplans: 0,
    nodes: [
      {
        id: "advise-prompt",
        kind: WorkflowNodeKind.PLANNING,
        harness: WorkflowHarnessKind.RESEARCH,
        title: "Advise prompt route",
        description: "Classify the prompt, rank candidates, and produce the router contract.",
        model: "gpt-5.5",
        modelRationale: "Router uses the configured primary advisory model.",
        prompt: objective,
        dependsOn: [],
        gates: [WorkflowGateKind.OUTPUT_CONTRACT],
        writeMode: "read-only" as WorkflowNodeWriteMode,
        replanPolicy: "never" as WorkflowReplanPolicy,
      },
      {
        id: "report",
        kind: WorkflowNodeKind.REPORT,
        harness: WorkflowHarnessKind.REPORTER,
        title: "Publish router report",
        description: "Format the advisory result for CLI and dashboard consumption.",
        model: "deterministic",
        modelRationale: "The report node formats typed router output without a model call.",
        prompt: "Write deterministic router JSON and Markdown artifacts.",
        dependsOn: ["advise-prompt"],
        gates: [WorkflowGateKind.OUTPUT_CONTRACT],
        writeMode: "read-only" as WorkflowNodeWriteMode,
        replanPolicy: "never" as WorkflowReplanPolicy,
      },
    ],
  };
}

function makeSourceToProjectPlan(
  objective: string,
  input: WorkflowTemplateInput = { objective },
): RuntimeWorkflowPlan {
  const advisoryNodes: RuntimeWorkflowPlan["nodes"] = [
    {
      id: "visual-plan-preflight",
      kind: WorkflowNodeKind.VERIFICATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Verify visual-plan capability",
      description:
        "Fail fast if the visual-plan skill installer cannot resolve before source-to-project research begins.",
      ...sourceNodeMetadata(SourceToProjectModelOperation.DETERMINISTIC),
      prompt: "Verify visual-plan skill installation before source-to-project execution.",
      dependsOn: [],
      gates: [WorkflowGateKind.VERIFICATION],
      writeMode: "read-only" as WorkflowNodeWriteMode,
      replanPolicy: "never" as WorkflowReplanPolicy,
    },
    {
      id: "source-reading",
      kind: WorkflowNodeKind.RESEARCH,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Read source artifact",
      description:
        "Read the source artifact and extract grounded claims, assumptions, evidence, and transferable lessons.",
      ...sourceNodeMetadata(SourceToProjectModelOperation.SOURCE_READING),
      prompt: `Read and analyze source: ${input.source ?? ""}`,
      dependsOn: ["visual-plan-preflight"],
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
      description:
        "Research the target project through the source lens and capture source-relevant change surfaces.",
      ...sourceNodeMetadata(SourceToProjectModelOperation.PROJECT_RESEARCH),
      prompt: `Research target project in relation to source findings: ${input.project ?? input.projectPath ?? ""}`,
      capabilities: {
        pluginCommands: [
          {
            plugin: "hve-core",
            command: "hve-core:task-research",
            promptInputName: "topic",
            args: { subagents: "auto" },
          },
        ],
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
      description:
        "Map corroborated source lessons and project evidence into actionable opportunities and non-applicable lessons.",
      ...sourceNodeMetadata(SourceToProjectModelOperation.OPPORTUNITY_MAPPING),
      prompt:
        "Map source analysis and project brief into opportunities and non-applicable lessons.",
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
      description:
        "Deterministically rank opportunities against source-to-project acceptance thresholds and bundle valid work.",
      ...sourceNodeMetadata(SourceToProjectModelOperation.DETERMINISTIC),
      prompt: "Review opportunities, rank them, and emit valid bundles.",
      dependsOn: ["opportunity-mapping"],
      gates: [WorkflowGateKind.REVIEW_ACCEPTED],
      writeMode: "read-only" as WorkflowNodeWriteMode,
      replanPolicy: "on-review-rejection" as WorkflowReplanPolicy,
    },
  ];

  return {
    id: workflowPlanId("source-to-project", objective),
    objective,
    templateId: "source-to-project",
    maxReplans: 2,
    nodes: [...advisoryNodes],
  };
}

function sourceNodeMetadata(operation: SourceToProjectModelOperation) {
  return sourceToProjectNodeModelMetadata(operation);
}

function verificationOptimizerNodeMetadata(model: string, rationale: string) {
  return {
    model,
    modelRationale: rationale,
  };
}

function deepResearchNodeId(runId: string | undefined, suffix: string): string {
  return runId ? `${runId}-${suffix}` : `deep-research-${suffix}`;
}

function normalizeOptionalNodeId(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/(^-|-$)/gu, "");
  return normalized || undefined;
}

function workflowPlanId(prefix: WorkflowPlanTemplateId, objective: string): string {
  const slug =
    objective
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "plan";
  return `${prefix}-${slug.slice(0, 96).replace(/-$/u, "")}`;
}

function readPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
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
  const templateId =
    typeof templateIdOrInput === "string" ? templateIdOrInput : "implementation-review";
  const objective =
    typeof templateIdOrInput === "string"
      ? typeof maybeObjective === "string"
        ? maybeObjective
        : maybeObjective && typeof maybeObjective === "object" && "objective" in maybeObjective
          ? String(maybeObjective.objective)
          : ""
      : templateIdOrInput.objective;
  const input =
    typeof templateIdOrInput === "string" && maybeObjective && typeof maybeObjective === "object"
      ? maybeObjective
      : typeof templateIdOrInput === "object"
        ? templateIdOrInput
        : { objective: String(objective) };
  return getWorkflowTemplate(templateId).materialize(String(objective), input);
}
