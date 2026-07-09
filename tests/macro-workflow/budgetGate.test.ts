import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendBudgetGateAuditLog,
  BudgetGateBlockedError,
  defaultBudgetGateAuditLogPath,
  evaluateBudgetGate,
  type BudgetGateConfig,
  type BudgetGateProjection,
} from "../../src/macro-workflow/budgetGate.js";

const baseConfig: BudgetGateConfig = {
  enabled: true,
  mode: "block",
  ceilingUsd: 10,
  marginFactor: 1.2,
};

const baseProjection: BudgetGateProjection = {
  projectedCostUsd: 5,
  projectedTokens: 1000,
  unpricedModels: [],
};

describe("budget gate", () => {
  it("allows all projections when the gate is disabled", () => {
    const decision = evaluateBudgetGate(
      {
        projectedCostUsd: 100,
        projectedTokens: 500_000,
        unpricedModels: ["unknown-model"],
      },
      { ...baseConfig, enabled: false, tokenCeiling: 1000 },
    );

    expect(decision).toMatchObject({
      outcome: "allow",
      effectiveProjectionUsd: 120,
      overCeiling: true,
      overrideApplied: false,
      reason: "budget gate disabled",
    });
  });

  it("warns when the effective projected cost exceeds the ceiling in warn mode", () => {
    const decision = evaluateBudgetGate(
      { ...baseProjection, projectedCostUsd: 9 },
      { ...baseConfig, mode: "warn" },
    );

    expect(decision).toMatchObject({
      outcome: "warn",
      projectedCostUsd: 9,
      effectiveProjectionUsd: 10.8,
      ceilingUsd: 10,
      marginFactor: 1.2,
      overCeiling: true,
      reason: "effective projected cost $10.80 exceeds budget ceiling $10.00",
    });
  });

  it("blocks when the effective projected cost exceeds the ceiling in block mode", () => {
    const decision = evaluateBudgetGate(
      { ...baseProjection, projectedCostUsd: 9 },
      { ...baseConfig, mode: "block" },
    );

    expect(decision).toMatchObject({
      outcome: "block",
      overCeiling: true,
      overrideApplied: false,
    });
  });

  it("uses the configured mode when the projected tokens exceed the token ceiling", () => {
    expect(
      evaluateBudgetGate(baseProjection, {
        ...baseConfig,
        mode: "warn",
        tokenCeiling: 999,
      }),
    ).toMatchObject({
      outcome: "warn",
      overCeiling: true,
      reason: "projected tokens 1,000 exceed token ceiling 999",
    });

    expect(
      evaluateBudgetGate(baseProjection, {
        ...baseConfig,
        mode: "block",
        tokenCeiling: 999,
      }),
    ).toMatchObject({
      outcome: "block",
      overCeiling: true,
    });
  });

  it("fails safe for unpriced models in block mode when no complete price projection exists", () => {
    const decision = evaluateBudgetGate(
      {
        projectedTokens: 1000,
        unpricedModels: ["unknown-model"],
      },
      baseConfig,
    );

    expect(decision).toMatchObject({
      outcome: "block",
      projectedCostUsd: undefined,
      effectiveProjectionUsd: undefined,
      unpricedModels: ["unknown-model"],
      overCeiling: false,
      reason: "price projection incomplete for unpriced models: unknown-model",
    });
  });

  it("allows a would-be block when an override has a non-empty reason", () => {
    const decision = evaluateBudgetGate({ ...baseProjection, projectedCostUsd: 20 }, baseConfig, {
      reason: "approved for release validation",
    });

    expect(decision).toMatchObject({
      outcome: "allow",
      overCeiling: true,
      overrideApplied: true,
      reason:
        "budget gate override applied: approved for release validation; original decision: effective projected cost $24.00 exceeds budget ceiling $10.00",
    });
  });

  it("does not downgrade a block when the override reason is blank", () => {
    const decision = evaluateBudgetGate({ ...baseProjection, projectedCostUsd: 20 }, baseConfig, {
      reason: "   ",
    });

    expect(decision).toMatchObject({
      outcome: "block",
      overrideApplied: false,
    });
  });

  it("includes the blocking decision in BudgetGateBlockedError", () => {
    const decision = evaluateBudgetGate({ ...baseProjection, projectedCostUsd: 20 }, baseConfig);
    const error = new BudgetGateBlockedError(decision);

    expect(error.decision).toBe(decision);
    expect(error.message).toContain("Budget gate blocked pre-run workflow");
    expect(error.message).toContain(
      "effective projected cost $24.00 exceeds budget ceiling $10.00",
    );
  });

  it("defaults audit logging to a JSONL file under ~/.weavekit", () => {
    expect(defaultBudgetGateAuditLogPath()).toBe(
      join(homedir(), ".weavekit", "budget-gate-audit.jsonl"),
    );
  });

  it("appends durable audit JSONL records for budget gate decisions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-budget-gate-audit-"));
    const path = join(dir, "budget-gate-audit.jsonl");
    const decision = evaluateBudgetGate({ ...baseProjection, projectedCostUsd: 20 }, baseConfig, {
      reason: "approved for release validation",
    });

    try {
      await appendBudgetGateAuditLog({
        path,
        decision,
        workflowPath: "template-optimizer",
        runId: "run-1",
        projectId: "weavekit",
        timestamp: new Date("2026-07-09T00:00:00.000Z"),
      });

      expect(JSON.parse((await readFile(path, "utf8")).trim())).toMatchObject({
        timestamp: "2026-07-09T00:00:00.000Z",
        workflowPath: "template-optimizer",
        runId: "run-1",
        projectId: "weavekit",
        outcome: "allow",
        overrideApplied: true,
        projectedCostUsd: 20,
        effectiveProjectionUsd: 24,
        ceilingUsd: 10,
        marginFactor: 1.2,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
