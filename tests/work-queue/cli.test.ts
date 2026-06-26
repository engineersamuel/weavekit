import { describe, expect, it } from "vitest";
import { parseWorkQueueCliArgs, runWorkQueueCli } from "../../src/work-queue/cli.js";
import type { WorkQueueBackend } from "../../src/work-queue/backend.js";
import type { CreateWorkItemInput, ReadyWorkFilter, WorkItem } from "../../src/work-queue/schema.js";

const item: WorkItem = {
  id: "bd-a1b2",
  title: "Ready item",
  status: "open",
  type: "task",
  priority: 1,
  labels: [],
  dependencies: [],
};

function fakeBackend(events: string[]): WorkQueueBackend {
  return {
    async ready(filter?: ReadyWorkFilter) {
      events.push(`ready:${JSON.stringify(filter ?? {})}`);
      return [item];
    },
    async show(id: string) {
      events.push(`show:${id}`);
      return item;
    },
    async claim(id: string) {
      events.push(`claim:${id}`);
      return { ...item, status: "in_progress" };
    },
    async create(input: CreateWorkItemInput) {
      events.push(`create:${input.title}`);
      return { ...item, id: "bd-new", title: input.title, priority: input.priority ?? 2, type: input.type ?? "task" };
    },
    async close(id: string) {
      events.push(`close:${id}`);
      return { ...item, status: "closed" };
    },
    async sync() {
      events.push("sync");
    },
  };
}

describe("work queue CLI", () => {
  it("parses ready filters", () => {
    expect(parseWorkQueueCliArgs(["ready", "--priority", "1", "--assignee", "copilot", "--limit", "3"])).toEqual({
      command: "ready",
      cwd: process.cwd(),
      filter: { priority: 1, assignee: "copilot", limit: 3 },
    });
  });

  it("parses create input with dependencies", () => {
    expect(parseWorkQueueCliArgs([
      "create",
      "--title",
      "Follow up",
      "--description",
      "From council",
      "--priority",
      "2",
      "--type",
      "task",
      "--label",
      "weavekit",
      "--dep",
      "discovered-from:bd-root",
    ])).toEqual({
      command: "create",
      cwd: process.cwd(),
      input: {
        title: "Follow up",
        description: "From council",
        priority: 2,
        type: "task",
        labels: ["weavekit"],
        dependencies: [{ type: "discovered-from", id: "bd-root" }],
      },
    });
  });

  it("runs ready and writes JSON", async () => {
    const events: string[] = [];
    const writes: string[] = [];

    await runWorkQueueCli(["ready", "--priority", "1"], {
      backend: fakeBackend(events),
      write: (text) => writes.push(text),
    });

    expect(events).toEqual(['ready:{"priority":1}']);
    expect(JSON.parse(writes.join(""))[0].id).toBe("bd-a1b2");
  });

  it("runs close with a required reason", async () => {
    const events: string[] = [];

    await runWorkQueueCli(["close", "bd-a1b2", "--reason", "Done"], {
      backend: fakeBackend(events),
      write: () => undefined,
    });

    expect(events).toEqual(["close:bd-a1b2"]);
  });
});
