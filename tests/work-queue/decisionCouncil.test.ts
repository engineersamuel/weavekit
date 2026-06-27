import { describe, expect, it, vi } from "vitest";
import {
  completeDecisionCouncilWorkItem,
  startDecisionCouncilWorkItem,
  type DecisionCouncilWorkQueueOptions,
} from "../../src/work-queue/decisionCouncil.js";
import type { WorkQueueBackend } from "../../src/work-queue/backend.js";
import type { DecisionCouncilReport } from "../../src/decision-council/types.js";
import type { CreateWorkItemInput, ReadyWorkFilter, WorkItem } from "../../src/work-queue/schema.js";
import * as telemetry from "../../src/work-queue/telemetry.js";

const baseItem: WorkItem = {
  id: "bd-root",
  title: "Evaluate Beads",
  status: "open",
  type: "task",
  priority: 1,
  labels: [],
  dependencies: [],
};

const report: DecisionCouncilReport = {
  recommendation: "Use an optional adapter.",
  rationale: ["It keeps Beads behind a small seam."],
  strongestObjections: ["It does not provide runtime replay."],
  unresolvedQuestions: ["Should follow-up work be created automatically?"],
  confidence: 0.82,
  convergence: 0.77,
  nextExperiment: "Run one real workflow from a Beads ready item.",
  finalReportMarkdown: "# Decision Council Report\n\nUse an optional adapter.",
  failedPersonas: [],
};

function fakeBackend(events: string[]): WorkQueueBackend {
  return {
    async ready(_filter?: ReadyWorkFilter) {
      return [baseItem];
    },
    async show() {
      return baseItem;
    },
    async claim(id: string) {
      events.push(`claim:${id}`);
      return { ...baseItem, status: "in_progress" };
    },
    async create(input: CreateWorkItemInput) {
      events.push(`create:${input.title}:${input.dependencies[0]?.type}:${input.dependencies[0]?.id}`);
      return { ...baseItem, id: "bd-follow-up", title: input.title };
    },
    async close(id: string, input) {
      events.push(`close:${id}:${input.reason}`);
      return { ...baseItem, status: "closed" };
    },
    async sync() {
      events.push("sync");
    },
  };
}

describe("decision council work item lifecycle", () => {
  it("claims only when requested", async () => {
    const events: string[] = [];
    const options: DecisionCouncilWorkQueueOptions = {
      backend: fakeBackend(events),
      workItemId: "bd-root",
      claimOnStart: true,
    };

    await startDecisionCouncilWorkItem(options);

    expect(events).toEqual(["claim:bd-root"]);
  });

  it("closes and creates a discovered follow-up when requested", async () => {
    const events: string[] = [];
    const options: DecisionCouncilWorkQueueOptions = {
      backend: fakeBackend(events),
      workItemId: "bd-root",
      closeOnSuccess: true,
      createFollowUp: true,
      syncOnComplete: true,
    };

    await completeDecisionCouncilWorkItem({
      options,
      report,
      outputDir: "runs/beads",
    });

    expect(events).toEqual([
      "create:Decision Council next experiment: Run one real workflow from a Beads ready item.:discovered-from:bd-root",
      "close:bd-root:Decision Council completed. Recommendation: Use an optional adapter. Report: runs/beads/DecisionCouncilReport.md",
      "sync",
    ]);
  });

  it("wraps requested lifecycle calls in Beads telemetry spans", async () => {
    const spanOperations: string[] = [];
    
    // Spy on runWorkQueueSpan to capture operations
    const spy = vi.spyOn(telemetry, "runWorkQueueSpan");
    spy.mockImplementation(async (operation, context, fn) => {
      spanOperations.push(operation);
      return fn();
    });

    const options: DecisionCouncilWorkQueueOptions = {
      backend: fakeBackend([]),
      workItemId: "bd-root",
      claimOnStart: true,
      closeOnSuccess: true,
      createFollowUp: true,
      syncOnComplete: true,
    };

    await startDecisionCouncilWorkItem(options);
    await completeDecisionCouncilWorkItem({ options, report, outputDir: "runs/beads" });

    expect(spanOperations).toEqual([
      "claim",
      "create-follow-up",
      "close",
      "sync",
    ]);

    spy.mockRestore();
  });
});
