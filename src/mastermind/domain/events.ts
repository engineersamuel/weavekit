import { MastermindAction as GeneratedMastermindAction } from "../../generated/baml_client/index.js";

export const MastermindAction = GeneratedMastermindAction;
export type MastermindAction = GeneratedMastermindAction;

export const MastermindState = {
  RECEIVED: "received",
  CLAIMED: "claimed",
  DECIDING: "deciding",
  REVIEWING: "reviewing",
  APPLYING_REVIEW: "applying_review",
  ACTION_PLANNED: "action_planned",
  PROVISIONING: "provisioning",
  PREFLIGHTING: "preflighting",
  LAUNCHING: "launching",
  RUNNING: "running",
  COLLECTING: "collecting",
  SUCCEEDED: "succeeded",
  CODE_REVIEW_PENDING: "code_review_pending",
  CODE_REVIEWING: "code_reviewing",
  AWAITING_ACCEPTANCE: "awaiting_acceptance",
  CHANGES_REQUESTED: "changes_requested",
  COMPLETED: "completed",
  NEEDS_HUMAN: "needs_human",
  IGNORED: "ignored",
  RETRY_WAIT: "retry_wait",
  FAILED: "failed",
} as const;
export type MastermindState = (typeof MastermindState)[keyof typeof MastermindState];

export const MastermindEventType = {
  CLAIM: "CLAIM",
  DECIDE: "DECIDE",
  REVIEW: "REVIEW",
  REVIEW_GENERATED: "REVIEW_GENERATED",
  REVIEW_APPLIED: "REVIEW_APPLIED",
  REVIEW_INVALIDATED: "REVIEW_INVALIDATED",
  REOPEN_REVIEW: "REOPEN_REVIEW",
  PLAN_ACTION: "PLAN_ACTION",
  BEGIN_EXECUTION: "BEGIN_EXECUTION",
  WORKSPACE_PROVISIONED: "WORKSPACE_PROVISIONED",
  PREFLIGHT_PASSED: "PREFLIGHT_PASSED",
  EXECUTOR_STARTED: "EXECUTOR_STARTED",
  EXECUTOR_TERMINAL: "EXECUTOR_TERMINAL",
  EXECUTION_SUCCEEDED: "EXECUTION_SUCCEEDED",
  BEGIN_CODE_REVIEW: "BEGIN_CODE_REVIEW",
  CODE_REVIEW_STARTED: "CODE_REVIEW_STARTED",
  CODE_REVIEW_PASSED: "CODE_REVIEW_PASSED",
  CODE_CHANGES_REQUESTED: "CODE_CHANGES_REQUESTED",
  CODE_REVIEW_NEEDS_HUMAN: "CODE_REVIEW_NEEDS_HUMAN",
  ACCEPT_IMPLEMENTATION: "ACCEPT_IMPLEMENTATION",
  EXECUTION_RETRYABLE: "EXECUTION_RETRYABLE",
  EXECUTION_NEEDS_HUMAN: "EXECUTION_NEEDS_HUMAN",
  EXECUTION_FAILED: "EXECUTION_FAILED",
  CANCELLATION_CONFIRMED: "CANCELLATION_CONFIRMED",
  REQUIRE_HUMAN: "REQUIRE_HUMAN",
  IGNORE: "IGNORE",
  RETRY: "RETRY",
  RETRY_READY: "RETRY_READY",
  FAIL: "FAIL",
} as const;

export type MastermindEvent =
  | { type: typeof MastermindEventType.CLAIM }
  | { type: typeof MastermindEventType.DECIDE }
  | { type: typeof MastermindEventType.REVIEW }
  | { type: typeof MastermindEventType.REVIEW_GENERATED }
  | { type: typeof MastermindEventType.REVIEW_APPLIED }
  | { type: typeof MastermindEventType.REVIEW_INVALIDATED }
  | { type: typeof MastermindEventType.REOPEN_REVIEW }
  | { type: typeof MastermindEventType.PLAN_ACTION }
  | { type: typeof MastermindEventType.BEGIN_EXECUTION }
  | { type: typeof MastermindEventType.WORKSPACE_PROVISIONED }
  | { type: typeof MastermindEventType.PREFLIGHT_PASSED }
  | { type: typeof MastermindEventType.EXECUTOR_STARTED }
  | { type: typeof MastermindEventType.EXECUTOR_TERMINAL }
  | { type: typeof MastermindEventType.EXECUTION_SUCCEEDED }
  | { type: typeof MastermindEventType.BEGIN_CODE_REVIEW }
  | { type: typeof MastermindEventType.CODE_REVIEW_STARTED }
  | { type: typeof MastermindEventType.CODE_REVIEW_PASSED }
  | { type: typeof MastermindEventType.CODE_CHANGES_REQUESTED }
  | { type: typeof MastermindEventType.CODE_REVIEW_NEEDS_HUMAN }
  | { type: typeof MastermindEventType.ACCEPT_IMPLEMENTATION }
  | { type: typeof MastermindEventType.EXECUTION_RETRYABLE }
  | { type: typeof MastermindEventType.EXECUTION_NEEDS_HUMAN }
  | { type: typeof MastermindEventType.EXECUTION_FAILED }
  | { type: typeof MastermindEventType.CANCELLATION_CONFIRMED }
  | { type: typeof MastermindEventType.REQUIRE_HUMAN }
  | { type: typeof MastermindEventType.IGNORE }
  | { type: typeof MastermindEventType.RETRY }
  | { type: typeof MastermindEventType.RETRY_READY }
  | { type: typeof MastermindEventType.FAIL };
