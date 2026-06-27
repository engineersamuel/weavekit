import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { INCIDENT_TRIAGE_STEPS } from "./fixtures/beadsIncidentTriageScenario.js";

describe("beads docs incident triage demo", () => {
  it("documents incident triage demo with the same step IDs in order", () => {
    const docs = readFileSync(resolve(process.cwd(), "docs/beads.md"), "utf8");
    expect(docs).toContain("## Incident-triage demo");

    const positions = INCIDENT_TRIAGE_STEPS.map((step) => docs.indexOf(step.id));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
