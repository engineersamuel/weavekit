export type BudgetGateOutcome = "allow" | "warn" | "block";

export type BudgetGateConfig = {
  enabled: boolean;
  mode: "warn" | "block";
  ceilingUsd: number;
  marginFactor: number;
  tokenCeiling?: number;
};

export type BudgetGateProjection = {
  projectedCostUsd?: number;
  projectedTokens: number;
  unpricedModels: string[];
};

export type BudgetGateOverride = {
  reason?: string;
};

export type BudgetGateDecision = BudgetGateProjection & {
  outcome: BudgetGateOutcome;
  effectiveProjectionUsd?: number;
  ceilingUsd: number;
  marginFactor: number;
  overCeiling: boolean;
  overrideApplied: boolean;
  reason: string;
};

export type PreRunGateInput = {
  projection?: BudgetGateProjection;
  config?: BudgetGateConfig;
  override?: BudgetGateOverride;
};

export type PreRunGate = (
  input?: PreRunGateInput,
) => Promise<BudgetGateDecision> | BudgetGateDecision;

type GateTrigger = {
  overCeiling: boolean;
  reason: string;
};

export class BudgetGateBlockedError extends Error {
  readonly decision: BudgetGateDecision;

  constructor(decision: BudgetGateDecision) {
    super(`Budget gate blocked pre-run workflow: ${decision.reason}`);
    this.name = "BudgetGateBlockedError";
    this.decision = decision;
  }
}

export function defaultBudgetGateAuditLogPath(): string {
  return join(homedir(), ".weavekit", "budget-gate-audit.jsonl");
}

export async function appendBudgetGateAuditLog(args: {
  decision: BudgetGateDecision;
  path?: string;
  runId?: string;
  nodeId?: string;
  projectId?: string;
  opportunityId?: string;
  source?: string;
  workflowPath: string;
  timestamp?: Date;
}): Promise<void> {
  const path = args.path ?? defaultBudgetGateAuditLogPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `${JSON.stringify({
      timestamp: (args.timestamp ?? new Date()).toISOString(),
      workflowPath: args.workflowPath,
      runId: args.runId,
      nodeId: args.nodeId,
      projectId: args.projectId,
      opportunityId: args.opportunityId,
      source: args.source,
      outcome: args.decision.outcome,
      overrideApplied: args.decision.overrideApplied,
      reason: args.decision.reason,
      projectedCostUsd: args.decision.projectedCostUsd,
      effectiveProjectionUsd: args.decision.effectiveProjectionUsd,
      projectedTokens: args.decision.projectedTokens,
      ceilingUsd: args.decision.ceilingUsd,
      marginFactor: args.decision.marginFactor,
      unpricedModels: args.decision.unpricedModels,
    })}\n`,
    "utf8",
  );
}

export function evaluateBudgetGate(
  projection: BudgetGateProjection,
  config: BudgetGateConfig,
  override?: BudgetGateOverride,
): BudgetGateDecision {
  const effectiveProjectionUsd =
    projection.projectedCostUsd === undefined
      ? undefined
      : roundCurrencyProjection(projection.projectedCostUsd * config.marginFactor);
  const trigger = selectGateTrigger(projection, config, effectiveProjectionUsd);
  const baseDecision = buildDecision({
    projection,
    config,
    effectiveProjectionUsd,
    outcome: config.enabled ? triggerOutcome(config, trigger) : "allow",
    overCeiling: trigger.overCeiling,
    overrideApplied: false,
    reason: config.enabled ? trigger.reason : "budget gate disabled",
  });

  if (baseDecision.outcome !== "block") {
    return baseDecision;
  }

  const overrideReason = override?.reason?.trim();
  if (!overrideReason) {
    return baseDecision;
  }

  return {
    ...baseDecision,
    outcome: "allow",
    overrideApplied: true,
    reason: `budget gate override applied: ${overrideReason}; original decision: ${baseDecision.reason}`,
  };
}

function selectGateTrigger(
  projection: BudgetGateProjection,
  config: BudgetGateConfig,
  effectiveProjectionUsd: number | undefined,
): GateTrigger {
  if (effectiveProjectionUsd !== undefined && effectiveProjectionUsd > config.ceilingUsd) {
    return {
      overCeiling: true,
      reason: `effective projected cost ${formatUsd(effectiveProjectionUsd)} exceeds budget ceiling ${formatUsd(config.ceilingUsd)}`,
    };
  }

  if (config.tokenCeiling !== undefined && projection.projectedTokens > config.tokenCeiling) {
    return {
      overCeiling: true,
      reason: `projected tokens ${formatInteger(projection.projectedTokens)} exceed token ceiling ${formatInteger(config.tokenCeiling)}`,
    };
  }

  if (projection.unpricedModels.length > 0) {
    return {
      overCeiling: false,
      reason: `price projection incomplete for unpriced models: ${projection.unpricedModels.join(", ")}`,
    };
  }

  return {
    overCeiling: false,
    reason: "projection within budget",
  };
}

function triggerOutcome(config: BudgetGateConfig, trigger: GateTrigger): BudgetGateOutcome {
  if (!trigger.overCeiling && !trigger.reason.startsWith("price projection incomplete")) {
    return "allow";
  }
  return config.mode;
}

function buildDecision(args: {
  projection: BudgetGateProjection;
  config: BudgetGateConfig;
  effectiveProjectionUsd: number | undefined;
  outcome: BudgetGateOutcome;
  overCeiling: boolean;
  overrideApplied: boolean;
  reason: string;
}): BudgetGateDecision {
  return {
    projectedCostUsd: args.projection.projectedCostUsd,
    projectedTokens: args.projection.projectedTokens,
    unpricedModels: args.projection.unpricedModels,
    effectiveProjectionUsd: args.effectiveProjectionUsd,
    ceilingUsd: args.config.ceilingUsd,
    marginFactor: args.config.marginFactor,
    outcome: args.outcome,
    overCeiling: args.overCeiling,
    overrideApplied: args.overrideApplied,
    reason: args.reason,
  };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function roundCurrencyProjection(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
import { mkdir, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
