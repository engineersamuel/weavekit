import { describe, expect, it } from "vitest";
import { BeadsCliWorkQueue, normalizeRunnerError, type BeadsCommandRunner } from "../../src/work-queue/beads.js";
import { WorkQueueBackendError } from "../../src/work-queue/backend.js";

function runnerFor(calls: string[][], outputs: unknown[]): BeadsCommandRunner {
  return async (_bin, args) => {
    calls.push(args);
    const output = outputs.shift();
    if (output instanceof Error) throw output;
    return { stdout: JSON.stringify(output), stderr: "", exitCode: 0 };
  };
}

describe("BeadsCliWorkQueue", () => {
  it("lists ready work with JSON output", async () => {
    const calls: string[][] = [];
    const queue = new BeadsCliWorkQueue({
      cwd: "/repo",
      runCommand: runnerFor(calls, [[{ id: "bd-a1b2", title: "Ready", status: "open", type: "task", priority: 1 }]]),
    });

    const ready = await queue.ready({ priority: 1, assignee: "copilot", limit: 5 });

    expect(ready[0]?.id).toBe("bd-a1b2");
    expect(calls).toEqual([["ready", "--json", "--priority", "1", "--assignee", "copilot", "--limit", "5"]]);
  });

  it("claims work atomically", async () => {
    const calls: string[][] = [];
    const queue = new BeadsCliWorkQueue({
      cwd: "/repo",
      runCommand: runnerFor(calls, [{ id: "bd-a1b2", title: "Ready", status: "in_progress", type: "task", priority: 1 }]),
    });

    const claimed = await queue.claim("bd-a1b2");

    expect(claimed.status).toBe("in_progress");
    expect(calls).toEqual([["update", "bd-a1b2", "--claim", "--json"]]);
  });

  it("creates linked discovered work", async () => {
    const calls: string[][] = [];
    const queue = new BeadsCliWorkQueue({
      cwd: "/repo",
      runCommand: runnerFor(calls, [{ id: "bd-new", title: "Follow up", status: "open", type: "task", priority: 2 }]),
    });

    await queue.create({
      title: "Follow up",
      description: "Created from the council report.",
      type: "task",
      priority: 2,
      dependencies: [{ type: "discovered-from", id: "bd-root" }],
      labels: ["weavekit"],
    });

    expect(calls).toEqual([
      [
        "create",
        "Follow up",
        "-t",
        "task",
        "-p",
        "2",
        "--description",
        "Created from the council report.",
        "--label",
        "weavekit",
        "--deps",
        "discovered-from:bd-root",
        "--json",
      ],
    ]);
  });

  it("throws when bd returns invalid JSON", async () => {
    const queue = new BeadsCliWorkQueue({
      cwd: "/repo",
      runCommand: async () => ({ stdout: "not json", stderr: "", exitCode: 0 }),
    });

    await expect(queue.ready()).rejects.toThrow("bd ready returned invalid JSON");
  });

  it("syncs using bd dolt push", async () => {
    const calls: string[][] = [];
    const queue = new BeadsCliWorkQueue({
      cwd: "/repo",
      runCommand: runnerFor(calls, [""]),
    });

    await queue.sync();

    expect(calls).toEqual([["dolt", "push"]]);
  });
});

describe("BeadsCliWorkQueue — Beads native JSON shape", () => {
  it("normalizes issue_type to type on ready", async () => {
    const queue = new BeadsCliWorkQueue({
      cwd: "/repo",
      runCommand: runnerFor([], [[
        { id: "bd-a1b2", title: "Ready", status: "open", issue_type: "decision", priority: 1 },
      ]]),
    });

    const items = await queue.ready();

    expect(items[0]?.type).toBe("decision");
    expect(items[0]?.id).toBe("bd-a1b2");
  });

  it("normalizes wrapped { items } response from ready", async () => {
    const queue = new BeadsCliWorkQueue({
      cwd: "/repo",
      runCommand: runnerFor([], [{
        items: [{ id: "bd-b1c2", title: "Story", status: "open", issue_type: "story", priority: 2 }],
      }]),
    });

    const items = await queue.ready();

    expect(items[0]?.type).toBe("story");
    expect(items[0]?.id).toBe("bd-b1c2");
  });

  it("normalizes wrapped { issue } response from show", async () => {
    const queue = new BeadsCliWorkQueue({
      cwd: "/repo",
      runCommand: runnerFor([], [{
        issue: { id: "bd-c3d4", title: "Spike", status: "open", issue_type: "spike", priority: 3 },
      }]),
    });

    const item = await queue.show("bd-c3d4");

    expect(item.type).toBe("spike");
    expect(item.id).toBe("bd-c3d4");
  });

  it("normalizes dependency_type to type on claim", async () => {
    const queue = new BeadsCliWorkQueue({
      cwd: "/repo",
      runCommand: runnerFor([], [{
        id: "bd-e5f6",
        title: "Milestone",
        status: "in_progress",
        issue_type: "milestone",
        priority: 0,
        dependencies: [{ dependency_type: "blocks", id: "bd-root" }],
      }]),
    });

    const item = await queue.claim("bd-e5f6");

    expect(item.type).toBe("milestone");
    expect(item.dependencies[0]?.type).toBe("blocks");
    expect(item.dependencies[0]?.id).toBe("bd-root");
  });

  it("normalizes issue_type on create response", async () => {
    const queue = new BeadsCliWorkQueue({
      cwd: "/repo",
      runCommand: runnerFor([], [{ id: "bd-new", title: "Explore Beads", status: "open", issue_type: "spike", priority: 2 }]),
    });

    const item = await queue.create({ title: "Explore Beads", type: "task", priority: 2, labels: [], dependencies: [] });

    expect(item.type).toBe("spike");
  });

  it("normalizes issue_type on close response", async () => {
    const queue = new BeadsCliWorkQueue({
      cwd: "/repo",
      runCommand: runnerFor([], [{ id: "bd-g7h8", title: "Done", status: "closed", issue_type: "story", priority: 1 }]),
    });

    const item = await queue.close("bd-g7h8", { reason: "Completed" });

    expect(item.type).toBe("story");
    expect(item.status).toBe("closed");
  });
});

describe("normalizeRunnerError", () => {
  it("maps numeric code to exitCode and omits causeCode", () => {
    const err = Object.assign(new Error("exited"), { code: 2, stdout: "out", stderr: "err" });
    expect(() => normalizeRunnerError(["ready"], err)).toThrow(WorkQueueBackendError);
    try {
      normalizeRunnerError(["ready"], err);
    } catch (e) {
      const wqe = e as WorkQueueBackendError;
      expect(wqe.message).toBe("bd ready failed with exit code 2");
      expect(wqe.causeDetails).toMatchObject({ exitCode: 2, stdout: "out", stderr: "err" });
      expect((wqe.causeDetails as Record<string, unknown>)["causeCode"]).toBeUndefined();
    }
  });

  it("maps ENOENT string code to exitCode 1 and preserves causeCode", () => {
    const err = Object.assign(new Error("spawn bd ENOENT"), { code: "ENOENT", stdout: undefined, stderr: undefined });
    expect(() => normalizeRunnerError(["ready"], err)).toThrow(WorkQueueBackendError);
    try {
      normalizeRunnerError(["ready"], err);
    } catch (e) {
      const wqe = e as WorkQueueBackendError;
      expect(wqe.message).toBe("bd ready failed with exit code 1");
      expect(wqe.causeDetails).toMatchObject({ exitCode: 1, causeCode: "ENOENT" });
    }
  });
});
