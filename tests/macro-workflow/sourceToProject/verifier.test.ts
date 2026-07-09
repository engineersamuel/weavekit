import { describe, expect, it } from "vitest";
import {
  verifyBundles,
  verifyOpportunityPromotion,
} from "../../../src/macro-workflow/sourceToProject/verifier.js";

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
            score: {
              applicability: 0.9,
              impact: 0.8,
              confidence: 0.9,
              implementationCost: 0.4,
              risk: 0.3,
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
            score: {
              applicability: 0.2,
              impact: 0.7,
              confidence: 0.9,
              implementationCost: 0.4,
              risk: 0.3,
            },
            evidence: [{ id: "e1", source: "https://example.com", quote: "Evidence" }],
            speculative: false,
          },
        ],
        nonApplicableLessons: [],
        bundles: [],
        rankingRationale: "Ranked by impact",
      },
      {
        minApplicability: 0.7,
        minConfidence: 0.65,
        minImpact: 0.5,
        minAcceptanceAverage: 0.85,
        maxRisk: 0.8,
      },
      2,
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "missing-citation",
      "below-opportunity-threshold",
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
