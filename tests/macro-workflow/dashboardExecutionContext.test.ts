import { describe, expect, it } from "vitest";
import {
  resolveNodeExecutionDisplay,
  resolveNodeModelDisplay,
} from "../../src/macro-workflow/dashboard/executionContext.js";
import { WorkflowHarnessKind, WorkflowNodeKind, WorkflowNodeStatus } from "../../src/macro-workflow/types.js";
import type {
  MacroWorkflowRunStateLike,
  RuntimeWorkflowNode,
  WorkflowExecutionMetadata,
  WorkflowNodeExecutionResult,
} from "../../src/macro-workflow/types.js";

describe("dashboard execution context helpers", () => {
  it("prefers completed result execution over live execution metadata", () => {
    const completedExecution: WorkflowExecutionMetadata = {
      executor: "copilot-sdk",
      prompt: "completed actual prompt",
      calls: [{ executor: "copilot-sdk", prompt: "completed call prompt", model: "gpt-completed" }],
    };
    const liveExecution: WorkflowExecutionMetadata = {
      executor: "copilot-sdk",
      prompt: "live actual prompt",
      calls: [{ executor: "copilot-sdk", prompt: "live call prompt", model: "gpt-live" }],
    };

    const display = resolveNodeExecutionDisplay({
      node: nodeFixture(),
      result: resultFixture(completedExecution),
      state: stateFixture({ "node-1": liveExecution }),
    });

    expect(display.hasActualExecution).toBe(true);
    expect(display.execution).toBe(completedExecution);
    expect(display.calls.map((call) => call.prompt)).toEqual(["completed call prompt"]);
  });

  it("uses live execution metadata when no completed result exists", () => {
    const liveExecution: WorkflowExecutionMetadata = {
      executor: "copilot-sdk",
      mode: "research",
      prompt: "live actual prompt",
      cwd: "/repo/project",
      model: "gpt-live",
    };

    const display = resolveNodeExecutionDisplay({
      node: nodeFixture(),
      result: undefined,
      state: stateFixture({ "node-1": liveExecution }),
    });

    expect(display.hasActualExecution).toBe(true);
    expect(display.execution).toBe(liveExecution);
    expect(display.calls).toEqual([{
      executor: "copilot-sdk",
      operation: undefined,
      mode: "research",
      prompt: "live actual prompt",
      cwd: "/repo/project",
      model: "gpt-live",
    }]);
  });

  it("does not synthesize the planned node prompt as an actual execution call", () => {
    const display = resolveNodeExecutionDisplay({
      node: nodeFixture(),
      result: undefined,
      state: stateFixture(),
    });

    expect(display.plannedPrompt).toBe("planned prompt");
    expect(display.hasActualExecution).toBe(false);
    expect(display.execution).toBeUndefined();
    expect(display.calls).toEqual([]);
  });

  it("uses live execution metadata for model display before falling back to the planned node model", () => {
    const state = stateFixture({
      "node-1": {
        executor: "copilot-sdk",
        model: "gpt-live",
        calls: [{ executor: "copilot-sdk", model: "gpt-call" }],
      },
    });

    expect(resolveNodeModelDisplay(nodeFixture({ model: "gpt-planned" }), state)).toBe("gpt-live");
  });
});

function nodeFixture(overrides: Partial<RuntimeWorkflowNode> = {}): RuntimeWorkflowNode {
  return {
    id: "node-1",
    kind: WorkflowNodeKind.RESEARCH,
    harness: WorkflowHarnessKind.COPILOT_SDK,
    title: "Node",
    model: "gpt-planned",
    prompt: "planned prompt",
    dependsOn: [],
    gates: [],
    writeMode: "read-only",
    replanPolicy: "never",
    ...overrides,
  };
}

function resultFixture(execution: WorkflowExecutionMetadata): WorkflowNodeExecutionResult {
  return {
    nodeId: "node-1",
    status: WorkflowNodeStatus.PASSED,
    output: "complete",
    execution,
  };
}

function stateFixture(activeNodeExecutions?: MacroWorkflowRunStateLike["activeNodeExecutions"]): MacroWorkflowRunStateLike {
  return {
    planId: "plan-1",
    objective: "Original request",
    templateId: "verification-optimizer",
    status: "running",
    startedAt: new Date("2026-07-06T00:00:00.000Z"),
    currentPlan: {
      id: "plan-1",
      objective: "Original request",
      templateId: "verification-optimizer",
      maxReplans: 0,
      nodes: [nodeFixture()],
    },
    nodeResults: [],
    replans: [],
    activeNodeExecutions,
  };
}
