import { describe, expect, it, vi } from "vitest";
import { serializeWorkItemDag, setWorkItemTraceAttributes, runWorkQueueSpan } from "../../src/work-queue/telemetry.js";
import type { WorkItem } from "../../src/work-queue/schema.js";

const item: WorkItem = {
  id: "bd-root",
  title: "Run Decision Council",
  status: "open",
  type: "task",
  priority: 1,
  labels: ["weavekit"],
  dependencies: [{ type: "waits-for", id: "bd-parent" }],
};

describe("work queue telemetry", () => {
  it("serializes a compact DAG payload for Langfuse metadata", () => {
    expect(serializeWorkItemDag(item)).toEqual({
      id: "bd-root",
      title: "Run Decision Council",
      status: "open",
      type: "task",
      priority: 1,
      labels: ["weavekit"],
      dependencies: [{ type: "waits-for", id: "bd-parent" }],
    });
  });

  it("sets trace metadata and observation attributes on a span", () => {
    const attributes: Record<string, unknown> = {};
    const span = { setAttribute: vi.fn((key: string, value: unknown) => { attributes[key] = value; }) };

    setWorkItemTraceAttributes(span as never, item);

    expect(attributes).toMatchObject({
      "weavekit.work_queue.item_id": "bd-root",
      "weavekit.work_queue.item_title": "Run Decision Council",
      "langfuse.trace.metadata.beads.item_id": "bd-root",
      "langfuse.trace.metadata.beads.item_title": "Run Decision Council",
    });
    expect(JSON.parse(attributes["langfuse.trace.metadata.beads.dag"] as string)).toMatchObject({ id: "bd-root" });
  });

  it("wraps lifecycle work in a named child span", async () => {
    const result = await runWorkQueueSpan("claim", { itemId: "bd-root" }, async () => "claimed");
    expect(result).toBe("claimed");
  });
});
