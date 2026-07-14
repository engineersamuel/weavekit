import { describe, expect, it } from "vitest";
import type { ProjectVerificationCase } from "../../../src/eval/sourceToProjectVerification/case.js";
import { aggregatePlanQuality } from "../../../src/eval/sourceToProjectVerification/aggregation.js";
import type { AbsoluteJudgeRecord } from "../../../src/eval/sourceToProjectVerification/judge.js";

const CASE: ProjectVerificationCase = {
  id: "case",
  title: "Case",
  objective: "Improve it",
  projectDir: "/tmp/project",
  sourcePath: "/tmp/source",
  expectedPractices: [
    {
      id: "practice-one",
      title: "Practice one",
      sourceExpectation: "First",
      projectEvidence: ["a"],
      expectedPlanActions: ["one", "two"],
    },
    {
      id: "practice-two",
      title: "Practice two",
      sourceExpectation: "Second",
      projectEvidence: ["b"],
      expectedPlanActions: ["three"],
    },
  ],
  antiGoals: [],
  rubric: [
    { criterion: "source-practice-coverage", weight: 0.3, levels: "coverage" },
    { criterion: "project-specific-diagnosis", weight: 0.25, levels: "specific" },
    { criterion: "implementation-completeness", weight: 0.25, levels: "complete" },
    { criterion: "verification-quality", weight: 0.15, levels: "verified" },
    { criterion: "scope-discipline", weight: 0.05, levels: "bounded" },
  ],
};

const PLAN_MARKDOWN = `# Plan

Practice one action one is complete.
Practice one action two is partial.
Project-specific diagnosis is concrete.
Implementation completeness is documented.
Verification quality is documented.
Scope discipline is documented.
`;

describe("source-to-project judgment aggregation", () => {
  it("rejects an empty judge panel without producing NaN", () => {
    const quality = aggregatePlanQuality({
      definition: CASE,
      providerId: "weavekit",
      planMarkdown: PLAN_MARKDOWN,
      judgeIds: [],
      records: [],
    });

    expect(quality.valid).toBe(false);
    expect(quality.score).toBeUndefined();
    expect(quality.errors).toContain("At least one judge is required to aggregate plan quality.");
  });

  it("weights practices equally and averages ordinal scores across judges", () => {
    const quality = aggregatePlanQuality({
      definition: CASE,
      providerId: "weavekit",
      planMarkdown: PLAN_MARKDOWN,
      judgeIds: ["gpt", "claude"],
      records: [record("gpt"), record("claude")],
    });

    expect(quality.valid).toBe(true);
    expect(quality.practiceScores).toEqual({ "practice-one": 0.75, "practice-two": 0 });
    expect(quality.criteria["source-practice-coverage"]).toBe(0.375);
    expect(quality.criteria["project-specific-diagnosis"]).toBe(1);
    expect(quality.criteria["implementation-completeness"]).toBe(0.75);
    expect(quality.score).toBeCloseTo(0.75);
  });

  it.each([
    ["duplicate", duplicateRequirement(record("gpt")), /duplicate requirement/i],
    ["missing", missingRequirement(record("gpt")), /missing requirement/i],
    ["unknown", unknownRequirement(record("gpt")), /unknown requirement/i],
    ["out of range", outOfRangeCriterion(record("gpt")), /score.*0.*4/i],
  ])("invalidates %s judge output instead of converting it to zero", (_name, bad, error) => {
    const quality = aggregatePlanQuality({
      definition: CASE,
      providerId: "weavekit",
      planMarkdown: PLAN_MARKDOWN,
      judgeIds: ["gpt"],
      records: [bad],
    });

    expect(quality.valid).toBe(false);
    expect(quality.score).toBeUndefined();
    expect(quality.errors[0]).toMatch(error);
  });

  it("invalidates a non-missing requirement without evidence", () => {
    const bad = record("gpt");
    bad.result!.requirementAssessments[0]!.evidenceQuotes = [];

    const quality = aggregatePlanQuality({
      definition: CASE,
      providerId: "weavekit",
      planMarkdown: PLAN_MARKDOWN,
      judgeIds: ["gpt"],
      records: [bad],
    });

    expect(quality.valid).toBe(false);
    expect(quality.score).toBeUndefined();
    expect(quality.errors).toContain(
      "gpt: requirement practice-one/action-1 with status complete requires evidence.",
    );
  });

  it("invalidates a fabricated requirement evidence quote", () => {
    const bad = record("gpt");
    bad.result!.requirementAssessments[0]!.evidenceQuotes = ["Fabricated requirement quote"];

    const quality = aggregatePlanQuality({
      definition: CASE,
      providerId: "weavekit",
      planMarkdown: PLAN_MARKDOWN,
      judgeIds: ["gpt"],
      records: [bad],
    });

    expect(quality.valid).toBe(false);
    expect(quality.score).toBeUndefined();
    expect(quality.errors).toContain(
      "gpt: requirement practice-one/action-1 evidence quote is not in the plan.",
    );
  });

  it("invalidates a positive criterion without evidence", () => {
    const bad = record("gpt");
    bad.result!.criterionAssessments[0]!.evidenceQuotes = [];

    const quality = aggregatePlanQuality({
      definition: CASE,
      providerId: "weavekit",
      planMarkdown: PLAN_MARKDOWN,
      judgeIds: ["gpt"],
      records: [bad],
    });

    expect(quality.valid).toBe(false);
    expect(quality.score).toBeUndefined();
    expect(quality.errors).toContain(
      "gpt: criterion project-specific-diagnosis with score 4 requires evidence.",
    );
  });

  it("invalidates a fabricated criterion evidence quote", () => {
    const bad = record("gpt");
    bad.result!.criterionAssessments[0]!.evidenceQuotes = ["Fabricated criterion quote"];

    const quality = aggregatePlanQuality({
      definition: CASE,
      providerId: "weavekit",
      planMarkdown: PLAN_MARKDOWN,
      judgeIds: ["gpt"],
      records: [bad],
    });

    expect(quality.valid).toBe(false);
    expect(quality.score).toBeUndefined();
    expect(quality.errors).toContain(
      "gpt: criterion project-specific-diagnosis evidence quote is not in the plan.",
    );
  });

  it("accepts missing requirements and zero criteria with empty evidence arrays", () => {
    const valid = record("gpt");
    valid.result!.requirementAssessments[2]!.evidenceQuotes = [];
    valid.result!.criterionAssessments[0]!.score = 0;
    valid.result!.criterionAssessments[0]!.evidenceQuotes = [];

    const quality = aggregatePlanQuality({
      definition: CASE,
      providerId: "weavekit",
      planMarkdown: PLAN_MARKDOWN,
      judgeIds: ["gpt"],
      records: [valid],
    });

    expect(quality.valid).toBe(true);
    expect(quality.score).toBeTypeOf("number");
  });

  it.each([
    ["requirement", emptyMissingRequirementQuote(record("gpt")), /requirement.*evidence.*empty/i],
    ["criterion", emptyZeroCriterionQuote(record("gpt")), /criterion.*evidence.*empty/i],
  ])("invalidates a supplied empty %s evidence quote", (_kind, bad, error) => {
    const quality = aggregatePlanQuality({
      definition: CASE,
      providerId: "weavekit",
      planMarkdown: PLAN_MARKDOWN,
      judgeIds: ["gpt"],
      records: [bad],
    });

    expect(quality.valid).toBe(false);
    expect(quality.score).toBeUndefined();
    expect(quality.errors[0]).toMatch(error);
  });

  it.each([
    [
      "requirement",
      whitespaceRequirementQuote(record("gpt")),
      [
        "gpt: requirement practice-one/action-1 with status complete requires evidence.",
        "gpt: requirement practice-one/action-1 evidence quote is empty.",
      ],
    ],
    [
      "criterion",
      whitespaceCriterionQuote(record("gpt")),
      [
        "gpt: criterion project-specific-diagnosis with score 4 requires evidence.",
        "gpt: criterion project-specific-diagnosis evidence quote is empty.",
      ],
    ],
  ])(
    "invalidates whitespace-only %s evidence for both presence and quote validation",
    (_kind, bad, errors) => {
      const quality = aggregatePlanQuality({
        definition: CASE,
        providerId: "weavekit",
        planMarkdown: PLAN_MARKDOWN,
        judgeIds: ["gpt"],
        records: [bad],
      });

      expect(quality.valid).toBe(false);
      expect(quality.score).toBeUndefined();
      expect(quality.errors).toEqual(expect.arrayContaining(errors));
    },
  );
});

function record(judgeId: string): AbsoluteJudgeRecord {
  return {
    judgeId,
    providerId: "weavekit",
    requirementIds: ["practice-one/action-1", "practice-one/action-2", "practice-two/action-1"],
    elapsedMs: 1,
    repairAttempted: false,
    retryCount: 0,
    evidenceDefectCount: 0,
    evidenceDefectCodes: [],
    evidenceDefectOmittedCount: 0,
    result: {
      requirementAssessments: [
        assessment("practice-one/action-1", "complete", "Practice one action one is complete."),
        assessment("practice-one/action-2", "partial", "Practice one action two is partial."),
        assessment("practice-two/action-1", "missing"),
      ],
      criterionAssessments: [
        criterion("project-specific-diagnosis", 4, "Project-specific diagnosis is concrete."),
        criterion("implementation-completeness", 3, "Implementation completeness is documented."),
        criterion("verification-quality", 4, "Verification quality is documented."),
        criterion("scope-discipline", 4, "Scope discipline is documented."),
      ],
      contradictions: [],
      unsupportedRecommendations: [],
      summary: "summary",
    },
  };
}

function assessment(
  requirementId: string,
  status: "complete" | "partial" | "missing" | "contradicted",
  evidenceQuote?: string,
) {
  return {
    requirementId,
    status,
    evidenceQuotes: evidenceQuote === undefined ? [] : [evidenceQuote],
    gaps: [],
    rationale: status,
  };
}

function criterion(name: string, score: number, evidenceQuote: string) {
  return { criterion: name, score, evidenceQuotes: [evidenceQuote], gaps: [], rationale: name };
}

function duplicateRequirement(value: AbsoluteJudgeRecord): AbsoluteJudgeRecord {
  const result = structuredClone(value.result!);
  result.requirementAssessments.push(result.requirementAssessments[0]!);
  return { ...value, result };
}

function missingRequirement(value: AbsoluteJudgeRecord): AbsoluteJudgeRecord {
  const result = structuredClone(value.result!);
  result.requirementAssessments.pop();
  return { ...value, result };
}

function unknownRequirement(value: AbsoluteJudgeRecord): AbsoluteJudgeRecord {
  const result = structuredClone(value.result!);
  result.requirementAssessments[0]!.requirementId = "unknown/action-1";
  return { ...value, result };
}

function outOfRangeCriterion(value: AbsoluteJudgeRecord): AbsoluteJudgeRecord {
  const result = structuredClone(value.result!);
  result.criterionAssessments[0]!.score = 5;
  return { ...value, result };
}

function emptyMissingRequirementQuote(value: AbsoluteJudgeRecord): AbsoluteJudgeRecord {
  const result = structuredClone(value.result!);
  result.requirementAssessments[2]!.evidenceQuotes = [""];
  return { ...value, result };
}

function emptyZeroCriterionQuote(value: AbsoluteJudgeRecord): AbsoluteJudgeRecord {
  const result = structuredClone(value.result!);
  result.criterionAssessments[0]!.score = 0;
  result.criterionAssessments[0]!.evidenceQuotes = [""];
  return { ...value, result };
}

function whitespaceRequirementQuote(value: AbsoluteJudgeRecord): AbsoluteJudgeRecord {
  const result = structuredClone(value.result!);
  result.requirementAssessments[0]!.evidenceQuotes = ["\n\n"];
  return { ...value, result };
}

function whitespaceCriterionQuote(value: AbsoluteJudgeRecord): AbsoluteJudgeRecord {
  const result = structuredClone(value.result!);
  result.criterionAssessments[0]!.evidenceQuotes = ["\n\n"];
  return { ...value, result };
}
