import { describe, expect, it } from "vitest";
import { b } from "../../../src/generated/baml_client/index.js";

describe("deep-research report BAML contract", () => {
  it("parses markdown-only compiler output", () => {
    const report = b.parse.CompileDeepResearchReport(
      JSON.stringify({
        markdown: "# Deep Research Report\n\n## Methodology\n\nCollected cited evidence.",
      }),
    );

    expect(report).toEqual({
      markdown: expect.stringContaining("# Deep Research Report"),
    });
  });

  it("rejects compiler output missing markdown", () => {
    expect(() => b.parse.CompileDeepResearchReport("{}")).toThrow(/markdown/i);
  });
});
