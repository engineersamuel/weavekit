import { describe, expect, it } from "vitest";
import { createInMemoryMacroWorkflowLogger } from "../../src/macro-workflow/logger.js";

describe("macro workflow logger", () => {
  it("records run, node, and replan events", () => {
    const logger = createInMemoryMacroWorkflowLogger();

    logger.emit({
      type: "macro-workflow.run.started",
      planId: "plan-1",
      timestamp: new Date("2026-06-29T00:00:00Z"),
    });
    logger.emit({
      type: "macro-workflow.node.completed",
      planId: "plan-1",
      nodeId: "research",
      timestamp: new Date("2026-06-29T00:00:01Z"),
    });

    expect(logger.events).toHaveLength(2);
    expect(logger.events[0]).toMatchObject({ type: "macro-workflow.run.started" });
    expect(logger.events[1]).toMatchObject({ nodeId: "research" });
  });
});
