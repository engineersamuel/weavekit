import type { OpportunityScore } from "../../generated/baml_client/types.js";

export const OPPORTUNITY_SCORE_DIMENSIONS = [
  "applicability",
  "impact",
  "confidence",
  "implementationCost",
  "risk",
] as const satisfies readonly (keyof OpportunityScore)[];

type OpportunityScoreDimension = typeof OPPORTUNITY_SCORE_DIMENSIONS[number];

export type OpportunityScoreVector = Pick<OpportunityScore, OpportunityScoreDimension>;

export type OpportunityScoreDiagnostics = {
  prototype: OpportunityScoreVector;
  distance: number;
  typicality: number;
};

const MAX_OPPORTUNITY_SCORE_DISTANCE = Math.sqrt(OPPORTUNITY_SCORE_DIMENSIONS.length);

export function averageOpportunityScoreVector(vectors: readonly OpportunityScoreVector[]): OpportunityScoreVector {
  if (vectors.length === 0) {
    throw new RangeError("Expected at least one OpportunityScore vector.");
  }
  return {
    applicability: averageDimension(vectors, "applicability"),
    impact: averageDimension(vectors, "impact"),
    confidence: averageDimension(vectors, "confidence"),
    implementationCost: averageDimension(vectors, "implementationCost"),
    risk: averageDimension(vectors, "risk"),
  };
}

export function opportunityScorePrototype(vectors: readonly OpportunityScoreVector[]): OpportunityScoreVector {
  return averageOpportunityScoreVector(vectors);
}

export function opportunityScoreDistance(left: OpportunityScoreVector, right: OpportunityScoreVector): number {
  const squaredDistance = OPPORTUNITY_SCORE_DIMENSIONS.reduce(
    (sum, dimension) => sum + ((left[dimension] - right[dimension]) ** 2),
    0,
  );
  return Math.sqrt(squaredDistance);
}

export function opportunityScoreTypicality(vector: OpportunityScoreVector, prototype: OpportunityScoreVector): number {
  const typicality = 1 - (opportunityScoreDistance(vector, prototype) / MAX_OPPORTUNITY_SCORE_DISTANCE);
  return Math.min(1, Math.max(0, typicality));
}

export function opportunityScoreDiagnostics(
  vector: OpportunityScoreVector,
  prototypeVectors: readonly OpportunityScoreVector[],
): OpportunityScoreDiagnostics {
  const prototype = opportunityScorePrototype(prototypeVectors);
  const distance = opportunityScoreDistance(vector, prototype);
  return {
    prototype,
    distance,
    typicality: opportunityScoreTypicality(vector, prototype),
  };
}

export function opportunityScoreToScalar(
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

function averageDimension(vectors: readonly OpportunityScoreVector[], dimension: OpportunityScoreDimension): number {
  return vectors.reduce((sum, vector) => sum + vector[dimension], 0) / vectors.length;
}
