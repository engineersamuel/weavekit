import { describe, expect, it } from "vitest";
import { assertValidWorkflowPlan } from "../../src/macro-workflow/verifier.js";
import {
  getWorkflowTemplate,
  listWorkflowTemplates,
  materializeWorkflowPlan,
} from "../../src/macro-workflow/templates.js";

describe("macro workflow templates", () => {
  it("lists the implementation-review template", () => {
    const templates = listWorkflowTemplates();
    expect(templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "implementation-review" }),
        expect.objectContaining({ id: "router" }),
        expect.objectContaining({ id: "verification-optimizer" }),
        expect.objectContaining({ id: "x-article-summary" }),
      ]),
    );
  });

  it("materializes a read-only router workflow", () => {
    const plan = materializeWorkflowPlan("router", {
      objective: "Should this prompt become a goal or a PR handoff?",
    });

    expect(getWorkflowTemplate("router").id).toBe("router");
    expect(plan.templateId).toBe("router");
    expect(plan.maxReplans).toBe(0);
    expect(plan.nodes).toHaveLength(2);
    expect(plan.nodes.map((node) => node.id)).toEqual(["advise-prompt", "report"]);
    expect(plan.nodes.every((node) => node.writeMode === "read-only")).toBe(true);
    expect(plan.nodes[0]).toMatchObject({
      kind: "planning",
      harness: "research",
      replanPolicy: "never",
    });
    expect(() => assertValidWorkflowPlan(plan)).not.toThrow();
  });

  it("materializes a valid generated plan from the static template", () => {
    const plan = materializeWorkflowPlan("implementation-review", {
      objective: "Implement rich logging",
    });
    expect(getWorkflowTemplate("implementation-review").id).toBe("implementation-review");
    expect(plan.templateId).toBe("implementation-review");
    expect(plan.nodes[0]).toMatchObject({ id: "research" });
    expect(() => assertValidWorkflowPlan(plan)).not.toThrow();
  });

  it("omits human visual-plan work from plan-only source-to-project runs", () => {
    const plan = materializeWorkflowPlan("source-to-project", {
      objective: "Evaluate source-to-project planning",
      source: "source.md",
      projectPath: "project",
      mode: "advisory",
      includeVisualDesign: false,
    });

    expect(plan.nodes.map((node) => node.id)).not.toContain("visual-plan-preflight");
    expect(plan.nodes.find((node) => node.id === "source-reading")?.dependsOn).toEqual([]);
    expect(() => assertValidWorkflowPlan(plan)).not.toThrow();
  });

  it("materializes a one-node X article summary workflow", () => {
    const objective = [
      "Summarize this X article https://x.com/henrikhinai/status/2065471716093010128?s=51",
      "",
      "## Resolved X Post Sources",
      "",
      "### https://x.com/henrikhinai/status/2065471716093010128?s=51",
      "",
      "# Article Title",
      "",
      "Article body.",
    ].join("\n");
    const plan = materializeWorkflowPlan("x-article-summary", { objective });

    expect(getWorkflowTemplate("x-article-summary").id).toBe("x-article-summary");
    expect(plan.templateId).toBe("x-article-summary");
    expect(plan.id.length).toBeLessThanOrEqual(120);
    expect(plan.nodes).toHaveLength(1);
    expect(plan.nodes[0]).toMatchObject({
      id: "summarize-x-article",
      title: "Summarize X article",
      harness: "copilot-sdk",
      dependsOn: [],
      writeMode: "read-only",
      replanPolicy: "never",
    });
    expect(plan.nodes[0]?.prompt).toContain("Summarize this X article");
    expect(plan.nodes[0]?.prompt).toContain("## Resolved X Post Sources");
    expect(() => assertValidWorkflowPlan(plan)).not.toThrow();
  });
});
