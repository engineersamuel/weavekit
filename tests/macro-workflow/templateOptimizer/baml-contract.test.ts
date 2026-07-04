import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("template optimizer BAML contract", () => {
  it("defines optimizer-specific BAML functions without overloading workflow planner", async () => {
    const baml = await readFile(join(process.cwd(), "baml_src/template_optimizer.baml"), "utf8");

    expect(baml).toContain("function GenerateTemplateChallenger");
    expect(baml).toContain("function JudgeTemplateFixture");
    expect(baml).toContain("function AggregateTemplateJudgments");
    expect(baml).toContain("class TemplateCandidate");
    expect(baml).toContain("class TemplateExpansionCase");
    expect(baml).toContain("class AdoptionTask");
  });
});
