import { b } from "../generated/baml_client/index.js";
import type {
  WorkflowPlan as BamlWorkflowPlan,
  WorkflowReplanPatch as BamlWorkflowReplanPatch,
} from "../generated/baml_client/index.js";
import type { RuntimeWorkflowPlan, WorkflowReplanPatch, WorkflowReplanPolicy } from "./types.js";
import { WorkflowHarnessKind, WorkflowNodeKind } from "./types.js";

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

export type GeneratedWorkflowPlannerAdapterOptions = {
  plannerClient?: PlannerClientLike;
};

export class GeneratedWorkflowPlannerAdapter implements WorkflowPlannerAdapter {
  private readonly client: PlannerClientLike;

  constructor(clientOrOptions: PlannerClientLike | GeneratedWorkflowPlannerAdapterOptions = b as unknown as PlannerClientLike) {
    const maybeOptions = clientOrOptions as GeneratedWorkflowPlannerAdapterOptions;
    if (maybeOptions && typeof maybeOptions === "object" && "plannerClient" in maybeOptions) {
      this.client = maybeOptions.plannerClient!;
    } else {
      this.client = clientOrOptions as PlannerClientLike;
    }
  }

  async planWorkflow(input: WorkflowPlannerInput): Promise<RuntimeWorkflowPlan> {
    const plan = await invokePlannerMethod<Record<string, unknown>, BamlWorkflowPlan>(this.client, "PlanWorkflow", {
      objective: input.objective,
      templateId: input.templateId,
      prompt: input.prompt,
    });
    return normalizeWorkflowPlan(plan);
  }

  async generateReplanPatch(input: WorkflowReplanInput): Promise<WorkflowReplanPatch> {
    const patch = await invokePlannerMethod<Record<string, unknown>, BamlWorkflowReplanPatch>(this.client, "GenerateReplanPatch", {
      reason: input.reason,
      maxRemainingReplans: input.maxRemainingReplans,
      completedNodeIds: input.completedNodeIds,
      currentPlan: input.currentPlan,
    });
    return normalizeWorkflowReplanPatch(patch);
  }
}

async function invokePlannerMethod<TArgs extends Record<string, unknown>, TResult>(
  client: PlannerClientLike,
  method: "PlanWorkflow" | "GenerateReplanPatch",
  args: TArgs,
): Promise<TResult> {
  const methodImpl = client[method] as unknown as (...args: unknown[]) => Promise<TResult>;
  const boundMethod = methodImpl.bind(client);
  if (method === "PlanWorkflow") {
    return await boundMethod(args.objective, args.prompt, args.templateId);
  }

  return await boundMethod(args.reason, args.maxRemainingReplans, args.completedNodeIds, args.currentPlan);
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
