import { describe, expect, it } from "vitest";
import { materializeWorkflowPlan } from "../../../src/macro-workflow/templates.js";
import { verifyWorkflowPlan } from "../../../src/macro-workflow/verifier.js";

describe("source-to-project template", () => {
  it("materializes the advisory source-to-project DAG", () => {
    const plan = materializeWorkflowPlan("source-to-project", {
      objective: "Learn from a source",
      source: "https://example.com/post",
      project: "weavekit",
      mode: "advisory",
    });

    expect(plan.templateId).toBe("source-to-project");
    expect(plan.nodes.map((node) => node.id)).toEqual([
      "source-reading",
      "source-corroboration",
      "project-research",
      "opportunity-mapping",
      "council-review",
    ]);
    expect(plan.nodes.find((node) => node.id === "opportunity-mapping")?.dependsOn).toEqual([
      "source-reading",
      "source-corroboration",
      "project-research",
    ]);
    expect(plan.nodes.find((node) => node.id === "project-research")?.dependsOn).toEqual([
      "source-corroboration",
    ]);
    expect(plan.nodes.find((node) => node.id === "project-research")?.capabilities).toEqual({
      pluginCommands: [{
        plugin: "hve-core",
        command: "hve-core:task-research",
        promptInputName: "topic",
        args: { subagents: "auto" },
      }],
    });
    expect(plan.nodes.find((node) => node.id === "source-reading")).toMatchObject({
      description: expect.stringContaining("Read the source artifact"),
      model: "gpt-5.5",
    });
    expect(plan.nodes.find((node) => node.id === "council-review")).toMatchObject({
      model: "deterministic",
    });
    expect(plan.nodes.every((node) => node.writeMode === "read-only")).toBe(true);
    expect(verifyWorkflowPlan(plan).valid).toBe(true);
  });

  it("keeps autonomous source-to-project static planning bounded to council review", () => {
    const plan = materializeWorkflowPlan("source-to-project", {
      objective: "Learn from a source",
      source: "https://example.com/post",
      project: "weavekit",
      mode: "autonomous-pr",
    });

    expect(plan.nodes.at(-1)?.id).toBe("council-review");
    expect(plan.nodes.some((node) => node.writeMode === "single-writer")).toBe(false);
  });
});
