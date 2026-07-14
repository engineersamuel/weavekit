import type { ApiProvider } from "promptfoo";
import { describe, expect, it } from "vitest";
import { loadProjectVerificationCase } from "../../../src/eval/sourceToProjectVerification/case.js";
import { buildProjectVerificationSuite } from "../../../src/eval/sourceToProjectVerification/suite.js";

const provider: ApiProvider = {
  id: () => "fake",
  callApi: async () => ({ output: "plan" }),
};

describe("source-to-project provider collection suite", () => {
  it("collects provider plans without authoritative Promptfoo grading", () => {
    const suite = buildProjectVerificationSuite(loadProjectVerificationCase(), {
      providers: [provider],
    });
    const tests = Array.isArray(suite.tests) ? suite.tests : [];
    const test = tests[0];
    if (!test || typeof test === "string" || !("vars" in test) || !("assert" in test)) {
      throw new Error("Expected one concrete test case.");
    }

    expect(suite.prompts).toEqual(["{{benchmarkPrompt}}"]);
    expect(test.vars?.benchmarkPrompt).toContain("Produce an implementation plan only");
    expect(test.assert ?? []).toEqual([]);
    expect(JSON.stringify(suite)).not.toMatch(/llm-rubric|g-eval|select-best/);
  });
});
