import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePrLaunchSmokeRun } from "../../scripts/source-to-project-pr-launch-dashboard-smoke.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("source-to-project PR launch dashboard smoke fixture", () => {
  it("writes a minimal passed report run that can launch the PR action", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-launch-dashboard-smoke-"));
    tempDirs.push(root);

    const run = await writePrLaunchSmokeRun({
      outputRoot: root,
      project: {
        id: "weavekit",
        displayName: "Weavekit",
        workingTree: "/repo/weavekit",
        mainline: "origin main",
        remote: "origin",
        contextDocs: ["CONTEXT.md"],
        validationCommands: ["nub run typecheck"],
        autonomousPrAllowed: true,
        notification: "cli",
        knowledgeExport: "off",
      },
      prompt: "Smoke prompt passed to the Herdr Codex agent.",
    });

    const state = JSON.parse(await readFile(join(run.outputDir, "workflow-state.json"), "utf8"));
    const events = await readFile(join(run.outputDir, "workflow-events.jsonl"), "utf8");

    expect(state.templateId).toBe("source-to-project");
    expect(state.currentPlan.nodes.map((node: { kind: string }) => node.kind)).toEqual([
      "planning",
      "deliberation",
      "report",
      "visualization",
    ]);
    expect(state.nodeResults.find((result: { nodeId: string }) => result.nodeId === "visual-design-opportunity-smoke")).toMatchObject({
      status: "passed",
      payload: {
        sourceToProjectVisualPlan: {
          sourceReportNodeId: "report-opportunity-smoke",
        },
      },
    });
    expect(state.nodeResults.find((result: { nodeId: string }) => result.nodeId === "report-opportunity-smoke")?.payload.sourceToProjectReportMarkdown).toContain(
      "Smoke prompt passed to the Herdr Codex agent.",
    );
    expect(events).toContain("\"kind\":\"node-added\"");
    expect(events).toContain("\"nodeId\":\"visual-design-opportunity-smoke\"");
  });
});
