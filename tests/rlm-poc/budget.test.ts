import { describe, expect, it } from "vitest";
import {
  claimRlmExecutionBudget,
  createRlmExecutionBudget,
  snapshotRlmExecutionBudget,
} from "../../src/rlm-poc/budget.js";
import { RlmCallBudgetExceededError } from "../../src/rlm-poc/contracts.js";

describe("RLM execution budget", () => {
  it("claims synchronously and fails closed at the configured maximum", () => {
    const budget = createRlmExecutionBudget(2);

    expect(claimRlmExecutionBudget(budget)).toEqual({
      maxCalls: 2,
      usedCalls: 1,
      remainingCalls: 1,
    });
    expect(claimRlmExecutionBudget(budget)).toEqual({
      maxCalls: 2,
      usedCalls: 2,
      remainingCalls: 0,
    });
    expect(() => claimRlmExecutionBudget(budget)).toThrow(RlmCallBudgetExceededError);
    expect(snapshotRlmExecutionBudget(budget).usedCalls).toBe(2);
  });

  it("rejects invalid maximums", () => {
    expect(() => createRlmExecutionBudget(0)).toThrow(/positive integer/iu);
    expect(() => createRlmExecutionBudget(1.5)).toThrow(/positive integer/iu);
  });
});
