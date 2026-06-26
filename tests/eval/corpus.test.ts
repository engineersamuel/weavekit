import { describe, expect, it } from "vitest";
import { loadCorpus } from "../../src/eval/schema.js";

describe("evals/corpus", () => {
  const items = loadCorpus("evals/corpus");

  it("loads at least one item", () => {
    expect(items.length).toBeGreaterThan(0);
  });

  it("has unique kebab-case ids", () => {
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("every rubric sums to 1.0", () => {
    for (const item of items) {
      const sum = item.rubric.reduce((s, c) => s + c.weight, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-3);
    }
  });

  it("has exactly 15 items", () => {
    expect(items.length).toBe(15);
  });

  it("has exact per-domain distribution", () => {
    const domainCounts = items.reduce((acc, item) => {
      acc[item.domain] = (acc[item.domain] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    expect(domainCounts).toEqual({
      "api-protocol": 2,
      "architecture-style": 2,
      "build-vs-buy": 2,
      "data-store": 2,
      "deploy": 1,
      "language-runtime": 2,
      "messaging-async": 2,
      "orchestration-framework": 2,
    });
  });

  it("every item has the standard 4-criterion rubric", () => {
    const expectedCriteria = [
      "defensible-recommendation",
      "tradeoffs-and-objections",
      "conditions-and-alternatives",
      "red-flags-avoided",
    ];
    const expectedWeights = [0.35, 0.3, 0.2, 0.15];

    for (const item of items) {
      expect(item.rubric.length).toBe(4);
      const criteria = item.rubric.map((c) => c.criterion);
      const weights = item.rubric.map((c) => c.weight);
      expect(criteria).toEqual(expectedCriteria);
      expect(weights).toEqual(expectedWeights);
    }
  });
});
