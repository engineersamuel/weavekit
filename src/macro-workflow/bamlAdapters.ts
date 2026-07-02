import { b } from "../generated/baml_client/index.js";
import type {
  WorkflowPlan as BamlWorkflowPlan,
  WorkflowReplanPatch as BamlWorkflowReplanPatch,
} from "../generated/baml_client/index.js";
import type { RuntimeWorkflowPlan, WorkflowReplanPatch, WorkflowReplanPolicy } from "./types.js";
import { WorkflowHarnessKind, WorkflowNodeKind } from "./types.js";
import type { WorkflowUsageCollector } from "./usage.js";

export type WorkflowPlannerInput = {
  prompt: string;
  objective: string;
  templateId: string;
};

export type WorkflowReplanInput = {
  reason: string;
  maxRemainingReplans: number;
  completedNodeIds?: string[];
  currentPlan?: RuntimeWorkflowPlan;
};

export type WorkflowPlannerAdapter = {
  planWorkflow(input: WorkflowPlannerInput): Promise<RuntimeWorkflowPlan>;
  generateReplanPatch(input: WorkflowReplanInput): Promise<WorkflowReplanPatch>;
};

export type PlannerClientLike = {
  PlanWorkflow: (...args: unknown[]) => Promise<BamlWorkflowPlan>;
  GenerateReplanPatch: (...args: unknown[]) => Promise<BamlWorkflowReplanPatch>;
};

type BamlClientOverride = {
  client: string;
};

const PLAN_WORKFLOW_BAML_OPTIONS: BamlClientOverride = {
  client: "CopilotProxyGpt55",
};

const GENERATE_REPLAN_PATCH_BAML_OPTIONS: BamlClientOverride = {
  client: "CopilotProxyClaudeOpus48",
};

const PLANNER_METHOD_MODELS: Record<"PlanWorkflow" | "GenerateReplanPatch", string> = {
  PlanWorkflow: "gpt-5.5",
  GenerateReplanPatch: "claude-opus-4.8",
};

export type GeneratedWorkflowPlannerAdapterOptions = {
  plannerClient?: PlannerClientLike;
  usageCollector?: WorkflowUsageCollector;
};

export class GeneratedWorkflowPlannerAdapter implements WorkflowPlannerAdapter {
  private readonly client: PlannerClientLike;
  private readonly usageCollector?: WorkflowUsageCollector;

  constructor(clientOrOptions: PlannerClientLike | GeneratedWorkflowPlannerAdapterOptions = b as unknown as PlannerClientLike) {
    const maybeOptions = clientOrOptions as GeneratedWorkflowPlannerAdapterOptions;
    if (maybeOptions && typeof maybeOptions === "object" && ("plannerClient" in maybeOptions || "usageCollector" in maybeOptions)) {
      this.client = maybeOptions.plannerClient ?? (b as unknown as PlannerClientLike);
      this.usageCollector = maybeOptions.usageCollector;
    } else {
      this.client = clientOrOptions as PlannerClientLike;
    }
  }

  async planWorkflow(input: WorkflowPlannerInput): Promise<RuntimeWorkflowPlan> {
    const plan = await invokePlannerMethod<Record<string, unknown>, BamlWorkflowPlan>(this.client, "PlanWorkflow", {
      objective: input.objective,
      templateId: input.templateId,
      prompt: input.prompt,
    }, PLAN_WORKFLOW_BAML_OPTIONS, this.usageCollector);
    return normalizeWorkflowPlan(plan);
  }

  async generateReplanPatch(input: WorkflowReplanInput): Promise<WorkflowReplanPatch> {
    const patch = await invokePlannerMethod<Record<string, unknown>, BamlWorkflowReplanPatch>(this.client, "GenerateReplanPatch", {
      reason: input.reason,
      maxRemainingReplans: input.maxRemainingReplans,
      completedNodeIds: input.completedNodeIds,
      currentPlan: input.currentPlan,
    }, GENERATE_REPLAN_PATCH_BAML_OPTIONS, this.usageCollector);
    return normalizeWorkflowReplanPatch(patch);
  }
}

async function invokePlannerMethod<TArgs extends Record<string, unknown>, TResult>(
  client: PlannerClientLike,
  method: "PlanWorkflow" | "GenerateReplanPatch",
  args: TArgs,
  options: BamlClientOverride,
  usageCollector?: WorkflowUsageCollector,
): Promise<TResult> {
  const methodImpl = client[method] as unknown as (...args: unknown[]) => Promise<TResult>;
  const boundMethod = methodImpl.bind(client);
  const collector = usageCollector?.createBamlCollector(`macro-workflow.${method}`);
  const callOptions = {
    ...options,
    ...(collector ? { collector } : {}),
  };
  try {
    if (method === "PlanWorkflow") {
      return await boundMethod(args.objective, args.prompt, args.templateId, callOptions);
    }

    return await boundMethod(args.reason, args.maxRemainingReplans, args.completedNodeIds, args.currentPlan, callOptions);
  } finally {
    if (collector) {
      usageCollector?.recordBamlCollector({
        operation: method,
        model: PLANNER_METHOD_MODELS[method],
        collector,
      });
    }
  }
}

function normalizeWorkflowPlan(plan: BamlWorkflowPlan): RuntimeWorkflowPlan {
  return {
    id: plan.id ?? "workflow-plan",
    objective: plan.objective,
    templateId: plan.templateId,
    maxReplans: plan.maxReplans,
    nodes: plan.nodes.map((node) => ({
      id: node.id,
      kind: normalizeWorkflowNodeKind(node.kind),
      harness: normalizeWorkflowHarnessKind(node.harness),
      title: node.title,
      description: node.description ?? node.prompt,
      model: node.model ?? inferNormalizedNodeModel(node.kind, node.harness),
      modelRationale: node.modelRationale ?? "Default model inferred from normalized workflow node kind and harness.",
      prompt: node.prompt,
      dependsOn: node.dependsOn,
      gates: node.gates as Array<"output-contract" | "review-accepted" | "verification">,
      writeMode: normalizeWriteMode(node.writeMode),
      replanPolicy: normalizeReplanPolicy(node.replanPolicy),
    })),
  };
}

function normalizeWorkflowReplanPatch(patch: BamlWorkflowReplanPatch): WorkflowReplanPatch {
  return {
    reason: patch.reason,
    replaceRemainingNodeIds: patch.replaceRemainingNodeIds,
    newNodes: patch.newNodes.map((node) => ({
      id: node.id,
      kind: normalizeWorkflowNodeKind(node.kind),
      harness: normalizeWorkflowHarnessKind(node.harness),
      title: node.title,
      description: node.description ?? node.prompt,
      model: node.model ?? inferNormalizedNodeModel(node.kind, node.harness),
      modelRationale: node.modelRationale ?? "Default model inferred from normalized workflow node kind and harness.",
      prompt: node.prompt,
      dependsOn: node.dependsOn,
      gates: node.gates as Array<"output-contract" | "review-accepted" | "verification">,
      writeMode: normalizeWriteMode(node.writeMode),
      replanPolicy: normalizeReplanPolicy(node.replanPolicy),
    })),
  };
}

function normalizeWorkflowNodeKind(kind: string): RuntimeWorkflowPlan["nodes"][number]["kind"] {
  if (kind === WorkflowNodeKind.RESEARCH) return WorkflowNodeKind.RESEARCH;
  if (kind === WorkflowNodeKind.DELIBERATION) return WorkflowNodeKind.DELIBERATION;
  if (kind === WorkflowNodeKind.PLANNING) return WorkflowNodeKind.PLANNING;
  if (kind === WorkflowNodeKind.IMPLEMENTATION) return WorkflowNodeKind.IMPLEMENTATION;
  if (kind === WorkflowNodeKind.VERIFICATION) return WorkflowNodeKind.VERIFICATION;
  if (kind === WorkflowNodeKind.REPORT) return WorkflowNodeKind.REPORT;
  return WorkflowNodeKind.VISUALIZATION;
}

function normalizeWorkflowHarnessKind(harness: string) {
  if (harness === WorkflowHarnessKind.DECISION_COUNCIL) return WorkflowHarnessKind.DECISION_COUNCIL;
  if (harness === WorkflowHarnessKind.COPILOT_SDK) return WorkflowHarnessKind.COPILOT_SDK;
  if (harness === WorkflowHarnessKind.VERIFIER) return WorkflowHarnessKind.VERIFIER;
  if (harness === WorkflowHarnessKind.REPORTER) return WorkflowHarnessKind.REPORTER;
  return WorkflowHarnessKind.RESEARCH;
}

function normalizeWriteMode(writeMode: string): RuntimeWorkflowPlan["nodes"][number]["writeMode"] {
  return writeMode === "single-writer" ? "single-writer" : "read-only";
}

function normalizeReplanPolicy(policy: string): WorkflowReplanPolicy {
  if (policy === "on-contract-failure") return "on-contract-failure";
  if (policy === "on-review-rejection") return "on-review-rejection";
  if (policy === "on-verification-failure") return "on-verification-failure";
  return "never";
}

function inferNormalizedNodeModel(kind: string, harness: string): string {
  if (harness === WorkflowHarnessKind.VERIFIER || harness === WorkflowHarnessKind.REPORTER) {
    return "deterministic";
  }
  if (harness === WorkflowHarnessKind.COPILOT_SDK && kind === WorkflowNodeKind.IMPLEMENTATION) {
    return "gpt-5.3-codex";
  }
  if (kind === WorkflowNodeKind.PLANNING) {
    return "claude-opus-4.8";
  }
  return "gpt-5.5";
}
