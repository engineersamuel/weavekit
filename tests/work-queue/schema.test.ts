import { describe, expect, it } from "vitest";
import {
  CompleteWorkItemInputSchema,
  CreateWorkItemInputSchema,
  ReadyWorkFilterSchema,
  WorkDependencySchema,
  WorkItemSchema,
} from "../../src/work-queue/schema.js";

describe("work queue schemas", () => {
  it("parses a minimal ready work item", () => {
    const item = WorkItemSchema.parse({
      id: "bd-a1b2",
      title: "Run the decision council on the Beads trade-off",
      status: "open",
      type: "task",
      priority: 1,
    });

    expect(item.labels).toEqual([]);
    expect(item.dependencies).toEqual([]);
    expect(item.description).toBeUndefined();
  });

  it("parses a discovered-from dependency", () => {
    const dep = WorkDependencySchema.parse({ type: "discovered-from", id: "bd-root" });

    expect(dep).toEqual({ type: "discovered-from", id: "bd-root" });
  });

  it("rejects an invalid dependency type", () => {
    expect(() => WorkDependencySchema.parse({ type: "maybe-blocks", id: "bd-root" })).toThrow();
  });

  it("parses a ready-work filter", () => {
    const filter = ReadyWorkFilterSchema.parse({ priority: 1, assignee: "copilot" });

    expect(filter.priority).toBe(1);
    expect(filter.assignee).toBe("copilot");
  });

  it("parses a create input with defaults", () => {
    const input = CreateWorkItemInputSchema.parse({
      title: "Implement Beads adapter",
      description: "Shell out to bd using JSON output.",
    });

    expect(input.type).toBe("task");
    expect(input.priority).toBe(2);
    expect(input.dependencies).toEqual([]);
  });

  it("requires a completion reason", () => {
    expect(() => CompleteWorkItemInputSchema.parse({ reason: "" })).toThrow();
  });
});
