import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWeavekitOpportunityDiagnostics } from "../../../src/eval/sourceToProjectVerification/weavekitDiagnostics.js";

describe("weavekit opportunity diagnostics", () => {
  it("reports the discovered, accepted, bundled, and retained opportunity funnel", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "weavekit-opportunity-diagnostics-"));
    await writePayload(runDir, "opportunity-mapping", {
      councilInputReview: {
        opportunities: [{ id: "o1" }, { id: "o2" }, { id: "o3" }],
        bundles: [{ id: "bundle-1", opportunityIds: ["o1", "o2"] }],
      },
    });
    await writePayload(runDir, "council-review", {
      opportunityAcceptances: [
        { id: "o1", accepted: true },
        { id: "o2", accepted: true },
        { id: "o3", accepted: false },
      ],
    });
    await writePayload(runDir, "plan-portfolio", {
      plan: { opportunityIds: ["o1", "o2", "o3"] },
      sourcePlans: [{ opportunityIds: ["o1", "o2"] }, { opportunityIds: ["o3"] }],
    });

    const diagnostics = await loadWeavekitOpportunityDiagnostics(runDir);

    expect(diagnostics).toMatchObject({
      discoveredOpportunityCount: 3,
      acceptedOpportunityCount: 2,
      rejectedOpportunityCount: 1,
      bundleCount: 1,
      bundles: [{ id: "bundle-1", opportunityIds: ["o1", "o2"] }],
      plannedOpportunityIds: ["o1", "o2", "o3"],
      acceptedOpportunityRetention: 1,
      rejectedOpportunityIdsRestored: ["o3"],
      expectedPracticeRecallBeforePlanning: null,
      acceptedPracticeRetention: null,
      rejectedGroundedPracticesRestored: null,
    });
    expect(diagnostics.overlapOrContradictionFindings).toContain(
      "Portfolio restored rejected opportunity o3.",
    );
    expect(diagnostics.unavailableMetrics.join(" ")).toMatch(/requirement ids/i);
  });
});

async function writePayload(runDir: string, name: string, value: unknown): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, `${name}.payload.json`), JSON.stringify(value), "utf8");
}
