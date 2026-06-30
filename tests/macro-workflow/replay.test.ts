import { describe, expect, it } from "vitest";
import { replayViewStateFromEvents } from "../../src/macro-workflow/replay.js";

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
});
