import { describe, expect, it } from "vitest";
import {
  OPPORTUNITY_SCORE_DIMENSIONS,
  averageOpportunityScoreVector,
  opportunityScoreDiagnostics,
  opportunityScoreDistance,
  opportunityScorePrototype,
  opportunityScoreToScalar,
  opportunityScoreTypicality,
  type OpportunityScoreVector,
} from "../../../src/macro-workflow/sourceToProject/opportunityGeometry.js";

describe("OpportunityScore geometry", () => {
  it("averages score vectors while preserving the five-dimensional shape", () => {
    const average = averageOpportunityScoreVector([
      { applicability: 0.2, impact: 0.4, confidence: 0.6, implementationCost: 0.8, risk: 1 },
      { applicability: 0.8, impact: 0.6, confidence: 0.4, implementationCost: 0.2, risk: 0 },
    ]);

    expect(Object.keys(average).sort()).toEqual([...OPPORTUNITY_SCORE_DIMENSIONS].sort());
    for (const dimension of OPPORTUNITY_SCORE_DIMENSIONS) {
      expect(Number.isFinite(average[dimension])).toBe(true);
    }
    expect(average).toEqual({
      applicability: 0.5,
      impact: 0.5,
      confidence: 0.5,
      implementationCost: 0.5,
      risk: 0.5,
    });
  });

  it("calculates prototype, distance, typicality, and diagnostics for known vectors", () => {
    const zero = scoreVector(0);
    const one = scoreVector(1);
    const midpoint = scoreVector(0.25);
    const prototype = opportunityScorePrototype([zero, one]);

    expect(prototype).toEqual(scoreVector(0.5));
    expect(opportunityScoreDistance(zero, one)).toBeCloseTo(Math.sqrt(5), 12);
    expect(opportunityScoreTypicality(prototype, prototype)).toBe(1);
    expect(opportunityScoreTypicality(zero, one)).toBe(0);
    expect(opportunityScoreTypicality(scoreVector(-1), one)).toBe(0);
    expect(opportunityScoreTypicality(midpoint, prototype)).toBeCloseTo(0.75, 12);
    expect(opportunityScoreDiagnostics(midpoint, [zero, one])).toEqual({
      prototype,
      distance: opportunityScoreDistance(midpoint, prototype),
      typicality: opportunityScoreTypicality(midpoint, prototype),
    });
  });

  it("fails fast when averaging an empty score vector list", () => {
    expect(() => averageOpportunityScoreVector([])).toThrow(RangeError);
    expect(() => opportunityScorePrototype([])).toThrow("at least one OpportunityScore vector");
  });

  it("preserves scalar adapter parity with the legacy quality formula", () => {
    const canonical = {
      applicability: 0.9,
      impact: 0.7,
      confidence: 0.95,
      implementationCost: 0.3,
      risk: 0.1,
    };

    expect(opportunityScoreToScalar(canonical, 0.8, 0.05)).toBeCloseTo(legacyScalar(canonical, 0.8, 0.05), 12);
    expect(opportunityScoreToScalar(scoreVector(0), 0, 0)).toBeCloseTo(legacyScalar(scoreVector(0), 0, 0), 12);
    expect(opportunityScoreToScalar(scoreVector(1), 1, 0.2)).toBeCloseTo(legacyScalar(scoreVector(1), 1, 0.2), 12);
  });
});

function scoreVector(value: number): OpportunityScoreVector {
  return {
    applicability: value,
    impact: value,
    confidence: value,
    implementationCost: value,
    risk: value,
  };
}

function legacyScalar(
  score: OpportunityScoreVector,
  sourceCoreFit: number,
  metaInfrastructurePenalty: number,
): number {
  return (score.impact * 0.34) +
    (score.applicability * 0.24) +
    (score.confidence * 0.24) +
    (sourceCoreFit * 0.24) -
    (score.implementationCost * 0.12) -
    (score.risk * 0.18) -
    metaInfrastructurePenalty;
}
