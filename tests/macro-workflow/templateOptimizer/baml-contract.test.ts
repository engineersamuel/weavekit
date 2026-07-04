import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { b } from "../../../src/generated/baml_client/index.js";
import type {
  AggregateTemplateJudgment,
  TemplateCandidate,
  TemplateFixtureJudgment,
} from "../../../src/generated/baml_client/index.js";
import { describe, expect, it } from "vitest";

type _GeneratedTemplateOptimizerContracts = [
  TemplateCandidate,
  TemplateFixtureJudgment,
  AggregateTemplateJudgment,
];

const normalizedFields = [
  "score float",
  "incumbentScore float",
  "challengerScore float",
  "decisionConfidence float",
  "incumbentAggregateScore float",
  "challengerAggregateScore float",
];

describe("template optimizer BAML contract", () => {
  it("defines optimizer-specific BAML functions without overloading workflow planner", async () => {
    const baml = await readFile(join(process.cwd(), "baml_src/template_optimizer.baml"), "utf8");

    expect(baml).toContain("function GenerateTemplateChallenger");
    expect(baml).toContain("function JudgeTemplateFixture");
    expect(baml).toContain("function AggregateTemplateJudgments");
    expect(baml).toContain("class TemplateCandidate");
    expect(baml).toContain("class TemplateExpansionCase");
    expect(baml).toContain("class AdoptionTask");
    expect(baml).not.toContain('"baml"');
    for (const field of normalizedFields) {
      expect(baml).toContain(
        `${field} @description("Normalized 0..1 score.") @assert(normalized_${field.split(" ")[0]}, {{ this >= 0 and this <= 1 }})`,
      );
    }
    expect(baml).toContain(
      'scoreDelta float @description("Difference computed as challengerAggregateScore - incumbentAggregateScore; may be negative.")',
    );
    expect(typeof b.GenerateTemplateChallenger).toBe("function");
    expect(typeof b.JudgeTemplateFixture).toBe("function");
    expect(typeof b.AggregateTemplateJudgments).toBe("function");
  });

  it("renders compact optimizer prompt summaries instead of full candidate objects", async () => {
    const baml = await readFile(join(process.cwd(), "baml_src/template_optimizer.baml"), "utf8");

    expect(baml).not.toContain("Incumbent:\n    {{ incumbent }}");
    expect(baml).not.toContain("Challenger:\n    {{ challenger }}");
    expect(baml).not.toContain("Fixtures:\n    {{ fixtures }}");
    expect(baml).not.toContain("Fixture:\n    {{ fixture }}");
    expect(baml).not.toContain("Fixture judgments:\n    {{ fixtureJudgments }}");
    expect(baml).toContain("Incumbent candidate summary");
    expect(baml).toContain("Challenger candidate summary");
    expect(baml).toContain("Fixture summaries");
    expect(baml).toContain("Fixture judgment summaries");
  });
});
