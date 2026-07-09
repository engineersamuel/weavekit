import { describe, expect, it } from "vitest";
import { b } from "../../../src/generated/baml_client/index.js";

describe("source-to-project final recommendation parser", () => {
  it("accepts null telegramSummary and lets the harness provide a fallback", () => {
    const review = b.parse.ReviewFinalRecommendation(
      JSON.stringify({
        status: "accepted",
        actionable: true,
        improvesProject: true,
        unnecessaryComplexity: false,
        benefitOutweighsCost: true,
        complexityAssessment: "The recommendation is bounded.",
        rationale: "It improves the project without unnecessary complexity.",
        rejectionReason: null,
        telegramSummary: null,
      }),
    );

    expect(review.telegramSummary).toBeNull();
  });
});
