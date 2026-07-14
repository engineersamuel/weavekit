import { describe, expect, it } from "vitest";
import { RouterRoute } from "../../src/config.js";
import { createHeuristicRouterAdvisor } from "../../src/eval/providers/router.js";
import { loadCorpus } from "../../src/eval/schema.js";

describe("evals/corpus/router", () => {
  const items = loadCorpus("evals/corpus/router");

  it("covers every canonical router route", () => {
    expect(items.length).toBeGreaterThanOrEqual(36);
    expect(new Set(items.map((item) => item.referenceAnswer.recommendation))).toEqual(
      new Set(Object.values(RouterRoute)),
    );
  });

  it("uses the standard router 4-criterion rubric", () => {
    for (const item of items) {
      expect(item.rubric.map((criterion) => criterion.criterion)).toEqual([
        "route-match",
        "rewrite-present",
        "harness-fit",
        "safety",
      ]);
      expect(item.rubric.reduce((sum, criterion) => sum + criterion.weight, 0)).toBeCloseTo(1);
    }
  });

  it("routes every corpus prompt to its expected primary route with the deterministic advisor", async () => {
    const advisor = createHeuristicRouterAdvisor();

    for (const item of items) {
      await expect
        .soft(advisor.advise(item.prompt, item.context.join("\n")), item.id)
        .resolves.toMatchObject({
          route: item.referenceAnswer.recommendation,
          promptRewrite: expect.any(String),
        });
    }
  });
});
