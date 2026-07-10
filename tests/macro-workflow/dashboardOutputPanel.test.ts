import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workflow dashboard output panel", () => {
  it("labels node output separately from execution context and generated artifacts", async () => {
    const source = await readFile("src/macro-workflow/dashboard/main.js", "utf8");

    const outputBoundaryIndex = source.indexOf("<h3>Node Output</h3>");
    const summaryIndex = source.indexOf("<h3>Output Summary</h3>");
    const payloadIndex = source.indexOf('title="Typed Output Payload"');
    const artifactLinksIndex = source.indexOf("<NodeArtifactLinks");

    expect(outputBoundaryIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeGreaterThan(outputBoundaryIndex);
    expect(payloadIndex).toBeGreaterThan(summaryIndex);
    expect(artifactLinksIndex).toBeGreaterThan(payloadIndex);
  });

  it("renders long objectives behind a compact expandable summary", async () => {
    const source = await readFile("src/macro-workflow/dashboard/main.js", "utf8");

    expect(source).toContain("<ObjectiveSummary objective={objective} />");
    expect(source).toContain('className="objective-toggle"');
    expect(source).toContain('expanded ? "Show less" : "Show more"');
  });
});
