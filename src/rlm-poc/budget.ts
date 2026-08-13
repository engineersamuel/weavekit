import { RlmCallBudgetExceededError } from "./contracts.js";

export const DEFAULT_RLM_MAX_TOTAL_CALLS = 12;

export type RlmExecutionBudget = {
  readonly maxCalls: number;
  usedCalls: number;
};

export type RlmExecutionBudgetSnapshot = {
  maxCalls: number;
  usedCalls: number;
  remainingCalls: number;
};

export function createRlmExecutionBudget(maxCalls: number): RlmExecutionBudget {
  if (!Number.isInteger(maxCalls) || maxCalls <= 0) {
    throw new Error(`RLM maxTotalCalls must be a positive integer; received ${maxCalls}.`);
  }
  return { maxCalls, usedCalls: 0 };
}

export function snapshotRlmExecutionBudget(budget: RlmExecutionBudget): RlmExecutionBudgetSnapshot {
  return {
    maxCalls: budget.maxCalls,
    usedCalls: budget.usedCalls,
    remainingCalls: Math.max(0, budget.maxCalls - budget.usedCalls),
  };
}

/** Synchronous by design: concurrent sibling handlers cannot pass the check before incrementing. */
export function claimRlmExecutionBudget(budget: RlmExecutionBudget): RlmExecutionBudgetSnapshot {
  if (budget.usedCalls >= budget.maxCalls) {
    throw new RlmCallBudgetExceededError(budget.maxCalls);
  }
  budget.usedCalls += 1;
  return snapshotRlmExecutionBudget(budget);
}
