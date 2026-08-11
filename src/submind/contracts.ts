import type { ProjectCatalogEntry } from "../config.js";
import type { MastermindNextActionDecision } from "../generated/baml_client/index.js";
import type { LinearTicketSnapshot, StoredReview } from "../mastermind/store/store.js";
import type { ExecutionPreflightReport, ExecutionPreflightRequirement } from "./preflight.js";
import { assertExecutionPreflight } from "./preflight.js";

export const ExecutorKind = {
  HERDR_COPILOT: "herdr-copilot",
} as const;
export type ExecutorKind = (typeof ExecutorKind)[keyof typeof ExecutorKind];

export type ExecutionWorkspace =
  | {
      kind: "existing-repository-worktree";
      sourceRepositoryPath: string;
      checkoutPath: string;
      branchName: string;
      parentWorkspaceLookupPath: string;
      creatorAttemptId: string;
      lastObservedWorkspaceId?: string;
      lastObservedTabId?: string;
      lastObservedRootPaneId?: string;
    }
  | {
      kind: "greenfield-repository-worktree";
      provisioningRoot: string;
      workId: string;
      sourceRepositoryPath: string;
      checkoutPath: string;
      branchName: string;
      parentWorkspaceLookupPath: string;
      creatorAttemptId: string;
      lastObservedWorkspaceId?: string;
      lastObservedTabId?: string;
      lastObservedRootPaneId?: string;
    };

export type SubmindRequestInput = {
  workId: string;
  attemptId: string;
  attemptNumber: number;
  objective: string;
};

export type DirectExecutionRequest = SubmindRequestInput & {
  projectId: string;
  ticket: LinearTicketSnapshot;
  review: StoredReview;
  decision: MastermindNextActionDecision;
  workspace: ExecutionWorkspace;
  validationCommands: string[];
  preflightRequirements: ExecutionPreflightRequirement[];
  resultManifestPath: string;
  allowedPullRequestHosts: string[];
};

export type ExecutorHandle = {
  executor: ExecutorKind;
  agentName: string;
  agentSessionId?: string;
  worktreePath: string;
  lastObservedWorkspaceId?: string;
  lastObservedTabId?: string;
  lastObservedPaneId?: string;
};

export type ExecutorStatus = {
  state: "idle" | "working" | "blocked" | "done" | "unknown";
  observedAt: string;
  detail?: string;
  unknownCount?: number;
};

export type VerificationEntry = {
  command: string;
  exitCode: number;
  summary: string;
};

export type DirectExecutionResult = {
  schemaVersion: 1;
  workId: string;
  attemptId: string;
  attemptNumber: number;
  outcome: "succeeded" | "retryable-failure" | "terminal-failure" | "needs-human";
  summary: string;
  artifactPaths: string[];
  pullRequestUrl?: string;
  verification: VerificationEntry[];
  knownRisks: string[];
  remainingWork: string[];
};

export type VerificationEvidence = {
  commands: Array<VerificationEntry & { durationMs: number }>;
  passed: boolean;
};

const executionPreflightApproval = Symbol("execution-preflight-approval");

type ExecutionPreflightApproval = {
  report: ExecutionPreflightReport;
  [executionPreflightApproval]: true;
};

export function createDirectExecutionRequest(
  input: SubmindRequestInput & {
    ticket: LinearTicketSnapshot;
    review: StoredReview;
    decision: MastermindNextActionDecision;
    workspace: ExecutionWorkspace;
  },
  project: ProjectCatalogEntry,
): DirectExecutionRequest {
  return {
    ...input,
    projectId: project.id,
    validationCommands: [...project.validationCommands],
    preflightRequirements: (project.executionPreflightRequirements ?? []).map((requirement) => ({
      ...requirement,
    })),
    resultManifestPath: ".weavekit/mastermind-result.json",
    allowedPullRequestHosts: [...(project.directExecution?.allowedPullRequestHosts ?? [])],
  };
}

export type DirectExecutor = {
  preflight(request: DirectExecutionRequest): Promise<ExecutionPreflightReport>;
  start(
    request: DirectExecutionRequest,
    approval: ExecutionPreflightApproval,
  ): Promise<ExecutorHandle>;
  status(handle: ExecutorHandle): Promise<ExecutorStatus>;
  cancel(handle: ExecutorHandle): Promise<{ confirmed: boolean; status: ExecutorStatus }>;
  collect(handle: ExecutorHandle): Promise<DirectExecutionResult>;
};

export async function startDirectExecutionWithPreflight(
  executor: DirectExecutor,
  request: DirectExecutionRequest,
): Promise<ExecutorHandle> {
  const report = await executor.preflight(request);
  return startDirectExecutionWithApprovedPreflight(executor, request, report);
}

export function startDirectExecutionWithApprovedPreflight(
  executor: DirectExecutor,
  request: DirectExecutionRequest,
  report: ExecutionPreflightReport,
): Promise<ExecutorHandle> {
  assertExecutionPreflight(report);
  return executor.start(request, {
    report,
    [executionPreflightApproval]: true,
  });
}
