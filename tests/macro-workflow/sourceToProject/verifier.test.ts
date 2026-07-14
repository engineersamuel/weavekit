import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Opportunity } from "../../../src/generated/baml_client/index.js";
import {
  verifyBundles,
  verifyOpportunityPromotion,
} from "../../../src/macro-workflow/sourceToProject/verifier.js";

const promotionThresholds = {
  minApplicability: 0.7,
  minConfidence: 0.65,
  minImpact: 0.5,
  minAcceptanceAverage: 0.85,
  maxRisk: 0.8,
};

const opportunityWithReasoningArtifacts = readOpportunityFixture(
  "opportunity-with-reasoning-artifacts.json",
);
const opportunityWithoutReasoningArtifacts = readOpportunityFixture(
  "opportunity-without-reasoning-artifacts.json",
);

describe("source-to-project semantic verifier", () => {
  it("rejects opportunities without evidence or below threshold", () => {
    const result = verifyOpportunityPromotion(
      {
        opportunities: [
          {
            id: "opp-1",
            title: "Adopt pattern",
            lesson: "Use the pattern",
            projectChange: "Change the workflow",
            changeSurface: "src/workflow",
            practiceIds: ["practice-pattern"],
            behaviorIds: ["practice-pattern/behavior-1"],
            targetLayers: ["workflow"],
            proofIds: ["practice-pattern/proof-1"],
            score: {
              applicability: 0.9,
              applicabilityReasoning: "Test fixture reasoning for applicability score 0.9.",
              impact: 0.8,
              impactReasoning: "Test fixture reasoning for impact score 0.8.",
              confidence: 0.9,
              confidenceReasoning: "Test fixture reasoning for confidence score 0.9.",
              implementationCost: 0.4,
              implementationCostReasoning:
                "Test fixture reasoning for implementation cost score 0.4.",
              risk: 0.3,
              riskReasoning: "Test fixture reasoning for risk score 0.3.",
            },
            evidence: [],
            speculative: false,
          },
          {
            id: "opp-2",
            title: "Weak pattern",
            lesson: "Weak lesson",
            projectChange: "Risky change",
            changeSurface: "src/other",
            practiceIds: ["practice-weak-pattern"],
            behaviorIds: ["practice-weak-pattern/behavior-1"],
            targetLayers: ["other"],
            proofIds: ["practice-weak-pattern/proof-1"],
            score: {
              applicability: 0.2,
              applicabilityReasoning: "Test fixture reasoning for applicability score 0.2.",
              impact: 0.7,
              impactReasoning: "Test fixture reasoning for impact score 0.7.",
              confidence: 0.9,
              confidenceReasoning: "Test fixture reasoning for confidence score 0.9.",
              implementationCost: 0.4,
              implementationCostReasoning:
                "Test fixture reasoning for implementation cost score 0.4.",
              risk: 0.3,
              riskReasoning: "Test fixture reasoning for risk score 0.3.",
            },
            evidence: [{ id: "e1", source: "https://example.com", quote: "Evidence" }],
            speculative: false,
          },
        ],
        nonApplicableLessons: [],
        bundles: [],
        rankingRationale: "Ranked by impact",
      },
      promotionThresholds,
      2,
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "missing-citation",
      "below-opportunity-threshold",
    ]);
  });

  it.each([
    ["omitted", opportunityWithoutReasoningArtifacts],
    ["empty", { ...opportunityWithoutReasoningArtifacts, rivalExplanationsConsidered: [] }],
    [
      "whitespace-only",
      { ...opportunityWithoutReasoningArtifacts, rivalExplanationsConsidered: ["  ", "\t"] },
    ],
  ])("reports omitted, empty, or whitespace-only rivals as advisory (%s)", (_, opportunity) => {
    const result = verifyOpportunityPromotion(
      {
        opportunities: [opportunity],
        nonApplicableLessons: [],
        bundles: [],
        rankingRationale: "Promote the evidence-backed opportunity.",
      },
      promotionThresholds,
      1,
    );

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([
      {
        code: "missing-rival-hypotheses",
        message: `Opportunity ${opportunity.id} lacks meaningful rival hypotheses.`,
        opportunityId: opportunity.id,
      },
    ]);
  });

  it("treats a zero opportunity cap as unlimited advisory evaluation", () => {
    const result = verifyOpportunityPromotion(
      {
        opportunities: [opportunityWithoutReasoningArtifacts],
        nonApplicableLessons: [],
        bundles: [],
        rankingRationale: "Promote every accepted opportunity.",
      },
      promotionThresholds,
      0,
    );

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([
      {
        code: "missing-rival-hypotheses",
        message: "Opportunity opp-without-reasoning-artifacts lacks meaningful rival hypotheses.",
        opportunityId: "opp-without-reasoning-artifacts",
      },
    ]);
  });

  it("applies a positive advisory cap after ranking promotable opportunities", () => {
    const lowerRankedWithRivals = {
      ...opportunityWithReasoningArtifacts,
      id: "opp-lower-ranked",
      score: {
        ...opportunityWithReasoningArtifacts.score,
        applicability: 0.86,
        impact: 0.86,
        confidence: 0.86,
      },
    };
    const higherRankedWithoutRivals = {
      ...opportunityWithoutReasoningArtifacts,
      id: "opp-higher-ranked",
      score: {
        ...opportunityWithoutReasoningArtifacts.score,
        applicability: 0.95,
        impact: 0.95,
        confidence: 0.95,
      },
    };
    const result = verifyOpportunityPromotion(
      {
        opportunities: [lowerRankedWithRivals, higherRankedWithoutRivals],
        nonApplicableLessons: [],
        bundles: [],
        rankingRationale: "Promote the highest acceptance average first.",
      },
      promotionThresholds,
      1,
    );

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([
      {
        code: "missing-rival-hypotheses",
        message: "Opportunity opp-higher-ranked lacks meaningful rival hypotheses.",
        opportunityId: "opp-higher-ranked",
      },
    ]);
  });

  it("reports blocking issues and ranked advisories together in deterministic order", () => {
    const blockingOpportunity = {
      ...opportunityWithoutReasoningArtifacts,
      id: "opp-missing-evidence",
      evidence: [],
    };
    const promotedAdvisoryOpportunity = {
      ...opportunityWithoutReasoningArtifacts,
      id: "opp-promoted-advisory",
    };
    const result = verifyOpportunityPromotion(
      {
        opportunities: [blockingOpportunity, promotedAdvisoryOpportunity],
        nonApplicableLessons: [],
        bundles: [],
        rankingRationale: "Validate every opportunity before promotion.",
      },
      promotionThresholds,
      1,
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      {
        code: "missing-citation",
        message: "Opportunity opp-missing-evidence lacks required evidence.",
        opportunityId: "opp-missing-evidence",
      },
      {
        code: "missing-rival-hypotheses",
        message: "Opportunity opp-promoted-advisory lacks meaningful rival hypotheses.",
        opportunityId: "opp-promoted-advisory",
      },
    ]);
  });

  it("does not report the advisory when a meaningful rival explanation exists", () => {
    const opportunityWithMixedRivals = {
      ...opportunityWithReasoningArtifacts,
      rivalExplanationsConsidered: [
        "  ",
        ...opportunityWithReasoningArtifacts.rivalExplanationsConsidered!,
      ],
    };
    const result = verifyOpportunityPromotion(
      {
        opportunities: [opportunityWithMixedRivals],
        nonApplicableLessons: [],
        bundles: [],
        rankingRationale: "Promote the evidence-backed opportunity.",
      },
      promotionThresholds,
      1,
    );

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("treats exact acceptance-average and risk thresholds as promotable", () => {
    const opportunityAtThresholds = {
      ...opportunityWithoutReasoningArtifacts,
      id: "opp-at-thresholds",
      score: {
        ...opportunityWithoutReasoningArtifacts.score,
        applicability: 0.85,
        impact: 0.85,
        confidence: 0.85,
        risk: 0.8,
      },
    };
    const result = verifyOpportunityPromotion(
      {
        opportunities: [opportunityAtThresholds],
        nonApplicableLessons: [],
        bundles: [],
        rankingRationale: "Promote opportunities at the configured boundaries.",
      },
      promotionThresholds,
      1,
    );

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([
      {
        code: "missing-rival-hypotheses",
        message: "Opportunity opp-at-thresholds lacks meaningful rival hypotheses.",
        opportunityId: "opp-at-thresholds",
      },
    ]);
  });

  it("does not report the advisory for a speculative opportunity", () => {
    const speculativeOpportunity = {
      ...opportunityWithoutReasoningArtifacts,
      id: "opp-speculative",
      speculative: true,
    };
    const result = verifyOpportunityPromotion(
      {
        opportunities: [speculativeOpportunity],
        nonApplicableLessons: [],
        bundles: [],
        rankingRationale: "Do not promote speculative opportunities.",
      },
      promotionThresholds,
      1,
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      {
        code: "missing-citation",
        message: "Opportunity opp-speculative lacks required evidence.",
        opportunityId: "opp-speculative",
      },
    ]);
  });

  it.each([
    [
      "acceptance average just below the minimum",
      { applicability: 0.849, impact: 0.85, confidence: 0.85, risk: 0.8 },
    ],
    [
      "risk just above the maximum",
      { applicability: 0.85, impact: 0.85, confidence: 0.85, risk: 0.801 },
    ],
  ])("does not report the advisory when %s", (_, scoreOverrides) => {
    const belowThresholdOpportunity = {
      ...opportunityWithoutReasoningArtifacts,
      id: "opp-below-threshold",
      score: {
        ...opportunityWithoutReasoningArtifacts.score,
        ...scoreOverrides,
      },
    };
    const result = verifyOpportunityPromotion(
      {
        opportunities: [belowThresholdOpportunity],
        nonApplicableLessons: [],
        bundles: [],
        rankingRationale: "Do not promote weak opportunities.",
      },
      promotionThresholds,
      1,
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      {
        code: "below-opportunity-threshold",
        message: "Opportunity opp-below-threshold does not meet promotion thresholds.",
        opportunityId: "opp-below-threshold",
      },
    ]);
  });

  it("rejects weak automatic bundles", () => {
    const result = verifyBundles({
      opportunities: [],
      nonApplicableLessons: [],
      rankingRationale: "Grouped",
      bundles: [
        {
          id: "bundle-1",
          opportunityIds: ["opp-1", "opp-2"],
          practiceIds: ["practice-pattern"],
          behaviorIds: ["practice-pattern/behavior-1"],
          targetLayers: ["workflow"],
          proofIds: ["practice-pattern/proof-1"],
          rationale: "",
          sharedChangeSurface: "src/workflow",
          combinedUserValue: "Better workflow",
          separationRisk: "",
          maxPrScope: "One PR",
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe("invalid-bundle");
  });
});

function readOpportunityFixture(filename: string): Opportunity {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/source-to-project/${filename}`, import.meta.url), "utf8"),
  ) as Opportunity;
}
