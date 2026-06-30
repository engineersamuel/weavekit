import { describe, expect, it } from "vitest";
import { MacroWorkflowProvider } from "../../src/eval/providers/macroWorkflow.js";
import type { RuntimeWorkflowPlan } from "../../src/macro-workflow/types.js";

function fakePlan(): RuntimeWorkflowPlan {
  return {
    id: "plan-1",
    objective: "Implement logging",
    templateId: "implementation-review",
    maxReplans: 1,
    nodes: [
      {
        id: "research",
        kind: "research",
        harness: "research",
        title: "Research",
        prompt: "Inspect logging",
        dependsOn: [],
        gates: ["output-contract"],
        writeMode: "read-only",
        replanPolicy: "on-contract-failure",
      },
    ],
  };
}

describe("MacroWorkflowProvider", () => {
  it("returns a validation summary for a generated macro workflow plan", async () => {
    const provider = new MacroWorkflowProvider({
      planWorkflow: async () => fakePlan(),
    });

    const response = await provider.callApi("ignored", { vars: { prompt: "Implement logging" } });

    expect(response.output).toContain("Template: implementation-review");
    expect(response.metadata).toEqual(
      expect.objectContaining({ templateId: "implementation-review", valid: true }),
    );
  });
});
