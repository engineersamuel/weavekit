import type { SourceToProjectThresholds } from "../../config.js";
import type { OpportunityCouncilReview } from "../../generated/baml_client/index.js";

export type SourceToProjectIssueCode =
  | "missing-citation"
  | "missing-rival-hypotheses"
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
  const blockingIssues: SourceToProjectIssue[] = [];

  for (const opportunity of review.opportunities) {
    if (!opportunityHasRequiredEvidence(opportunity)) {
      blockingIssues.push({
        code: "missing-citation",
        message: `Opportunity ${opportunity.id} lacks required evidence.`,
        opportunityId: opportunity.id,
      });
    }

    const meetsPromotionThresholds = opportunityMeetsPromotionThresholds(opportunity, thresholds);
    if (!meetsPromotionThresholds) {
      blockingIssues.push({
        code: "below-opportunity-threshold",
        message: `Opportunity ${opportunity.id} does not meet promotion thresholds.`,
        opportunityId: opportunity.id,
      });
    }
  }

  const advisoryIssues = selectPromotedOpportunitiesForAdvisory(
    review,
    thresholds,
    maxOpportunities,
  ).flatMap((opportunity) => {
    return opportunity.rivalExplanationsConsidered?.some((rival) => rival.trim())
      ? []
      : [
          {
            code: "missing-rival-hypotheses",
            message: `Opportunity ${opportunity.id} lacks meaningful rival hypotheses.`,
            opportunityId: opportunity.id,
          } satisfies SourceToProjectIssue,
        ];
  });

  return {
    valid: blockingIssues.length === 0,
    issues: [...blockingIssues, ...advisoryIssues],
  };
}

function selectPromotedOpportunitiesForAdvisory(
  review: OpportunityCouncilReview,
  thresholds: SourceToProjectThresholds,
  maxOpportunities: number,
): OpportunityCouncilReview["opportunities"] {
  const rankedPromotable = review.opportunities
    .filter(
      (opportunity) =>
        opportunityHasRequiredEvidence(opportunity) &&
        opportunityMeetsPromotionThresholds(opportunity, thresholds),
    )
    .sort(
      (left, right) => opportunityAcceptanceAverage(right) - opportunityAcceptanceAverage(left),
    );

  return maxOpportunities > 0 ? rankedPromotable.slice(0, maxOpportunities) : rankedPromotable;
}

function opportunityHasRequiredEvidence(
  opportunity: OpportunityCouncilReview["opportunities"][number],
): boolean {
  return opportunity.evidence.length > 0 && !opportunity.speculative;
}

function opportunityMeetsPromotionThresholds(
  opportunity: OpportunityCouncilReview["opportunities"][number],
  thresholds: SourceToProjectThresholds,
): boolean {
  return (
    opportunityAcceptanceAverage(opportunity) >= thresholds.minAcceptanceAverage &&
    opportunity.score.risk <= thresholds.maxRisk
  );
}

function opportunityAcceptanceAverage(
  opportunity: OpportunityCouncilReview["opportunities"][number],
): number {
  return (
    (opportunity.score.applicability + opportunity.score.impact + opportunity.score.confidence) / 3
  );
}

export function verifyBundles(review: OpportunityCouncilReview): SourceToProjectVerificationResult {
  const issues = review.bundles.flatMap((bundle) => {
    const valid =
      bundle.rationale.trim() &&
      bundle.sharedChangeSurface.trim() &&
      bundle.combinedUserValue.trim() &&
      bundle.separationRisk.trim() &&
      bundle.maxPrScope.trim() &&
      bundle.opportunityIds.length > 1;

    return valid
      ? []
      : [
          {
            code: "invalid-bundle" as const,
            message: `Bundle ${bundle.id} does not satisfy the bundle contract.`,
            bundleId: bundle.id,
          },
        ];
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
