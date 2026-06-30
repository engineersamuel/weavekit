import { describe, expect, it } from "vitest";
import { buildSuite, buildAssertions } from "../../src/eval/buildSuite.js";
import { loadCorpusItem } from "../../src/eval/schema.js";
import type { ApiProvider } from "promptfoo";

const ITEM = loadCorpusItem(`
id: t-001
domain: sample
difficulty: intro
title: T
prompt: A or B?
context:
  - small team
constraints:
  - simple
referenceAnswer:
  recommendation: Use A.
  rationale:
    - simple
  strongestObjections:
    - B scales
rubric:
  - criterion: defensible-recommendation
    weight: 0.6
    levels: clear pick
  - criterion: tradeoffs-and-objections
    weight: 0.4
    levels: surfaces tradeoffs
`);

const fakeProvider: ApiProvider = { id: () => "fake", callApi: async () => ({ output: "x" }) };

describe("buildAssertions", () => {
  it("creates one weighted g-eval per criterion plus a select-best when there are multiple providers", () => {
    const asserts = buildAssertions(ITEM, 2);
    expect(asserts).toHaveLength(3);
    const gevals = asserts.filter((a) => a.type === "g-eval");
    expect(gevals.map((a) => a.weight)).toEqual([0.6, 0.4]);
    expect(gevals.map((a) => a.metric)).toEqual([
      "defensible-recommendation",
      "tradeoffs-and-objections",
    ]);
    expect(gevals[0].value).toContain("{{reference}}");
    expect(asserts.some((a) => a.type === "select-best")).toBe(true);
  });

  it("skips select-best when there is only one provider", () => {
    const asserts = buildAssertions(ITEM, 1);
    expect(asserts.every((assert) => assert.type !== "select-best")).toBe(true);
  });
});

describe("buildSuite", () => {
  it("wires providers, prompt template, vars, and judge config", () => {
    const suite = buildSuite([ITEM], {
      providers: [fakeProvider],
      judge: { model: "judge-x", apiBaseUrl: "http://localhost:9/v1", apiKey: "k" },
    });
    expect(suite.providers).toEqual([fakeProvider]);
    expect(suite.prompts).toEqual(["{{question}}"]);
    expect(suite.tests).toHaveLength(1);
    const tests = Array.isArray(suite.tests) ? suite.tests : [];
    const test = tests[0];
    if (!test || typeof test === "string" || !("vars" in test)) throw new Error("Invalid test");
    expect(test.vars!.prompt).toBe("A or B?");
    expect(test.vars!.contextItems).toEqual(["small team"]);
    expect(String(test.vars!.reference)).toContain("Recommendation: Use A.");
    const defaultTest = typeof suite.defaultTest === "string" ? undefined : suite.defaultTest;
    const judge = defaultTest?.options?.provider as { id: string };
    expect(judge.id).toBe("openai:chat:judge-x");
  });
});
