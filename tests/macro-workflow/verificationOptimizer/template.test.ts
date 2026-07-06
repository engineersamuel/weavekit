import { describe, expect, it } from "vitest";
import { materializeWorkflowPlan } from "../../../src/macro-workflow/templates.js";
import { verifyWorkflowPlan } from "../../../src/macro-workflow/verifier.js";

describe("verification-optimizer template", () => {
  it("materializes a valid initial verification-optimizer DAG", () => {
    const plan = materializeWorkflowPlan("verification-optimizer", {
      objective: "Improve verification for weavekit",
      project: "weavekit",
      mode: "autonomous-pr",
    });

    expect(plan.templateId).toBe("verification-optimizer");
    expect(plan.maxReplans).toBe(2);
    expect(plan.nodes.map((node) => node.id)).toEqual([
      "project-verification-audit",
      "verification-opportunity-mapping",
      "verification-review",
    ]);
    expect(plan.nodes.find((node) => node.id === "project-verification-audit")).toMatchObject({
      kind: "research",
      harness: "copilot-sdk",
      dependsOn: [],
      writeMode: "read-only",
    });
    expect(plan.nodes.find((node) => node.id === "verification-opportunity-mapping")).toMatchObject({
      kind: "planning",
      harness: "research",
      dependsOn: ["project-verification-audit"],
    });
    expect(plan.nodes.find((node) => node.id === "verification-review")).toMatchObject({
      kind: "deliberation",
      harness: "decision-council",
      dependsOn: ["verification-opportunity-mapping"],
    });
    expect(verifyWorkflowPlan(plan).valid).toBe(true);
  });
});
