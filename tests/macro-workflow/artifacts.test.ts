import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeMacroWorkflowArtifacts } from "../../src/macro-workflow/artifacts.js";

describe("macro workflow artifacts", () => {
  it("writes report and state artifacts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "macro-artifacts-"));
    try {
      const artifacts = await writeMacroWorkflowArtifacts({
        outputDir,
        state: {
          planId: "test-plan",
          objective: "Implement logging",
          templateId: "implementation-review",
          status: "passed",
          startedAt: new Date("2026-06-29T00:00:00Z"),
          completedAt: new Date("2026-06-29T00:01:00Z"),
          currentPlan: {
            id: "test-plan",
            objective: "Implement logging",
            templateId: "implementation-review",
            maxReplans: 1,
            nodes: [],
          },
          nodeResults: [],
          replans: [],
        },
        replayEvents: [
          {
            seq: 1,
            ts: "2026-06-29T00:00:00.000Z",
            kind: "planning-started",
            phase: "planning",
            nodeId: "workflow-planning",
          },
        ],
      });

      const report = await readFile(artifacts.reportPath, "utf8");
      const stateFile = await readFile(artifacts.statePath, "utf8");
      const eventLog = await readFile(artifacts.eventLogPath, "utf8");

      expect(report).toContain("Macro Workflow Run Report");
      expect(stateFile).toContain("\"status\": \"passed\"");
      expect(eventLog).toContain("\"kind\":\"planning-started\"");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
