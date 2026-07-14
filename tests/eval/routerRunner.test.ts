import { describe, expect, it } from "vitest";
import { RouterRoute } from "../../src/config.js";
import { extractRouterEvalResults } from "../../src/eval/routerRunner.js";
import { loadCorpusItem } from "../../src/eval/schema.js";

const ITEM = loadCorpusItem(`
id: router-001
domain: router
difficulty: intro
title: Router
prompt: Plan this change.
referenceAnswer:
  recommendation: plan
  rationale: [planning requested]
  strongestObjections: [direct execution may be faster]
rubric:
  - criterion: route-match
    weight: 1.0
    levels: route matches
`);

describe("extractRouterEvalResults", () => {
  it("derives router artifacts from Promptfoo result metadata", () => {
    expect(
      extractRouterEvalResults([ITEM], {
        results: [
          {
            vars: { caseId: "router-001" },
            response: {
              metadata: {
                route: RouterRoute.PLAN,
                promptRewrite: "Create a bounded implementation plan.",
                createWorktreeEligible: false,
              },
            },
          },
        ],
      }),
    ).toEqual([
      {
        id: "router-001",
        title: "Router",
        prompt: "Plan this change.",
        expectedRoute: "plan",
        actualRoute: "plan",
        promptRewrite: "Create a bounded implementation plan.",
        createWorktreeEligible: false,
      },
    ]);
  });

  it("records missing Promptfoo provider metadata as an error result", () => {
    expect(extractRouterEvalResults([ITEM], { results: [] })[0]).toMatchObject({
      actualRoute: "error",
      promptRewrite: "",
      createWorktreeEligible: false,
    });
  });
});
