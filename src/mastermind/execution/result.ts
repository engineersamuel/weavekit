import type {
  DirectExecutionResult,
  ExecutorStatus,
  VerificationEvidence,
} from "../../submind/contracts.js";
import { MastermindEventType, MastermindState } from "../domain/events.js";

export type NormalizedExecutionOutcome = {
  state:
    | typeof MastermindState.SUCCEEDED
    | typeof MastermindState.RETRY_WAIT
    | typeof MastermindState.NEEDS_HUMAN
    | typeof MastermindState.FAILED;
  eventType:
    | typeof MastermindEventType.EXECUTION_SUCCEEDED
    | typeof MastermindEventType.EXECUTION_RETRYABLE
    | typeof MastermindEventType.EXECUTION_NEEDS_HUMAN
    | typeof MastermindEventType.EXECUTION_FAILED;
  retryEligible: boolean;
  failureClass?: string;
  failureMessage?: string;
};

export function normalizeExecutionOutcome(input: {
  status: ExecutorStatus;
  result: DirectExecutionResult;
  verification: VerificationEvidence;
  attemptNumber: number;
  maxAttempts: number;
}): NormalizedExecutionOutcome {
  if (input.status.state !== "idle" && input.status.state !== "done") {
    return needsHuman("NONTERMINAL_COLLECTION", "Executor was not terminal during collection.");
  }
  if (input.result.outcome === "succeeded") {
    if (!input.verification.passed || input.verification.commands.length === 0) {
      return needsHuman(
        "VERIFICATION_MISSING",
        "Execution reported success without independent passing verification.",
      );
    }
    return {
      state: MastermindState.SUCCEEDED,
      eventType: MastermindEventType.EXECUTION_SUCCEEDED,
      retryEligible: false,
    };
  }
  if (input.result.outcome === "retryable-failure") {
    if (input.attemptNumber < input.maxAttempts) {
      return {
        state: MastermindState.RETRY_WAIT,
        eventType: MastermindEventType.EXECUTION_RETRYABLE,
        retryEligible: true,
        failureClass: "RETRYABLE_EXECUTION",
        failureMessage: input.result.summary,
      };
    }
    return needsHuman(
      "EXECUTION_RETRIES_EXHAUSTED",
      `Execution exhausted ${input.maxAttempts} attempts.`,
    );
  }
  if (input.result.outcome === "terminal-failure") {
    return {
      state: MastermindState.FAILED,
      eventType: MastermindEventType.EXECUTION_FAILED,
      retryEligible: false,
      failureClass: "TERMINAL_EXECUTION",
      failureMessage: input.result.summary,
    };
  }
  return needsHuman("EXECUTION_NEEDS_HUMAN", input.result.summary);
}

export function needsHuman(
  failureClass: string,
  failureMessage: string,
): NormalizedExecutionOutcome {
  return {
    state: MastermindState.NEEDS_HUMAN,
    eventType: MastermindEventType.EXECUTION_NEEDS_HUMAN,
    retryEligible: false,
    failureClass,
    failureMessage,
  };
}
