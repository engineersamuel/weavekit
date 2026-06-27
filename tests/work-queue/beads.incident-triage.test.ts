import { describe, expect, it } from "vitest";
import {
  BeadsCliWorkQueue,
  type BeadsCommandRunner,
} from "../../src/work-queue/beads.js";
import {
  INCIDENT_TRIAGE_STEPS,
  toCreateInput,
} from "./fixtures/beadsIncidentTriageScenario.js";

function deterministicBeadsRunner(calls: string[][]): BeadsCommandRunner {
  const created = new Map<string, { title: string; deps: string[] }>();
  const closed = new Set<string>();

  return async (_bin, args) => {
    calls.push(args);
    const [command] = args;

    if (command === "create") {
      const title = args[1]!;
      const depPairs = args.filter((token) => token.startsWith("waits-for:"));
      const id =
        INCIDENT_TRIAGE_STEPS.find((step) => step.title === title)?.id ??
        (() => {
          throw new Error(`Unknown title: ${title}`);
        })();
      created.set(id, { title, deps: depPairs.map((dep) => dep.split(":")[1]!) });
      return {
        stdout: JSON.stringify({
          id,
          title,
          status: "open",
          issue_type: "task",
          priority: 2,
          dependencies: depPairs.map((dep) => ({
            dependency_type: "waits-for",
            id: dep.split(":")[1]!,
          })),
        }),
        stderr: "",
        exitCode: 0,
      };
    }

    if (command === "ready") {
      const next = INCIDENT_TRIAGE_STEPS.find((step) => {
        if (closed.has(step.id)) return false;
        const deps = created.get(step.id)?.deps ?? [];
        return deps.every((dep) => closed.has(dep));
      });
      const items = next
        ? [
            {
              id: next.id,
              title: next.title,
              status: "open",
              issue_type: "task",
              priority: 2,
              dependencies: [],
            },
          ]
        : [];
      return { stdout: JSON.stringify({ items }), stderr: "", exitCode: 0 };
    }

    if (command === "update") {
      const id = args[1]!;
      const step = INCIDENT_TRIAGE_STEPS.find((candidate) => candidate.id === id)!;
      return {
        stdout: JSON.stringify({
          updatedIssues: [
            {
              id,
              title: step.title,
              status: "in_progress",
              issue_type: "task",
              priority: 2,
            },
          ],
        }),
        stderr: "",
        exitCode: 0,
      };
    }

    if (command === "close") {
      const id = args[1]!;
      closed.add(id);
      const step = INCIDENT_TRIAGE_STEPS.find((candidate) => candidate.id === id)!;
      return {
        stdout: JSON.stringify({
          closedIssues: [
            {
              id,
              title: step.title,
              status: "closed",
              issue_type: "task",
              priority: 2,
            },
          ],
        }),
        stderr: "",
        exitCode: 0,
      };
    }

    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
}

describe("beads incident-triage fixture", () => {
  it("defines exactly three ordered steps", () => {
    expect(INCIDENT_TRIAGE_STEPS.map((step) => step.id)).toEqual([
      "reproduce-incident",
      "find-root-cause",
      "add-regression-test",
    ]);
  });

  it("runs ready -> claim -> close in dependency order and ends empty", async () => {
    const calls: string[][] = [];
    const queue = new BeadsCliWorkQueue({
      cwd: "/repo",
      runCommand: deterministicBeadsRunner(calls),
    });

    for (const step of INCIDENT_TRIAGE_STEPS) {
      await queue.create(toCreateInput(step));
    }

    const closedOrder: string[] = [];
    for (const step of INCIDENT_TRIAGE_STEPS) {
      const ready = await queue.ready();
      expect(ready.map((item) => item.id)).toEqual([step.id]);
      await queue.claim(step.id);
      await queue.close(step.id, { reason: step.closeReason });
      closedOrder.push(step.id);
    }

    expect(closedOrder).toEqual([
      "reproduce-incident",
      "find-root-cause",
      "add-regression-test",
    ]);
    expect(await queue.ready()).toEqual([]);
    expect(calls).toEqual([
      [
        "create",
        "Reproduce the incident locally",
        "-t",
        "task",
        "-p",
        "2",
        "--description",
        "Demo scenario item: reproduce-incident",
        "--label",
        "demo",
        "--label",
        "incident-triage",
        "--json",
      ],
      [
        "create",
        "Isolate the root cause",
        "-t",
        "task",
        "-p",
        "2",
        "--description",
        "Demo scenario item: find-root-cause",
        "--label",
        "demo",
        "--label",
        "incident-triage",
        "--deps",
        "waits-for:reproduce-incident",
        "--json",
      ],
      [
        "create",
        "Add regression test coverage",
        "-t",
        "task",
        "-p",
        "2",
        "--description",
        "Demo scenario item: add-regression-test",
        "--label",
        "demo",
        "--label",
        "incident-triage",
        "--deps",
        "waits-for:find-root-cause",
        "--json",
      ],
      ["ready", "--json"],
      ["update", "reproduce-incident", "--claim", "--json"],
      [
        "close",
        "reproduce-incident",
        "--reason",
        "Incident reproduced with deterministic steps.",
        "--json",
      ],
      ["ready", "--json"],
      ["update", "find-root-cause", "--claim", "--json"],
      [
        "close",
        "find-root-cause",
        "--reason",
        "Root cause isolated to the failing dependency path.",
        "--json",
      ],
      ["ready", "--json"],
      ["update", "add-regression-test", "--claim", "--json"],
      [
        "close",
        "add-regression-test",
        "--reason",
        "Regression test added and failing path is now covered.",
        "--json",
      ],
      ["ready", "--json"],
    ]);
  });
});
