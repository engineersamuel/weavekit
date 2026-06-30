import { describe, expect, it } from "vitest";
import { createStaticHarnessRegistry } from "../../src/macro-workflow/harness.js";
import { materializeWorkflowPlan } from "../../src/macro-workflow/templates.js";
import { runMacroWorkflow } from "../../src/macro-workflow/runner.js";
import { WorkflowHarnessKind } from "../../src/macro-workflow/types.js";

describe("macro workflow runner", () => {
  it("executes a plan end to end using the static harness registry", async () => {
    const plan = materializeWorkflowPlan("implementation-review", { objective: "Implement rich logging" });
    const harnesses = createStaticHarnessRegistry({
      [WorkflowHarnessKind.RESEARCH]: async () => ({ status: "passed", output: "insights" }),
      [WorkflowHarnessKind.DECISION_COUNCIL]: async () => ({ status: "passed", output: "consensus" }),
      [WorkflowHarnessKind.COPILOT_SDK]: async () => ({ status: "passed", output: "implemented" }),
      [WorkflowHarnessKind.VERIFIER]: async () => ({ status: "passed", output: "verified" }),
      [WorkflowHarnessKind.REPORTER]: async () => ({ status: "passed", output: "report" }),
    });

    const state = await runMacroWorkflow(plan, { harnesses });

    expect(state.status).toBe("passed");
    expect(state.nodeResults).toHaveLength(plan.nodes.length);
    expect(state.nodeResults.at(-1)?.status).toBe("passed");
  });
});
