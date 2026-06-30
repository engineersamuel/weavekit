import { describe, expect, it } from "vitest";
import { applyReplanPatch, runMacroWorkflow } from "../../src/macro-workflow/runner.js";
import { createStaticHarnessRegistry } from "../../src/macro-workflow/harness.js";
import { materializeWorkflowPlan } from "../../src/macro-workflow/templates.js";
import { WorkflowGateKind, WorkflowHarnessKind, WorkflowNodeKind, type RuntimeWorkflowPlan } from "../../src/macro-workflow/types.js";

describe("macro workflow replanning", () => {
  it("applies a patch only to incomplete nodes", () => {
    const plan = materializeWorkflowPlan("implementation-review", { objective: "Implement rich logging" });
    const patched = applyReplanPatch(
      plan,
      {
        reason: "verification-failure",
        replaceRemainingNodeIds: ["implement", "verify", "report"],
        newNodes: [
          {
            id: "implement-retry",
            kind: "implementation",
            harness: WorkflowHarnessKind.COPILOT_SDK,
            title: "Retry implementation",
            prompt: "Retry the implementation",
            dependsOn: ["council"],
            gates: ["verification"],
            writeMode: "single-writer",
            replanPolicy: "never",
          },
        ],
      },
      new Set(["research", "council"]),
    );

    expect(patched.nodes.some((node) => node.id === "implement")).toBe(false);
    expect(patched.nodes.some((node) => node.id === "implement-retry")).toBe(true);
  });

  it("replans once when a gate-triggering node fails", async () => {
    const plan = materializeWorkflowPlan("implementation-review", { objective: "Implement rich logging" });
    const harnesses = createStaticHarnessRegistry({
      [WorkflowHarnessKind.RESEARCH]: async () => ({ status: "passed", output: "ok" }),
      [WorkflowHarnessKind.DECISION_COUNCIL]: async () => ({ status: "passed", output: "ok" }),
      [WorkflowHarnessKind.COPILOT_SDK]: async (node) => ({ status: node.id === "implement" ? "failed" : "passed", output: "ok" }),
      [WorkflowHarnessKind.VERIFIER]: async () => ({ status: "passed", output: "ok" }),
      [WorkflowHarnessKind.REPORTER]: async () => ({ status: "passed", output: "ok" }),
    });
    const state = await runMacroWorkflow(plan, {
      harnesses,
      replanner: {
        async generateReplanPatch() {
          return {
            reason: "verification-failure",
            replaceRemainingNodeIds: ["implement", "verify", "report"],
            newNodes: [
              {
                id: "implement-retry",
                kind: "implementation",
                harness: WorkflowHarnessKind.COPILOT_SDK,
                title: "Retry implementation",
                prompt: "Retry the implementation",
                dependsOn: ["council"],
                gates: ["verification"],
                writeMode: "single-writer",
                replanPolicy: "never",
              },
              {
                id: "verify-retry",
                kind: "verification",
                harness: WorkflowHarnessKind.VERIFIER,
                title: "Retry verification",
                prompt: "Retry the verification",
                dependsOn: ["implement-retry"],
                gates: ["verification"],
                writeMode: "read-only",
                replanPolicy: "never",
              },
            ],
          };
        },
      },
    });

    expect(state.replans).toHaveLength(1);
    expect(state.status).toBe("passed");
    expect(state.plan.nodes.some((node) => node.id === "implement-retry")).toBe(true);
  });

  it("stops replanning once the configured budget is exhausted", async () => {
    const plan: RuntimeWorkflowPlan = {
      id: "bounded-replan",
      objective: "Implement the change",
      templateId: "implementation-review",
      maxReplans: 1,
      nodes: [
        {
          id: "implement",
          kind: WorkflowNodeKind.IMPLEMENTATION,
          harness: WorkflowHarnessKind.COPILOT_SDK,
          title: "Implement change",
          prompt: "Implement the change",
          dependsOn: [],
          gates: [WorkflowGateKind.VERIFICATION],
          writeMode: "single-writer",
          replanPolicy: "on-verification-failure",
        },
        {
          id: "verify",
          kind: WorkflowNodeKind.VERIFICATION,
          harness: WorkflowHarnessKind.VERIFIER,
          title: "Verify change",
          prompt: "Verify the change",
          dependsOn: ["implement"],
          gates: [WorkflowGateKind.VERIFICATION],
          writeMode: "read-only",
          replanPolicy: "never",
        },
      ],
    };

    let replannerCalls = 0;
    const harnesses = createStaticHarnessRegistry({
      [WorkflowHarnessKind.COPILOT_SDK]: async () => ({ status: "failed", output: "boom", error: "boom" }),
      [WorkflowHarnessKind.VERIFIER]: async () => ({ status: "passed", output: "ok" }),
    });

    const state = await runMacroWorkflow(plan, {
      harnesses,
      replanner: {
        async generateReplanPatch() {
          replannerCalls += 1;
          if (replannerCalls > 1) {
            return undefined as never;
          }
          return {
            reason: "verification-failure",
            replaceRemainingNodeIds: ["implement", "verify"],
            newNodes: [
              {
                id: "implement-retry",
                kind: WorkflowNodeKind.IMPLEMENTATION,
                harness: WorkflowHarnessKind.COPILOT_SDK,
                title: "Retry implementation",
                prompt: "Retry the implementation",
                dependsOn: [],
                gates: [WorkflowGateKind.VERIFICATION],
                writeMode: "single-writer",
                replanPolicy: "never",
              },
              {
                id: "verify-retry",
                kind: WorkflowNodeKind.VERIFICATION,
                harness: WorkflowHarnessKind.VERIFIER,
                title: "Retry verification",
                prompt: "Retry the verification",
                dependsOn: ["implement-retry"],
                gates: [WorkflowGateKind.VERIFICATION],
                writeMode: "read-only",
                replanPolicy: "never",
              },
            ],
          };
        },
      },
    });

    expect(replannerCalls).toBe(1);
    expect(state.status).toBe("failed");
    expect(state.replans).toHaveLength(1);
  });
});
