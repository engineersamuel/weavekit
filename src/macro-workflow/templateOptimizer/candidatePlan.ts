import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Opportunity, OpportunityCouncilReview, TemplateCandidate, TemplateExpansionCase, WorkflowNode } from "../../generated/baml_client/index.js";
import type { SourceToProjectMode, SourceToProjectThresholds } from "../../config.js";
import type { WorkflowDynamicExpander } from "../runner.js";
import {
  WorkflowGateKind,
  WorkflowHarnessKind,
  WorkflowNodeKind,
  type RuntimeWorkflowNode,
  type RuntimeWorkflowPlan,
  type WorkflowNodeWriteMode,
  type WorkflowReplanPolicy,
} from "../types.js";
import { SourceToProjectModelOperation, sourceToProjectNodeModelMetadata } from "../sourceToProject/modelPolicy.js";

type CandidateOpportunityAcceptance = {
  id: string;
  title: string;
  accepted: boolean;
  reason: string;
  acceptanceAverage: number;
  scores: {
    applicability: number;
    impact: number;
    confidence: number;
    risk: number;
  };
  opportunity: Opportunity;
};

export type LoadTemplateOptimizerCandidatePlanArgs = {
  runsRoot: string;
  runId: string;
  candidateId?: string;
};

export async function loadTemplateOptimizerCandidatePlan(
  args: LoadTemplateOptimizerCandidatePlanArgs,
): Promise<TemplateCandidate> {
  const runPath = join(args.runsRoot, args.runId, "optimizer-run.json");
  const payload = JSON.parse(await readFile(runPath, "utf8")) as unknown;
  const root = requireRecord(payload, "optimizer-run.json");
  const candidate = requireRecord(root.finalIncumbent, "finalIncumbent") as unknown as TemplateCandidate;
  const candidateId = requireNonEmptyString(candidate.id, "finalIncumbent.id");
  if (args.candidateId && args.candidateId !== candidateId) {
    throw new Error(`Candidate ${args.candidateId} is not the final incumbent (${candidateId}).`);
  }
  return candidate;
}

export function materializeTemplateOptimizerCandidatePlan(args: {
  candidate: TemplateCandidate;
  objective: string;
  runId: string;
}): RuntimeWorkflowPlan {
  const candidateId = requireNonEmptyString(args.candidate.id, "candidate.id");
  const nodes = requireArray(args.candidate.sharedInitialNodes, "candidate.sharedInitialNodes")
    .map((node, index) => toRuntimeWorkflowNode(node, `candidate.sharedInitialNodes[${index}]`));
  return {
    id: `source-to-project-optimized-${slugPart(args.runId)}-${slugPart(candidateId)}`,
    objective: args.objective,
    templateId: "source-to-project",
    maxReplans: 2,
    nodes,
  };
}

export function createTemplateOptimizerCandidateDynamicExpander(args: {
  candidate: TemplateCandidate;
  mode: SourceToProjectMode;
  thresholds: SourceToProjectThresholds;
}): WorkflowDynamicExpander {
  return ({ node, result }) => {
    if (node.id !== "council-review" || result.status !== "passed") {
      return undefined;
    }
    const councilReview = result.payload?.councilReview as OpportunityCouncilReview | undefined;
    if (!councilReview) {
      return undefined;
    }
    const acceptances = selectAcceptedOpportunities(councilReview, args.thresholds);
    const accepted = acceptances.filter((acceptance) => acceptance.accepted);
    const expansionCase = findExpansionCase(args.candidate, args.mode, accepted.length);
    if (!expansionCase) {
      return undefined;
    }
    return expansionCase.nodes.map((node, index) => withCandidateExpansionInput(
      toRuntimeWorkflowNode(node, `candidate.modePolicies.${args.mode}.${expansionCase.id}.nodes[${index}]`),
      acceptances,
      accepted,
    ));
  };
}

function toRuntimeWorkflowNode(node: unknown, path: string): RuntimeWorkflowNode {
  const record = requireRecord(node, path);
  const id = requireNonEmptyString(record.id, `${path}.id`);
  if (id === "source-intake-preflight") {
    return {
      id: "visual-plan-preflight",
      kind: WorkflowNodeKind.VERIFICATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Verify visual-plan capability",
      description: "Fail fast if the visual-plan skill installer cannot resolve before source-to-project research begins.",
      ...sourceToProjectNodeModelMetadata(SourceToProjectModelOperation.DETERMINISTIC),
      prompt: "Verify visual-plan skill installation before source-to-project execution.",
      dependsOn: [],
      gates: [WorkflowGateKind.VERIFICATION],
      writeMode: "read-only",
      replanPolicy: "never",
    };
  }

  return {
    id,
    kind: requireWorkflowNodeKind(record.kind, `${path}.kind`),
    harness: rewriteCandidateHarness(id, requireWorkflowHarnessKind(record.harness, `${path}.harness`)),
    title: requireNonEmptyString(record.title, `${path}.title`),
    description: typeof record.description === "string" ? record.description : undefined,
    model: typeof record.model === "string" ? record.model : undefined,
    modelRationale: typeof record.modelRationale === "string" ? record.modelRationale : undefined,
    prompt: requireString(record.prompt, `${path}.prompt`),
    dependsOn: requireStringArray(record.dependsOn, `${path}.dependsOn`).map(rewriteCandidateNodeId),
    gates: requireStringArray(record.gates, `${path}.gates`).map((gate) => requireWorkflowGateKind(gate, `${path}.gates`)),
    writeMode: requireWorkflowWriteMode(record.writeMode, `${path}.writeMode`),
    replanPolicy: requireWorkflowReplanPolicy(record.replanPolicy, `${path}.replanPolicy`),
  };
}

function findExpansionCase(candidate: TemplateCandidate, mode: SourceToProjectMode, acceptedCount: number): TemplateExpansionCase | undefined {
  const policy = candidate.modePolicies.find((policy) => policy.mode === mode && policy.enabledForOptimization);
  const caseId = acceptedCount === 0
    ? "no-accepted-opportunities"
    : acceptedCount === 1
      ? "single-selected-plan"
      : "multiple-selected-plans";
  return policy?.expansionCases.find((expansionCase) =>
    expansionCase.id === caseId && expansionCase.trigger === "council-review"
  );
}

function withCandidateExpansionInput(
  node: RuntimeWorkflowNode,
  opportunityAcceptances: CandidateOpportunityAcceptance[],
  accepted: CandidateOpportunityAcceptance[],
): RuntimeWorkflowNode {
  const primaryAcceptance = accepted[0] ?? opportunityAcceptances[0];
  return {
    ...node,
    input: {
      ...node.input,
      acceptedOpportunityCount: accepted.length,
      rejectedOpportunityCount: opportunityAcceptances.length - accepted.length,
      opportunityAcceptances,
      ...(primaryAcceptance
        ? {
          opportunity: primaryAcceptance.opportunity,
          opportunityAcceptance: primaryAcceptance,
        }
        : {}),
    },
  };
}

function selectAcceptedOpportunities(
  review: OpportunityCouncilReview,
  thresholds: SourceToProjectThresholds,
): CandidateOpportunityAcceptance[] {
  return review.opportunities.map((opportunity) => {
    const acceptanceAverage = (opportunity.score.applicability + opportunity.score.impact + opportunity.score.confidence) / 3;
    const scores = {
      applicability: opportunity.score.applicability,
      impact: opportunity.score.impact,
      confidence: opportunity.score.confidence,
      risk: opportunity.score.risk,
    };
    if (opportunity.evidence.length === 0) {
      return {
        id: opportunity.id,
        title: opportunity.title,
        accepted: false,
        reason: "Rejected because the opportunity has no supporting evidence.",
        acceptanceAverage,
        scores,
        opportunity,
      };
    }
    if (opportunity.speculative) {
      return {
        id: opportunity.id,
        title: opportunity.title,
        accepted: false,
        reason: "Rejected because the opportunity is marked speculative.",
        acceptanceAverage,
        scores,
        opportunity,
      };
    }
    if (opportunity.score.risk > thresholds.maxRisk) {
      return {
        id: opportunity.id,
        title: opportunity.title,
        accepted: false,
        reason: `Rejected because risk ${opportunity.score.risk.toFixed(2)} exceeds ${thresholds.maxRisk.toFixed(2)}.`,
        acceptanceAverage,
        scores,
        opportunity,
      };
    }
    if (acceptanceAverage < thresholds.minAcceptanceAverage) {
      return {
        id: opportunity.id,
        title: opportunity.title,
        accepted: false,
        reason: `Rejected because acceptance average ${acceptanceAverage.toFixed(2)} is below ${thresholds.minAcceptanceAverage.toFixed(2)}.`,
        acceptanceAverage,
        scores,
        opportunity,
      };
    }
    return {
      id: opportunity.id,
      title: opportunity.title,
      accepted: true,
      reason: `Accepted with ${acceptanceAverage.toFixed(2)} average applicability, impact, and confidence.`,
      acceptanceAverage,
      scores,
      opportunity,
    };
  });
}

function rewriteCandidateNodeId(id: string): string {
  return id === "source-intake-preflight" ? "visual-plan-preflight" : id;
}

function rewriteCandidateHarness(id: string, harness: WorkflowHarnessKind): WorkflowHarnessKind {
  if (id.startsWith("plan-opportunity-") || id.startsWith("final-recommendation-review-")) {
    return WorkflowHarnessKind.COPILOT_SDK;
  }
  return harness;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string.`);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be an array of strings.`);
  }
  return value;
}

function requireWorkflowNodeKind(value: unknown, path: string): WorkflowNodeKind {
  if (!isOneOf(value, WorkflowNodeKind)) {
    throw new Error(`${path} must be a supported workflow node kind.`);
  }
  return value;
}

function requireWorkflowHarnessKind(value: unknown, path: string): WorkflowHarnessKind {
  if (!isOneOf(value, WorkflowHarnessKind)) {
    throw new Error(`${path} must be a supported workflow harness kind.`);
  }
  return value;
}

function requireWorkflowGateKind(value: unknown, path: string): WorkflowGateKind {
  if (!isOneOf(value, WorkflowGateKind)) {
    throw new Error(`${path} must be a supported workflow gate kind.`);
  }
  return value;
}

function requireWorkflowWriteMode(value: unknown, path: string): WorkflowNodeWriteMode {
  if (value !== "read-only" && value !== "single-writer") {
    throw new Error(`${path} must be read-only or single-writer.`);
  }
  return value;
}

function requireWorkflowReplanPolicy(value: unknown, path: string): WorkflowReplanPolicy {
  if (
    value !== "never"
    && value !== "on-contract-failure"
    && value !== "on-review-rejection"
    && value !== "on-verification-failure"
  ) {
    throw new Error(`${path} must be a supported workflow replan policy.`);
  }
  return value;
}

function isOneOf<T extends Record<string, string>>(value: unknown, values: T): value is T[keyof T] {
  return typeof value === "string" && Object.values(values).includes(value);
}

function slugPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 64) || "candidate";
}
