import type { CreateWorkItemInput, WorkDependency } from "../../../src/work-queue/schema.js";

export type IncidentTriageStep = {
  id: string;
  title: string;
  closeReason: string;
  dependencies: readonly WorkDependency[];
};

export const INCIDENT_TRIAGE_STEPS: readonly [
  IncidentTriageStep,
  IncidentTriageStep,
  IncidentTriageStep,
] = [
  {
    id: "reproduce-incident",
    title: "Reproduce the incident locally",
    closeReason: "Incident reproduced with deterministic steps.",
    dependencies: [],
  },
  {
    id: "find-root-cause",
    title: "Isolate the root cause",
    closeReason: "Root cause isolated to the failing dependency path.",
    dependencies: [{ type: "waits-for", id: "reproduce-incident" }],
  },
  {
    id: "add-regression-test",
    title: "Add regression test coverage",
    closeReason: "Regression test added and failing path is now covered.",
    dependencies: [{ type: "waits-for", id: "find-root-cause" }],
  },
];

export function toCreateInput(step: IncidentTriageStep): CreateWorkItemInput {
  return {
    title: step.title,
    type: "task",
    priority: 2,
    labels: ["demo", "incident-triage"],
    dependencies: [...step.dependencies],
    description: `Demo scenario item: ${step.id}`,
  };
}
