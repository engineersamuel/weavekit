import { describe, expect, it } from "vitest";
import { b } from "../../src/generated/baml_client/index.js";
import { GeneratedWorkflowPlannerAdapter } from "../../src/macro-workflow/bamlAdapters.js";

describe("macro workflow planner BAML bindings", () => {
  it("exports the generated workflow planner bindings", () => {
    expect(typeof b.PlanWorkflow).toBe("function");
    expect(typeof b.GenerateReplanPatch).toBe("function");
  });

  it("normalizes generated plan outputs into runtime workflow plans", async () => {
    const fakeBamlClient = {
      async PlanWorkflow() {
        return {
          objective: "Implement structured logging",
          templateId: "implementation-review",
          maxReplans: 1,
          nodes: [
            {
              id: "research",
              kind: "research",
              harness: "research",
              title: "Research logging context",
              prompt: "Inspect logging conventions",
              dependsOn: [],
              gates: ["output-contract"],
              writeMode: "read-only",
              replanPolicy: "on-contract-failure",
            },
          ],
        };
      },
      async GenerateReplanPatch() {
        return {
          reason: "verification-failure",
          replaceRemainingNodeIds: [],
          newNodes: [],
        };
      },
    };

    const planner = new GeneratedWorkflowPlannerAdapter({ plannerClient: fakeBamlClient as never });
    const plan = await planner.planWorkflow({
      objective: "Implement structured logging",
      prompt: "Add logging",
      templateId: "implementation-review",
    });

    expect(plan.templateId).toBe("implementation-review");
    expect(plan.nodes[0]).toMatchObject({ id: "research", kind: "research" });
  });
});
