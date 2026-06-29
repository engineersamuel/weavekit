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
