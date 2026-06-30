export const WorkflowNodeKind = {
  RESEARCH: "research",
  DELIBERATION: "deliberation",
  PLANNING: "planning",
  IMPLEMENTATION: "implementation",
  VERIFICATION: "verification",
  VISUALIZATION: "visualization",
} as const;
export type WorkflowNodeKind = (typeof WorkflowNodeKind)[keyof typeof WorkflowNodeKind];

export const WorkflowHarnessKind = {
  RESEARCH: "research",
  DECISION_COUNCIL: "decision-council",
  COPILOT_SDK: "copilot-sdk",
  VERIFIER: "verifier",
  REPORTER: "reporter",
} as const;
export type WorkflowHarnessKind = (typeof WorkflowHarnessKind)[keyof typeof WorkflowHarnessKind];

export const WorkflowGateKind = {
  OUTPUT_CONTRACT: "output-contract",
  REVIEW_ACCEPTED: "review-accepted",
  VERIFICATION: "verification",
} as const;
export type WorkflowGateKind = (typeof WorkflowGateKind)[keyof typeof WorkflowGateKind];

export const WorkflowNodeStatus = {
  PENDING: "pending",
  RUNNING: "running",
  PASSED: "passed",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const;
export type WorkflowNodeStatus = (typeof WorkflowNodeStatus)[keyof typeof WorkflowNodeStatus];

export const WorkflowReplanReason = {
  CONTRACT_FAILURE: "contract-failure",
  REVIEW_REJECTION: "review-rejection",
  VERIFICATION_FAILURE: "verification-failure",
  UNSUPPORTED_SHAPE: "unsupported-shape",
} as const;
export type WorkflowReplanReason = (typeof WorkflowReplanReason)[keyof typeof WorkflowReplanReason];

export type WorkflowNodeWriteMode = "read-only" | "single-writer";
export type WorkflowReplanPolicy =
  | "never"
  | "on-contract-failure"
  | "on-review-rejection"
  | "on-verification-failure";

export type WorkflowPlanTemplateId = "implementation-review";

export type RuntimeWorkflowNode = {
  id: string;
  kind: WorkflowNodeKind;
  harness: WorkflowHarnessKind;
  title: string;
  prompt: string;
  dependsOn: string[];
  gates: WorkflowGateKind[];
  writeMode: WorkflowNodeWriteMode;
  replanPolicy: WorkflowReplanPolicy;
};

export type RuntimeWorkflowPlan = {
  id: string;
  objective: string;
  templateId: string;
  maxReplans: number;
  nodes: RuntimeWorkflowNode[];
};

export type WorkflowReplanPatch = {
  reason: WorkflowReplanReason | string;
  replaceRemainingNodeIds: string[];
  newNodes: RuntimeWorkflowNode[];
};

export type WorkflowNodeExecutionResult = {
  nodeId: string;
  status: WorkflowNodeStatus;
  output: string;
  error?: string;
};

export type WorkflowReplanEvent = {
  failedNodeId: string;
  reason: WorkflowReplanReason | string;
  rationale: string;
  patch: WorkflowReplanPatch;
  timestamp: Date;
};

export type MacroWorkflowRunState = {
  runId?: string;
  runName?: string;
  planId: string;
  objective: string;
  templateId: string;
  status: WorkflowNodeStatus | "running";
  startedAt: Date;
  completedAt?: Date;
  plan: RuntimeWorkflowPlan;
  currentPlan: RuntimeWorkflowPlan;
  nodeResults: WorkflowNodeExecutionResult[];
  replans: WorkflowReplanEvent[];
  activeNodeId?: string;
};

export type MacroWorkflowRunStateLike = Omit<MacroWorkflowRunState, "plan"> & {
  plan?: RuntimeWorkflowPlan;
};

export type WorkflowVerificationIssue = {
  code:
    | "empty-plan"
    | "duplicate-node-id"
    | "unknown-dependency"
    | "cycle-detected"
    | "forbidden-node-kind"
    | "forbidden-harness"
    | "forbidden-transition"
    | "parallel-writers"
    | "missing-verification"
    | "invalid-replan-budget";
  message: string;
  nodeId?: string;
};

export type WorkflowVerificationResult = {
  valid: boolean;
  issues: WorkflowVerificationIssue[];
};

export const WorkflowReplayEventKind = {
  PLANNING_STARTED: "planning-started",
  PLANNING_COMPLETE: "planning-complete",
  NODE_ADDED: "node-added",
  NODE_STATUS_CHANGED: "node-status-changed",
  NODE_REMOVED: "node-removed",
  EDGE_ADDED: "edge-added",
  EDGE_REMOVED: "edge-removed",
  REPLAN_APPLIED: "replan-applied",
  RUN_COMPLETED: "run-completed",
} as const;
export type WorkflowReplayEventKind = (typeof WorkflowReplayEventKind)[keyof typeof WorkflowReplayEventKind];

export type WorkflowReplayEvent = {
  seq: number;
  ts: string;
  kind: WorkflowReplayEventKind;
  phase?: "planning" | "running" | "completed";
  nodeId?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  node?: RuntimeWorkflowNode;
  status?: WorkflowNodeStatus | "running";
  reason?: string;
  patch?: WorkflowReplanPatch;
};

export type WorkflowReplayNodeView = {
  id: string;
  kind: string;
  title: string;
  status: WorkflowNodeStatus | "running";
  harness: string;
  exists: boolean;
};

export type WorkflowReplayViewState = {
  activePhase: "planning" | "running" | "completed";
  nodes: WorkflowReplayNodeView[];
  edges: Array<{ id: string; source: string; target: string }>;
};
