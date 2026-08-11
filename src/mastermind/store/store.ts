import type {
  MastermindNextActionDecision,
  PostImplementationReview,
  PostImplementationReviewDossier,
  ProposedLinearTicketPatch,
  TicketReviewDossier,
} from "../../generated/baml_client/index.js";
import type { MastermindAction, MastermindState } from "../domain/events.js";
import type {
  DirectExecutionResult,
  ExecutionWorkspace,
  ExecutorHandle,
  ExecutorKind,
  ExecutorStatus,
  VerificationEvidence,
} from "../../submind/contracts.js";
import type { ExecutionPreflightReport } from "../../submind/preflight.js";

export type LinearTicketSnapshot = {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string;
  labels: Array<{ id: string; name: string }>;
  status: string;
  projectId?: string;
  teamId: string;
  updatedAt?: string;
};

export type MastermindWorkItem = {
  id: string;
  organizationId: string;
  issueId: string;
  projectPolicyId?: string;
  state: MastermindState;
  plannedAction?: MastermindAction;
  currentExecutionAttemptId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  retryCount: number;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type ExecutionAttempt = {
  id: string;
  workId: string;
  attemptNumber: number;
  action: typeof MastermindAction.IMPLEMENT_DIRECTLY;
  projectPolicyId: string;
  projectPolicyVersion: string;
  executorKind: ExecutorKind;
  state: MastermindState;
  workspace?: ExecutionWorkspace;
  preflight?: ExecutionPreflightReport;
  executorHandle?: ExecutorHandle;
  lastStatus?: ExecutorStatus;
  result?: DirectExecutionResult;
  verification?: VerificationEvidence;
  failureClass?: string;
  failureMessage?: string;
  retryEligible: boolean;
  projection?: ExecutionProjection;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  launchedAt?: string;
  terminalAt?: string;
  collectedAt?: string;
};

export type ExecutionProjection = {
  disposition: "pending" | "applied";
  externalId?: string;
  projectedAt?: string;
};

export type RecoverableExecution = {
  workId: string;
  attemptId: string;
};

export type ExecutionAttachmentTarget = {
  workId: string;
  issueId: string;
  ticketIdentifier: string;
  attempt: ExecutionAttempt;
};

export type ExecutionAttemptPatch = {
  workspace?: ExecutionWorkspace;
  preflight?: ExecutionPreflightReport;
  executorHandle?: ExecutorHandle;
  lastStatus?: ExecutorStatus;
  result?: DirectExecutionResult;
  verification?: VerificationEvidence;
  failureClass?: string;
  failureMessage?: string;
  retryEligible?: boolean;
  launchedAt?: string;
  terminalAt?: string;
  collectedAt?: string;
};

export type StoredReview = {
  id: string;
  workId: string;
  originalSnapshot: LinearTicketSnapshot;
  originalContentHash: string;
  dossier: TicketReviewDossier;
  patch: ProposedLinearTicketPatch;
  legacyOpenItemDispositionsMissing?: boolean;
  validation?: TicketReviewValidationRecord;
  appliedSnapshot?: LinearTicketSnapshot;
  contentApplied: boolean;
  labelApplied: boolean;
  invalidated: boolean;
  invalidationReason?: string;
};

export type StoredCodeReview = {
  id: string;
  workId: string;
  executionAttemptId: string;
  commitSha: string;
  resultHash: string;
  ticketHash: string;
  status: "pending" | "running" | "passed" | "changes_requested" | "needs_human";
  dossier?: PostImplementationReviewDossier;
  review?: PostImplementationReview;
  projection?: ExecutionProjection;
  createdAt: string;
  updatedAt: string;
};

export type TicketReviewValidationRecord = {
  accepted: boolean;
  requiresHumanApproval: boolean;
  reasons: string[];
};

export type MastermindEventRecord = {
  eventType: string;
  priorState: MastermindState;
  nextState: MastermindState;
  metadata?: Record<string, unknown>;
};

export type TerminalWorkFreshnessScanCursor = {
  updatedAt: string;
  createdAt: string;
  workId: string;
};

export type TerminalWorkFreshnessScanPage = {
  workIds: string[];
  nextCursor?: TerminalWorkFreshnessScanCursor;
};

export type IngestDeliveryInput = {
  deliveryId: string;
  organizationId: string;
  webhookId?: string;
  eventType: string;
  action: string;
  issueId: string;
};

export type MastermindStore = {
  initialize(): Promise<void>;
  close(): void;
  ingestDelivery(input: IngestDeliveryInput): Promise<{ duplicate: boolean; workId: string }>;
  acquireLease(
    workId: string,
    owner: string,
    now: Date,
    durationMs: number,
  ): Promise<MastermindWorkItem | undefined>;
  renewLease(workId: string, owner: string, now: Date, durationMs: number): Promise<boolean>;
  releaseLease(workId: string, owner: string): Promise<void>;
  getWork(workId: string): Promise<MastermindWorkItem | undefined>;
  transition(
    work: MastermindWorkItem,
    owner: string,
    event: MastermindEventRecord,
  ): Promise<MastermindWorkItem>;
  createExecutionAttempt(input: {
    work: MastermindWorkItem;
    owner: string;
    projectPolicyId: string;
    projectPolicyVersion: string;
    executorKind: ExecutorKind;
  }): Promise<{ work: MastermindWorkItem; attempt: ExecutionAttempt }>;
  getExecutionAttempt(attemptId: string): Promise<ExecutionAttempt | undefined>;
  getCurrentExecutionAttempt(workId: string): Promise<ExecutionAttempt | undefined>;
  findExecutionAttachment(selector: string): Promise<ExecutionAttachmentTarget | undefined>;
  getCurrentCodeReview(workId: string): Promise<StoredCodeReview | undefined>;
  createCodeReview(
    input: Omit<StoredCodeReview, "id" | "status" | "createdAt" | "updatedAt">,
  ): Promise<StoredCodeReview>;
  saveCodeReview(input: {
    review: StoredCodeReview;
    status: StoredCodeReview["status"];
    dossier?: PostImplementationReviewDossier;
    result?: PostImplementationReview;
    projection?: ExecutionProjection;
  }): Promise<StoredCodeReview>;
  transitionExecutionAttempt(input: {
    work: MastermindWorkItem;
    attempt: ExecutionAttempt;
    owner: string;
    event: MastermindEventRecord;
    patch?: ExecutionAttemptPatch;
  }): Promise<{ work: MastermindWorkItem; attempt: ExecutionAttempt }>;
  patchExecutionAttempt(input: {
    work: MastermindWorkItem;
    attempt: ExecutionAttempt;
    owner: string;
    patch: ExecutionAttemptPatch;
    eventType: string;
  }): Promise<ExecutionAttempt>;
  saveExecutionProjection(input: {
    work: MastermindWorkItem;
    attempt: ExecutionAttempt;
    owner: string;
    projection: ExecutionProjection;
  }): Promise<ExecutionAttempt>;
  listRecoverableExecutions(now: Date): Promise<RecoverableExecution[]>;
  listLaunchableExecutionWorkIds(now: Date): Promise<string[]>;
  saveTicketSnapshot(workId: string, snapshot: LinearTicketSnapshot): Promise<void>;
  getLatestTicketSnapshot(workId: string): Promise<LinearTicketSnapshot | undefined>;
  getLatestReview(workId: string): Promise<StoredReview | undefined>;
  saveReviewProposal(
    workId: string,
    snapshot: LinearTicketSnapshot,
    originalContentHash: string,
    dossier: TicketReviewDossier,
    patch: ProposedLinearTicketPatch,
  ): Promise<StoredReview>;
  saveReviewValidation(reviewId: string, validation: TicketReviewValidationRecord): Promise<void>;
  markReviewContentApplied(reviewId: string): Promise<void>;
  markReviewLabelApplied(reviewId: string): Promise<void>;
  saveReviewAppliedSnapshot(reviewId: string, snapshot: LinearTicketSnapshot): Promise<void>;
  invalidateReview(reviewId: string, reason: string): Promise<void>;
  saveDecision(workId: string, decision: MastermindNextActionDecision): Promise<void>;
  getLatestDecision(workId: string): Promise<MastermindNextActionDecision | undefined>;
  setProjectPolicy(workId: string, projectPolicyId: string): Promise<void>;
  listRecoverableWorkIds(now: Date): Promise<string[]>;
  listTerminalWorkIdsForFreshnessScan(
    now: Date,
    page: { limit: number; cursor?: TerminalWorkFreshnessScanCursor },
  ): Promise<TerminalWorkFreshnessScanPage>;
  listEvents(workId: string): Promise<Array<Record<string, unknown>>>;
};
