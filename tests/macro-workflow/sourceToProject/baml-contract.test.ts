import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Opportunity } from "../../../src/generated/baml_client/index.js";

const score = {
  applicability: 0.9,
  applicabilityReasoning: "The source lesson maps directly to the target change surface.",
  impact: 0.8,
  impactReasoning: "The change improves maintainer decision quality.",
  confidence: 0.7,
  confidenceReasoning: "Both source and project evidence support the fit.",
  implementationCost: 0.2,
  implementationCostReasoning: "The change is limited to additive contract fields.",
  risk: 0.1,
  riskReasoning: "Optional fields preserve existing consumers.",
};

const baseOpportunity = {
  id: "opp-contract",
  title: "Record disconfirming reasoning",
  lesson: "Keep alternatives visible when evidence supports them.",
  projectChange: "Add optional reasoning artifacts to the BAML contract.",
  changeSurface: "baml_src/source_to_project.baml",
  score,
  evidence: [],
  speculative: false,
};

describe("source-to-project BAML reasoning contract", () => {
  it("keeps Opportunity values backward compatible when reasoning artifacts are populated or omitted", () => {
    const populated = {
      ...baseOpportunity,
      rivalExplanationsConsidered: ["The observed signal could be workflow-specific."],
      negativeSignal: "No project evidence shows the issue outside this workflow.",
      negativeCases: ["Omit the change when the target already records alternatives."],
    } satisfies Opportunity;
    const omitted = { ...baseOpportunity } satisfies Opportunity;

    expect(populated.rivalExplanationsConsidered).toHaveLength(1);
    expect(populated.negativeSignal).toContain("No project evidence");
    expect(populated.negativeCases).toHaveLength(1);
    expect("rivalExplanationsConsidered" in omitted).toBe(false);
    expect("negativeSignal" in omitted).toBe(false);
    expect("negativeCases" in omitted).toBe(false);
  });

  it("declares optional evidence-grounded reasoning fields in the mapping contract", async () => {
    const source = await readFile("baml_src/source_to_project.baml", "utf8");
    const opportunityClass = section(source, "class Opportunity {", "class NonApplicableLesson {");
    const mappingPrompt = section(
      source,
      "function MapSourceToProject(",
      "function DistillPlanArtifact(",
    );

    expect(opportunityClass).toMatch(
      /speculative bool[\s\S]*rivalExplanationsConsidered string\[\]\?[\s\S]*negativeSignal string\?[\s\S]*negativeCases string\[\]\?/,
    );
    expect(mappingPrompt).toMatch(/materially distinct rival explanations/i);
    expect(mappingPrompt).toMatch(/negative|disconfirming/i);
    expect(mappingPrompt).toMatch(/source and project evidence/i);
    expect(mappingPrompt).toMatch(/otherwise omit/i);
  });

  it("preserves optional rival hypotheses and negative cases in persona normalization", async () => {
    const source = await readFile("baml_src/council.baml", "utf8");
    const critiqueClass = section(
      source,
      "class PersonaCritique {",
      "class PersonaCritiqueSummary {",
    );
    const normalizationPrompt = section(
      source,
      "function NormalizePersonaCritique(",
      "function AssessCouncilRound(",
    );

    expect(critiqueClass).toMatch(
      /rivalExplanations string\[\]\?[\s\S]*negativeCases string\[\]\?/,
    );
    expect(normalizationPrompt).toMatch(/materially distinct rival hypotheses/i);
    expect(normalizationPrompt).toMatch(/negative cases/i);
    expect(normalizationPrompt).toMatch(/when present/i);
    expect(normalizationPrompt).toMatch(/otherwise omit/i);
  });
});

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);

  expect(startIndex, `Missing BAML section start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `Missing BAML section end: ${end}`).toBeGreaterThan(startIndex);

  return source.slice(startIndex, endIndex);
}
