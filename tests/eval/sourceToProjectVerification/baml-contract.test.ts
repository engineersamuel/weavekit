import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getBamlFiles } from "../../../src/generated/baml_client/inlinedbaml.js";

describe("source-to-project verification BAML judge contract", () => {
  it("defines structured absolute and pairwise judge functions", () => {
    const source = readFileSync("baml_src/source_to_project.baml", "utf8");

    for (const contract of [
      "class PlanRequirementAssessment",
      "class PlanCriterionAssessment",
      "class SourceToProjectPlanJudgment",
      "class SourceToProjectPairwiseJudgment",
      "function JudgeSourceToProjectPlan",
      "function CompareSourceToProjectPlans",
    ]) {
      expect(source).toContain(contract);
    }
  });

  it("grounds every absolute-judge evidence quote only in anonymous plan markdown", () => {
    const source = readFileSync("baml_src/source_to_project.baml", "utf8");
    const absolutePrompt = source.slice(
      source.indexOf("function JudgeSourceToProjectPlan"),
      source.indexOf("function CompareSourceToProjectPlans"),
    );

    expect(absolutePrompt).toContain(
      "Copy evidence quotes only from Anonymous plan markdown, never from case JSON, project evidence, or a paraphrase.",
    );
    expect(absolutePrompt).toContain(
      "Every non-missing requirement and every criterion scored above 0 requires at least one exact quote.",
    );
    expect(absolutePrompt).toContain(
      "Before returning, check every quote character-for-character against Anonymous plan markdown.",
    );
    expect(absolutePrompt).toContain("validationFeedback: string");
    expect(absolutePrompt).toContain("Deterministic evidence validation feedback:");
    expect(absolutePrompt).not.toContain("Trusted deterministic validation feedback:");
    expect(absolutePrompt).toContain("{{ validationFeedback }}");
    expect(absolutePrompt).toContain(
      "Indices identify requirementAssessments or criterionAssessments entries and their evidenceQuotes entries.",
    );
    expect(absolutePrompt).toContain(
      "Codes mean: required-evidence-missing = required evidence is absent; blank-quote = a supplied quote is blank; quote-not-in-plan = a supplied quote is not an exact plan substring.",
    );
    expect(absolutePrompt).toContain("Return a fresh complete judgment, not a patch.");
    expect(absolutePrompt).toContain(
      "For blank-quote or quote-not-in-plan, delete the flagged quote; do not replace it when other valid evidence remains.",
    );
    expect(absolutePrompt).toContain(
      "Never paraphrase, shorten, splice, combine, or reconstruct a quote.",
    );
    expect(absolutePrompt).toContain(
      "For required-evidence-missing, or when deletion leaves a non-missing requirement or positive-scored criterion with no valid evidence, copy exactly one complete contiguous line or sentence from Anonymous plan markdown.",
    );
    expect(absolutePrompt).toContain(
      "Only if no supporting exact span exists may you downgrade the requirement to missing or the criterion to score 0.",
    );
    expect(absolutePrompt).toContain(
      "Preserve classifications unless the evidence genuinely cannot support them.",
    );
    expect(absolutePrompt.indexOf("Deterministic evidence validation feedback:")).toBeLessThan(
      absolutePrompt.indexOf('{{ _.role("user") }}'),
    );
  });

  it("keeps the runtime-embedded source-to-project BAML exactly in sync", () => {
    expect(getBamlFiles()["source_to_project.baml"]).toBe(
      readFileSync("baml_src/source_to_project.baml", "utf8"),
    );
  });
});
