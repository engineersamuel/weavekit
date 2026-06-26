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
});
