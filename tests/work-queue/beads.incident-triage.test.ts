import { describe, expect, it } from "vitest";
import { INCIDENT_TRIAGE_STEPS } from "./fixtures/beadsIncidentTriageScenario.js";

describe("beads incident-triage fixture", () => {
  it("defines exactly three ordered steps", () => {
    expect(INCIDENT_TRIAGE_STEPS.map((step) => step.id)).toEqual([
      "reproduce-incident",
      "find-root-cause",
      "add-regression-test",
    ]);
  });
});
