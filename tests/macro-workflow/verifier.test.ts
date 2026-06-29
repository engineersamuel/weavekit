import { describe, expect, it } from "vitest";
import {
  WorkflowGateKind,
  WorkflowHarnessKind,
  WorkflowNodeKind,
  assertValidWorkflowPlan,
  verifyWorkflowPlan,
} from "../../src/macro-workflow/index.js";

function validPlan() {
  return {
    id: "implement-rich-logging",
    objective: "Choose and implement rich logging for acme.",
    templateId: "implementation-review",
    maxReplans: 1,
    nodes: [
      {
        id: "research",
        kind: WorkflowNodeKind.RESEARCH,
        harness: WorkflowHarnessKind.RESEARCH,
        title: "Research repository logging context",
        prompt: "Inspect the repository and summarize logging constraints.",
        dependsOn: [],
        gates: [WorkflowGateKind.OUTPUT_CONTRACT],
        writeMode: "read-only" as const,
        replanPolicy: "on-contract-failure" as const,
      },
      {
        id: "council",
        kind: WorkflowNodeKind.DELIBERATION,
        harness: WorkflowHarnessKind.DECISION_COUNCIL,
        title: "Choose logging strategy",
        prompt: "Debate logging options using the research result.",
        dependsOn: ["research"],
        gates: [WorkflowGateKind.OUTPUT_CONTRACT],
        writeMode: "read-only" as const,
        replanPolicy: "on-review-rejection" as const,
      },
      {
        id: "implement",
        kind: WorkflowNodeKind.IMPLEMENTATION,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Implement accepted logging plan",
        prompt: "Apply the accepted logging changes.",
        dependsOn: ["council"],
        gates: [WorkflowGateKind.VERIFICATION],
        writeMode: "single-writer" as const,
        replanPolicy: "on-verification-failure" as const,
      },
      {
        id: "verify",
        kind: WorkflowNodeKind.VERIFICATION,
        harness: WorkflowHarnessKind.VERIFIER,
        title: "Run verification",
        prompt: "Run the targeted checks for the implementation.",
        dependsOn: ["implement"],
        gates: [WorkflowGateKind.VERIFICATION],
        writeMode: "read-only" as const,
        replanPolicy: "never" as const,
      },
      {
        id: "report",
        kind: WorkflowNodeKind.VISUALIZATION,
        harness: WorkflowHarnessKind.REPORTER,
        title: "Write final report",
        prompt: "Summarize plan, execution, verification, and next steps.",
        dependsOn: ["verify"],
        gates: [WorkflowGateKind.OUTPUT_CONTRACT],
        writeMode: "read-only" as const,
        replanPolicy: "never" as const,
      },
    ],
  };
}

describe("macro workflow verifier", () => {
  it("accepts a valid implementation-review macro workflow", () => {
    const result = verifyWorkflowPlan(validPlan());

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(() => assertValidWorkflowPlan(validPlan())).not.toThrow();
  });

  it("rejects cycles", () => {
    const plan = validPlan();
    plan.nodes[0]!.dependsOn = ["report"];

    const result = verifyWorkflowPlan(plan);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "cycle-detected" }),
    );
  });

  it("rejects parallel single-writer nodes", () => {
    const plan = validPlan();
    plan.nodes.splice(3, 0, {
      id: "second-writer",
      kind: WorkflowNodeKind.IMPLEMENTATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Second implementation writer",
      prompt: "Also edit code.",
      dependsOn: ["council"],
      gates: [WorkflowGateKind.VERIFICATION],
      writeMode: "single-writer" as const,
      replanPolicy: "on-verification-failure" as const,
    });

    const result = verifyWorkflowPlan(plan);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "parallel-writers" }),
    );
  });

  it("rejects implementation plans without a downstream verification node", () => {
    const plan = validPlan();
    plan.nodes = plan.nodes.filter((node) => node.id !== "verify");
    plan.nodes.find((node) => node.id === "report")!.dependsOn = ["implement"];

    const result = verifyWorkflowPlan(plan);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "missing-verification" }),
    );
  });
});
