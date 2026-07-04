import { describe, expect, it } from "vitest";
import { loadTemplateOptimizationFixtures } from "../../../src/macro-workflow/templateOptimizer/fixtures.js";

describe("template optimizer fixtures", () => {
  it("loads advisory source-to-project fixtures", async () => {
    const fixtures = await loadTemplateOptimizationFixtures({
      templateId: "source-to-project",
      mode: "advisory",
      rootDir: "evals/template-optimizer",
    });

    expect(fixtures.map((fixture) => fixture.id).sort()).toEqual([
      "multiple-opportunities",
      "no-fit",
      "plumbing-temptation",
      "strong-fit",
    ]);
    expect(fixtures.every((fixture) => fixture.mode === "advisory")).toBe(true);
    expect(fixtures.every((fixture) => fixture.mustPreserve.length > 0)).toBe(true);
  });
});
