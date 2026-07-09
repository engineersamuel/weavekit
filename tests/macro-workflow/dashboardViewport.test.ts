import { describe, expect, it } from "vitest";
import {
  createWorkflowViewportFitKey,
  shouldFitWorkflowViewport,
} from "../../src/macro-workflow/dashboard/viewport.js";

describe("workflow dashboard viewport fitting", () => {
  it("does not refit when only node status/action data changes", () => {
    const previousFitKey = createWorkflowViewportFitKey({
      runId: "run-1",
      nodes: [
        { id: "planning", position: { x: 40, y: 40 } },
        { id: "report", position: { x: 420, y: 40 } },
      ],
      edges: [{ id: "planning-report", source: "planning", target: "report" }],
    });
    const nextFitKey = createWorkflowViewportFitKey({
      runId: "run-1",
      nodes: [
        { id: "planning", position: { x: 40, y: 40 } },
        { id: "report", position: { x: 420, y: 40 } },
      ],
      edges: [{ id: "planning-report", source: "planning", target: "report" }],
    });

    expect(
      shouldFitWorkflowViewport({
        autoTrackNewRuns: true,
        nodeCount: 2,
        fitKey: nextFitKey,
        previousFitKey,
      }),
    ).toBe(false);
  });

  it("refits when the selected run or graph topology changes", () => {
    const previousFitKey = createWorkflowViewportFitKey({
      runId: "run-1",
      nodes: [{ id: "planning", position: { x: 40, y: 40 } }],
      edges: [],
    });

    expect(
      shouldFitWorkflowViewport({
        autoTrackNewRuns: true,
        nodeCount: 1,
        fitKey: createWorkflowViewportFitKey({
          runId: "run-2",
          nodes: [{ id: "planning", position: { x: 40, y: 40 } }],
          edges: [],
        }),
        previousFitKey,
      }),
    ).toBe(true);

    expect(
      shouldFitWorkflowViewport({
        autoTrackNewRuns: true,
        nodeCount: 2,
        fitKey: createWorkflowViewportFitKey({
          runId: "run-1",
          nodes: [
            { id: "planning", position: { x: 40, y: 40 } },
            { id: "report", position: { x: 420, y: 40 } },
          ],
          edges: [{ id: "planning-report", source: "planning", target: "report" }],
        }),
        previousFitKey,
      }),
    ).toBe(true);
  });

  it("does not refit while live tracking is disabled", () => {
    expect(
      shouldFitWorkflowViewport({
        autoTrackNewRuns: false,
        nodeCount: 1,
        fitKey: "run-1::planning@0,0::",
        previousFitKey: null,
      }),
    ).toBe(false);
  });
});
