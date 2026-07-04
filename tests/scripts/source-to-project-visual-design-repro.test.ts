import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadVisualDesignReplayFixture,
  payloadMapForVisualDesignReplay,
  runVisualDesignReplay,
} from "../../scripts/source-to-project-visual-design-repro.js";

describe("source-to-project visual design replay", () => {
  it("loads the captured O3 visual-design fixture", async () => {
    const fixture = await loadVisualDesignReplayFixture();

    expect(fixture.sourceRunId).toBe("2cb8bdc8-c6e5-4795-b34c-9b98d8c2ed87");
    expect(fixture.sourcePayloadFile).toBe("report-opportunity-o3.payload.json");
    expect(fixture.visualDesignNode.id).toBe("visual-design-opportunity-o3");
    expect(fixture.visualDesignNode.input?.opportunity).toMatchObject({
      id: "O3",
      title: "Automated run-readiness/audit scorer to gate Autonomous PR promotions",
    });
    expect(fixture.payloads["report-opportunity-o3"]?.sourceToProjectReportMarkdown).toContain(
      "Automated run-readiness/audit scorer",
    );
  });

  it("injects fixture preflight by default so replay starts at visual design", async () => {
    const fixture = await loadVisualDesignReplayFixture();

    expect(payloadMapForVisualDesignReplay(fixture).has("visual-plan-preflight")).toBe(true);
    expect(payloadMapForVisualDesignReplay(fixture, { checkInstall: true }).has("visual-plan-preflight")).toBe(false);
  });

  it("runs the visual-design node against the captured O3 fixture in hosted mock mode", async () => {
    const result = await runVisualDesignReplay({ mode: "mock-hosted" });

    expect(result.status).toBe("passed");
    expect(result.payload?.sourceToProjectVisualPlan).toMatchObject({
      opportunityId: "O3",
      hostedArtifactUrl: "https://plan.agent-native.com/builder/replay-o3-readiness",
    });
    expect(result.execution?.calls?.map((call) => call.executor)).toEqual(["shell", "copilot-sdk"]);
  });

  it("accepts the local Agent-Native plan URL shape produced by /visual-plan local-files mode", async () => {
    const result = await runVisualDesignReplay({ mode: "mock-local-plan", bridgeTtlMs: 12345 });

    expect(result.status).toBe("passed");
    expect(result.payload?.sourceToProjectVisualPlan).toMatchObject({
      opportunityId: "O3",
      hostedArtifactUrl: expect.stringContaining("https://plan.agent-native.com/local-plans/replay-o3-readiness"),
      bridgeCleanup: {
        status: "scheduled",
        bridgeUrl: "http://127.0.0.1:57044/local-plan.json?token=fixture",
        port: 57044,
        cleanupAfterMs: 12345,
        cleanupCommand: "mock cleanup port 57044",
      },
    });
  });

  it("emits elapsed trace boundaries for repro diagnosis", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "visual-design-repro-trace-"));
    const traces: string[] = [];
    try {
      const result = await runVisualDesignReplay({
        mode: "mock-local-plan",
        cwd,
        trace: true,
        onTrace(message) {
          traces.push(message);
        },
      });

      expect(result.status).toBe("passed");
      expect(traces.every((line) => line.startsWith("[repro +"))).toBe(true);
      expect(traces).toEqual(expect.arrayContaining([
        expect.stringContaining("start mode=mock-local-plan"),
        expect.stringContaining("fixture loaded"),
        expect.stringContaining("registry create"),
        expect.stringContaining("adapter start node=visual-design-opportunity-o3"),
        expect.stringContaining("adapter complete status=passed"),
        expect.stringContaining("result url=https://plan.agent-native.com/local-plans/replay-o3-readiness"),
        expect.stringContaining("finished"),
      ]));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails the captured O3 replay when the visual step produces local HTML", async () => {
    await expect(runVisualDesignReplay({ mode: "mock-local-html" })).rejects.toThrow("local HTML fallback");
  });
});
