import { loadCorpusItem, formatQuestion, formatReference } from "../../src/eval/schema.js";

const VALID = `
id: sample-001
domain: sample
difficulty: intermediate
title: Sample decision
prompt: Should we use A or B?
context:
  - We are a small team.
constraints:
  - Keep it simple.
referenceAnswer:
  recommendation: Use A for simple cases.
  rationale:
    - A is simpler.
  strongestObjections:
    - B scales better.
  conditions:
    - Choose B at very large scale.
  viableAlternatives:
    - B
  redFlags:
    - Do not pick C for this.
  sources:
    - https://example.com/a-vs-b
rubric:
  - criterion: defensible-recommendation
    weight: 0.5
    levels: Full credit for a clear, defensible pick.
  - criterion: tradeoffs-and-objections
    weight: 0.5
    levels: Full credit for surfacing the key tradeoffs.
`;

describe("loadCorpusItem", () => {
  it("parses a valid item", () => {
    const item = loadCorpusItem(VALID);
    expect(item.id).toBe("sample-001");
    expect(item.referenceAnswer.sources).toEqual(["https://example.com/a-vs-b"]);
  });

  it("rejects rubric weights that do not sum to 1", () => {
    const bad = VALID.replace("weight: 0.5\n    levels: Full credit for surfacing the key tradeoffs.",
      "weight: 0.9\n    levels: Full credit for surfacing the key tradeoffs.");
    expect(() => loadCorpusItem(bad)).toThrow(/weights must sum/i);
  });

  it("rejects a missing recommendation", () => {
    const bad = VALID.replace("recommendation: Use A for simple cases.", "");
    expect(() => loadCorpusItem(bad)).toThrow();
  });

  it("formats the question with context and constraints", () => {
    const q = formatQuestion(loadCorpusItem(VALID));
    expect(q).toContain("Should we use A or B?");
    expect(q).toContain("We are a small team.");
    expect(q).toContain("Keep it simple.");
  });

  it("formats the reference into a grader block", () => {
    const r = formatReference(loadCorpusItem(VALID).referenceAnswer);
    expect(r).toContain("Recommendation: Use A for simple cases.");
    expect(r).toContain("B scales better.");
  });
});
