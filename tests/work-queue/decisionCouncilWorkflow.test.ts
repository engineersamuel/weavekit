import { describe, expect, it } from "vitest";
import { createDecisionCouncilBeadsWorkflow } from "../../src/work-queue/decisionCouncilWorkflow.js";
import type { WorkQueueBackend } from "../../src/work-queue/backend.js";
import type { CreateWorkItemInput, ReadyWorkFilter, WorkItem } from "../../src/work-queue/schema.js";

function itemFrom(input: CreateWorkItemInput, id: string): WorkItem {
  return {
    id,
    title: input.title,
    description: input.description,
    status: "open",
    type: input.type,
    priority: input.priority,
    labels: input.labels,
    dependencies: input.dependencies,
  };
}

describe("createDecisionCouncilBeadsWorkflow", () => {
  it("creates a four-item Decision Council workflow DAG", async () => {
    const created: CreateWorkItemInput[] = [];
    const backend: WorkQueueBackend = {
      async ready(_filter?: ReadyWorkFilter) { return []; },
      async show() { throw new Error("not used"); },
      async claim(id: string) { throw new Error(`not used ${id}`); },
      async create(input: CreateWorkItemInput) {
        created.push(input);
        return itemFrom(input, `bd-${created.length}`);
      },
      async close() { throw new Error("not used"); },
      async sync() {},
    };

    const workflow = await createDecisionCouncilBeadsWorkflow({
      backend,
      title: "Evaluate architecture",
      inputPath: "examples/design-question.md",
      outputDir: "runs/generated",
    });

    expect(workflow.items.map((item) => item.id)).toEqual(["bd-1", "bd-2", "bd-3", "bd-4"]);
    expect(workflow.rootItem.id).toBe("bd-1");
    expect(workflow.runItem.id).toBe("bd-2");
    expect(workflow.reviewItem.id).toBe("bd-3");
    expect(workflow.followUpItem.id).toBe("bd-4");
    expect(created.map((input) => input.title)).toEqual([
      "Frame decision question: Evaluate architecture",
      "Run Decision Council: Evaluate architecture",
      "Review Decision Council report: Evaluate architecture",
      "Implement next experiment: Evaluate architecture",
    ]);
    expect(created[1]?.dependencies).toEqual([{ type: "waits-for", id: "bd-1" }]);
    expect(created[2]?.dependencies).toEqual([{ type: "waits-for", id: "bd-2" }]);
    expect(created[3]?.dependencies).toEqual([{ type: "waits-for", id: "bd-3" }]);
  });
});
