import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTemplateOptimizationFixtures } from "../../../src/macro-workflow/templateOptimizer/fixtures.js";

const requiredArrayFields = [
  "sourceLessons",
  "projectConstraints",
  "opportunities",
  "idealFeatures",
  "mustPreserve",
  "failureModes",
] as const;

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
    for (const fixture of fixtures) {
      expect(fixture.scenarioSummary.length).toBeGreaterThan(0);
      for (const field of requiredArrayFields) {
        expect(fixture[field].length).toBeGreaterThan(0);
      }
    }
  });

  it("rejects malformed fixtures with missing required arrays", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "template-optimizer-fixtures-"));
    const fixtureDir = join(rootDir, "source-to-project", "advisory");
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(
      join(fixtureDir, "strong-fit.yaml"),
      `id: strong-fit
mode: advisory
scenarioSummary: Missing source lessons should fail validation.
projectConstraints:
  - Advisory mode must not modify files.
opportunities:
  - Improve advisory report usefulness.
idealFeatures:
  - Keeps research steps distinct.
mustPreserve:
  - Does not add implementation nodes in advisory mode.
failureModes:
  - Skips final review.
`,
      "utf8",
    );

    await expect(
      loadTemplateOptimizationFixtures({
        templateId: "source-to-project",
        mode: "advisory",
        rootDir,
      }),
    ).rejects.toThrow(/strong-fit.*sourceLessons/);
  });
});
