import { describe, expect, it } from "vitest";
import { replayViewStateFromEvents } from "../../src/macro-workflow/replay.js";
import { runMacroWorkflow } from "../../src/macro-workflow/runner.js";
import type { RuntimeWorkflowPlan, WorkflowReplayEvent } from "../../src/macro-workflow/types.js";

describe("replayViewStateFromEvents", () => {
  it("adds a planning node before the first execution node", () => {
    const view = replayViewStateFromEvents([
      {
        seq: 1,
        ts: "2026-06-30T00:00:00.000Z",
        kind: "planning-started",
        phase: "planning",
        nodeId: "workflow-planning",
      },
      {
        seq: 2,
        ts: "2026-06-30T00:00:01.000Z",
        kind: "node-added",
        nodeId: "research-1",
        node: {
          id: "research-1",
          kind: "research",
          harness: "research",
          title: "Research",
          prompt: "Research the request",
          dependsOn: [],
          gates: [],
          writeMode: "read-only",
          replanPolicy: "never",
        },
      },
    ]);

    expect(view.nodes.map((node) => node.id)).toEqual(["workflow-planning", "research-1"]);
    expect(view.activePhase).toBe("planning");
  });

  it("emits a planning-started replay event before execution", async () => {
    const events: WorkflowReplayEvent[] = [];
    const plan: RuntimeWorkflowPlan = {
      id: "plan-1",
      objective: "Ship the feature",
      templateId: "implementation-review",
      maxReplans: 0,
      nodes: [
        {
          id: "research-1",
          kind: "research",
          harness: "research",
          title: "Research",
          prompt: "Research the request",
          dependsOn: [],
          gates: [],
          writeMode: "read-only",
          replanPolicy: "never",
        },
      ],
    };

    await runMacroWorkflow(plan, {
      onReplayEvent(event) {
        events.push(event);
      },
    });

    expect(events[0]?.kind).toBe("planning-started");
    expect(events.map((event) => event.kind)).toEqual([
      "planning-started",
      "node-added",
      "planning-complete",
      "node-status-changed",
      "node-status-changed",
      "run-completed",
    ]);
  });
});
