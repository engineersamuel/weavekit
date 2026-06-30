import { describe, expect, it } from "vitest";
import { assertValidWorkflowPlan } from "../../src/macro-workflow/verifier.js";
import { getWorkflowTemplate, listWorkflowTemplates, materializeWorkflowPlan } from "../../src/macro-workflow/templates.js";

describe("macro workflow templates", () => {
  it("lists the implementation-review template", () => {
    const templates = listWorkflowTemplates();
    expect(templates).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "implementation-review" })]),
    );
  });

  it("materializes a valid generated plan from the static template", () => {
    const plan = materializeWorkflowPlan("implementation-review", { objective: "Implement rich logging" });
    expect(getWorkflowTemplate("implementation-review").id).toBe("implementation-review");
    expect(plan.templateId).toBe("implementation-review");
    expect(plan.nodes[0]).toMatchObject({ id: "research" });
    expect(() => assertValidWorkflowPlan(plan)).not.toThrow();
  });
});
