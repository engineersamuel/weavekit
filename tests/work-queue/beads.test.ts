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
