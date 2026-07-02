import type { SourceToProjectThresholds } from "../../config.js";
import type { OpportunityCouncilReview } from "../../generated/baml_client/index.js";

export type SourceToProjectIssueCode =
  | "missing-citation"
  | "below-opportunity-threshold"
  | "invalid-bundle"
  | "autonomous-pr-disabled"
  | "missing-worktree-preflight";

export type SourceToProjectIssue = {
  code: SourceToProjectIssueCode;
  message: string;
  opportunityId?: string;
  bundleId?: string;
};

export type SourceToProjectVerificationResult = {
  valid: boolean;
  issues: SourceToProjectIssue[];
};

export function verifyOpportunityPromotion(
  review: OpportunityCouncilReview,
  thresholds: SourceToProjectThresholds,
  maxOpportunities: number,
): SourceToProjectVerificationResult {
  const issues: SourceToProjectIssue[] = [];

  for (const opportunity of review.opportunities.slice(0, maxOpportunities)) {
    if (opportunity.evidence.length === 0 || opportunity.speculative) {
      issues.push({
        code: "missing-citation",
        message: `Opportunity ${opportunity.id} lacks required evidence.`,
        opportunityId: opportunity.id,
      });
    }

    const acceptanceAverage = (opportunity.score.applicability + opportunity.score.impact + opportunity.score.confidence) / 3;
    if (acceptanceAverage < thresholds.minAcceptanceAverage || opportunity.score.risk > thresholds.maxRisk) {
      issues.push({
        code: "below-opportunity-threshold",
        message: `Opportunity ${opportunity.id} does not meet promotion thresholds.`,
        opportunityId: opportunity.id,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

export function verifyBundles(review: OpportunityCouncilReview): SourceToProjectVerificationResult {
  const issues = review.bundles.flatMap((bundle) => {
    const valid = bundle.rationale.trim() &&
      bundle.sharedChangeSurface.trim() &&
      bundle.combinedUserValue.trim() &&
      bundle.separationRisk.trim() &&
      bundle.maxPrScope.trim() &&
      bundle.opportunityIds.length > 1;

    return valid
      ? []
      : [{
        code: "invalid-bundle" as const,
        message: `Bundle ${bundle.id} does not satisfy the bundle contract.`,
        bundleId: bundle.id,
      }];
  });

  return { valid: issues.length === 0, issues };
}

export function verifyAutonomousSafety(args: {
  autonomousPrAllowed: boolean;
  worktreePrepared: boolean;
}): SourceToProjectVerificationResult {
  const issues: SourceToProjectIssue[] = [];

  if (!args.autonomousPrAllowed) {
    issues.push({
      code: "autonomous-pr-disabled",
      message: "Autonomous PR mode is disabled for this Target project.",
    });
  }

  if (!args.worktreePrepared) {
    issues.push({
      code: "missing-worktree-preflight",
      message: "Worktree preparation must complete before Autonomous PR mode can modify files.",
    });
  }

  return { valid: issues.length === 0, issues };
}
