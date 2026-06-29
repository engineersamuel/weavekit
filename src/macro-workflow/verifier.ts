import { defaultWorkflowGrammar, type WorkflowGrammar } from "./grammar.js";
import {
  WorkflowGateKind,
  WorkflowNodeKind,
  type RuntimeWorkflowPlan,
  type WorkflowVerificationIssue,
  type WorkflowVerificationResult,
} from "./types.js";

/**
 * Local placeholder type for workflow plan inputs to verifier functions.
 * Task 2 will replace this with generated imports from BAML schema.
 */
type GeneratedWorkflowPlanLike = RuntimeWorkflowPlan;

function detectCycle(plan: GeneratedWorkflowPlanLike): boolean {
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const node = nodes.get(id);
    if (node) {
      for (const dep of node.dependsOn) {
        if (visit(dep)) return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  return plan.nodes.some((node) => visit(node.id));
}

function buildChildrenMap(plan: GeneratedWorkflowPlanLike): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const node of plan.nodes) {
    for (const dep of node.dependsOn) {
      children.set(dep, [...(children.get(dep) ?? []), node.id]);
    }
  }
  return children;
}

function hasDownstreamVerification(plan: GeneratedWorkflowPlanLike, startId: string): boolean {
  const children = buildChildrenMap(plan);
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const queue = [...(children.get(startId) ?? [])];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (node.kind === WorkflowNodeKind.VERIFICATION || node.gates.includes(WorkflowGateKind.VERIFICATION)) {
      return true;
    }
    queue.push(...(children.get(id) ?? []));
  }

  return false;
}

function hasPathBetween(plan: GeneratedWorkflowPlanLike, fromId: string, toId: string): boolean {
  const children = buildChildrenMap(plan);
  const queue = [...(children.get(fromId) ?? [])];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === toId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return false;
}

export function verifyWorkflowPlan(
  plan: GeneratedWorkflowPlanLike,
  grammar: WorkflowGrammar = defaultWorkflowGrammar,
): WorkflowVerificationResult {
  const issues: WorkflowVerificationIssue[] = [];

  if (plan.nodes.length === 0) {
    issues.push({ code: "empty-plan", message: "Workflow plan must contain at least one node." });
  }
  if (!Number.isInteger(plan.maxReplans) || plan.maxReplans < 0 || plan.maxReplans > grammar.maxReplans) {
    issues.push({
      code: "invalid-replan-budget",
      message: `maxReplans must be between 0 and ${grammar.maxReplans}.`,
    });
  }

  const ids = new Set<string>();
  for (const node of plan.nodes) {
    if (ids.has(node.id)) {
      issues.push({ code: "duplicate-node-id", message: `Duplicate node id: ${node.id}.`, nodeId: node.id });
    }
    ids.add(node.id);
    if (!grammar.allowedNodeKinds.has(node.kind)) {
      issues.push({ code: "forbidden-node-kind", message: `Forbidden node kind: ${node.kind}.`, nodeId: node.id });
    }
    if (!grammar.allowedHarnesses.has(node.harness)) {
      issues.push({ code: "forbidden-harness", message: `Forbidden harness: ${node.harness}.`, nodeId: node.id });
    }
  }

  for (const node of plan.nodes) {
    for (const depId of node.dependsOn) {
      const dep = plan.nodes.find((candidate) => candidate.id === depId);
      if (!dep) {
        issues.push({ code: "unknown-dependency", message: `${node.id} depends on unknown node ${depId}.`, nodeId: node.id });
        continue;
      }
      const allowed = grammar.allowedTransitions.get(dep.kind) ?? new Set();
      if (!allowed.has(node.kind)) {
        issues.push({
          code: "forbidden-transition",
          message: `Transition ${dep.kind} -> ${node.kind} is not allowed.`,
          nodeId: node.id,
        });
      }
    }
  }

  if (detectCycle(plan)) {
    issues.push({ code: "cycle-detected", message: "Workflow plan must be acyclic." });
  }

  const writers = plan.nodes.filter((node) => node.writeMode === "single-writer");
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      const left = writers[i]!;
      const right = writers[j]!;
      if (!hasPathBetween(plan, left.id, right.id) && !hasPathBetween(plan, right.id, left.id)) {
        issues.push({
          code: "parallel-writers",
          message: `Single-writer nodes ${left.id} and ${right.id} can run in parallel.`,
          nodeId: right.id,
        });
      }
    }
  }

  for (const node of plan.nodes) {
    if (node.kind === WorkflowNodeKind.IMPLEMENTATION && !hasDownstreamVerification(plan, node.id)) {
      issues.push({
        code: "missing-verification",
        message: `Implementation node ${node.id} must have a downstream verification gate.`,
        nodeId: node.id,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

export function assertValidWorkflowPlan(
  plan: GeneratedWorkflowPlanLike,
  grammar: WorkflowGrammar = defaultWorkflowGrammar,
): void {
  const result = verifyWorkflowPlan(plan, grammar);
  if (!result.valid) {
    throw new Error(result.issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
  }
}
