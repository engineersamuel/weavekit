import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkflowDashboardServer,
  listWorkflowDashboardRuns,
  readWorkflowDashboardSnapshot,
  readWorkflowReplayEvents,
  type WorkflowDashboardServer,
} from "../../src/macro-workflow/dashboardServer.js";
import type { MacroWorkflowRunStateLike } from "../../src/macro-workflow/types.js";

const fixtureEventsPath = "tests/fixtures/workflow-events.jsonl";

describe("readWorkflowReplayEvents", () => {
  it("reads replay events from a JSONL file", async () => {
    const events = await readWorkflowReplayEvents(fixtureEventsPath);

    expect(events[0]?.kind).toBe("planning-started");
    expect(events[1]?.node?.id).toBe("research-1");
  });
});

describe("workflow dashboard replay bootstrap", () => {
  const servers: WorkflowDashboardServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  it("merges workflow-state.json with adjacent workflow-events.jsonl", async () => {
    const outputDir = await writeWorkflowRunFixture();
    try {
      const snapshot = await readWorkflowDashboardSnapshot(join(outputDir, "workflow-state.json"));

      expect(snapshot.state?.planId).toBe("plan-1");
      expect(snapshot.run?.runName).toBe("Replay Dashboard Run");
      expect(snapshot.history?.map((event) => event.kind)).toEqual(["planning-started", "node-added"]);
      expect(snapshot.event?.planId).toBe("plan-1");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("serves /api/replay with latest state and replay history from watchDir", async () => {
    const outputDir = await writeWorkflowRunFixture();
    const watchDir = join(outputDir, "..");
    try {
      const server = await createWorkflowDashboardServer(undefined, { watchDir });
      servers.push(server);

      const response = await fetch(new URL("/api/replay", server.url));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.state.planId).toBe("plan-1");
      expect(payload.runs).toHaveLength(1);
      expect(payload.activeRunId).toBe("run-1");
      expect(payload.history).toHaveLength(2);
      expect(payload.event.planId).toBe("plan-1");
    } finally {
      await rm(watchDir, { recursive: true, force: true });
    }
  });

  it("includes history in /api/state payloads after replay bootstrap", async () => {
    const outputDir = await writeWorkflowRunFixture();
    const watchDir = join(outputDir, "..");
    try {
      const server = await createWorkflowDashboardServer(undefined, { watchDir });
      servers.push(server);

      await fetch(new URL("/api/replay", server.url));
      const response = await fetch(new URL("/api/state", server.url));
      const payload = await response.json();

      expect(payload.state.planId).toBe("plan-1");
      expect(payload.history?.[0]?.kind).toBe("planning-started");
    } finally {
      await rm(watchDir, { recursive: true, force: true });
    }
  });

  it("lists dashboard runs from a watch directory", async () => {
    const outputDir = await writeWorkflowRunFixture();
    const watchDir = join(outputDir, "..");
    try {
      const runs = await listWorkflowDashboardRuns(watchDir);

      expect(runs.map((run) => run.runId)).toEqual(["run-1"]);
      expect(runs[0]?.runName).toBe("Replay Dashboard Run");
    } finally {
      await rm(watchDir, { recursive: true, force: true });
    }
  });

  it("serves /api/runs and can replay a selected run", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-dashboard-"));
    try {
      await writeWorkflowRunFixture(rootDir, "run-1", "First Run", "passed");
      await writeWorkflowRunFixture(rootDir, "run-2", "Second Run", "running");
      const server = await createWorkflowDashboardServer(undefined, { watchDir: rootDir });
      servers.push(server);

      const runsResponse = await fetch(new URL("/api/runs", server.url));
      const runsPayload = await runsResponse.json();
      const replayResponse = await fetch(new URL("/api/replay?runId=run-1", server.url));
      const replayPayload = await replayResponse.json();

      expect(runsPayload.runs.map((run: { runId: string }) => run.runId).sort()).toEqual(["run-1", "run-2"]);
      expect(replayPayload.activeRunId).toBe("run-1");
      expect(replayPayload.run.runName).toBe("First Run");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("includes history in SSE state payloads", async () => {
    const server = await createWorkflowDashboardServer(undefined);
    servers.push(server);

    await fetch(new URL("/api/state", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        state: createWorkflowState(),
        history: await readWorkflowReplayEvents(fixtureEventsPath),
        event: {
          type: "macro-workflow.run.started",
          planId: "plan-1",
          timestamp: "2026-06-30T00:00:00.000Z",
        },
      }),
    });

    const controller = new AbortController();
    const response = await fetch(new URL("/events", server.url), { signal: controller.signal });
    const body = response.body;
    expect(body).toBeTruthy();

    try {
      const text = await readUntil(body!, "event: state");
      expect(text).toContain("\"history\"");
      expect(text).toContain("\"kind\":\"planning-started\"");
    } finally {
      controller.abort();
    }
  });
});

async function writeWorkflowRunFixture(rootDir = "", runId = "run-1", runName = "Replay Dashboard Run", status: MacroWorkflowRunStateLike["status"] = "running") {
  const resolvedRootDir = rootDir || (await mkdtemp(join(tmpdir(), "workflow-dashboard-")));
  const outputDir = join(resolvedRootDir, runId);
  await mkdir(outputDir);
  await writeFile(join(outputDir, "workflow-state.json"), JSON.stringify(createWorkflowState(runId, runName, status), null, 2));
  await writeFile(join(outputDir, "workflow-events.jsonl"), await readFile(fixtureEventsPath, "utf8"));
  return outputDir;
}

function createWorkflowState(runId = "run-1", runName = "Replay Dashboard Run", status: MacroWorkflowRunStateLike["status"] = "running"): MacroWorkflowRunStateLike {
  return {
    runId,
    runName,
    planId: "plan-1",
    objective: "Ship replay dashboard",
    templateId: "implementation-review",
    status,
    startedAt: new Date("2026-06-30T00:00:00.000Z"),
    currentPlan: {
      id: "plan-1",
      objective: "Ship replay dashboard",
      templateId: "implementation-review",
      maxReplans: 0,
      nodes: [
        {
          id: "research-1",
          kind: "research",
          harness: "research",
          title: "Research",
          prompt: "Research the request",
          dependsOn: [],
          gates: [],
          writeMode: "read-only",
          replanPolicy: "never",
        },
      ],
    },
    nodeResults: [],
    replans: [],
  };
}

async function readUntil(body: ReadableStream<Uint8Array>, needle: string): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    text += decoder.decode(result.value, { stream: true });
    if (text.includes(needle)) {
      return text;
    }
  }
  return text;
}
