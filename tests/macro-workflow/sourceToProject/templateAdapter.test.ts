import { describe, expect, it } from "vitest";
import { WorkflowNodeKind } from "../../../src/macro-workflow/types.js";
import { createSourceToProjectTemplateAdapter } from "../../../src/macro-workflow/sourceToProject/templateAdapter.js";

describe("source-to-project template adapter", () => {
  it("exports the checked-in source-to-project baseline as a template candidate", () => {
    const adapter = createSourceToProjectTemplateAdapter();
    const baseline = adapter.getBaselineCandidate("advisory");

    expect(baseline.templateId).toBe("source-to-project");
    expect(baseline.mode).toBe("advisory");
    expect(baseline.sharedInitialNodes.map((node) => node.id)).toEqual([
      "visual-plan-preflight",
      "source-reading",
      "source-corroboration",
      "project-research",
      "opportunity-mapping",
      "council-review",
    ]);
    expect(baseline.modePolicies.find((policy) => policy.mode === "advisory")?.enabledForOptimization).toBe(true);
    expect(baseline.modePolicies.find((policy) => policy.mode === "autonomous-pr")?.enabledForOptimization).toBe(false);
  });

  it("represents no-op and selected-plan advisory expansion cases", () => {
    const adapter = createSourceToProjectTemplateAdapter();
    const baseline = adapter.getBaselineCandidate("advisory");
    const advisory = baseline.modePolicies.find((policy) => policy.mode === "advisory");

    expect(advisory?.expansionCases.map((expansionCase) => expansionCase.id)).toContain("no-accepted-opportunities");
    expect(advisory?.expansionCases.map((expansionCase) => expansionCase.id)).toContain("single-selected-plan");
    expect(advisory?.expansionCases.some((expansionCase) =>
      expansionCase.nodes.some((node) => node.kind === WorkflowNodeKind.REPORT)
    )).toBe(true);
  });
});
