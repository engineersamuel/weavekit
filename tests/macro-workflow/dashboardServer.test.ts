import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowDashboardServer,
  createWorkflowDashboardSnapshotVersion,
  listWorkflowDashboardRuns,
  readWorkflowDashboardSnapshot,
  readWorkflowReplayEvents,
  type WorkflowDashboardServer,
} from "../../src/macro-workflow/dashboardServer.js";
import type { MacroWorkflowRunStateLike } from "../../src/macro-workflow/types.js";

const fixtureEventsPath = "tests/fixtures/workflow-events.jsonl";
const execFileAsync = promisify(execFile);

describe("readWorkflowReplayEvents", () => {
  it("reads replay events from a JSONL file", async () => {
    const events = await readWorkflowReplayEvents(fixtureEventsPath);

    expect(events[0]?.kind).toBe("planning-started");
    expect(events[1]?.node?.id).toBe("research-1");
  });
});

describe("workflow dashboard replay bootstrap", () => {
  const servers: WorkflowDashboardServer[] = [];
  const originalPort = process.env.PORT;
  const originalPortlessUrl = process.env.PORTLESS_URL;

  beforeEach(() => {
    delete process.env.PORT;
    delete process.env.PORTLESS_URL;
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    restoreEnv("PORT", originalPort);
    restoreEnv("PORTLESS_URL", originalPortlessUrl);
    vi.restoreAllMocks();
  });

  it("uses an ephemeral localhost URL by default", async () => {
    delete process.env.PORT;
    delete process.env.PORTLESS_URL;

    const server = await createWorkflowDashboardServer(undefined);
    servers.push(server);

    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.url).not.toBe("http://127.0.0.1:0");
  });

  it("listens on PORT when no explicit port option is passed", async () => {
    const port = await getAvailablePort();
    process.env.PORT = String(port);

    const server = await createWorkflowDashboardServer(undefined);
    servers.push(server);

    expect(server.url).toBe(`http://127.0.0.1:${port}`);
  });

  it("lets an explicit port option override PORT", async () => {
    const explicitPort = await getAvailablePort();
    process.env.PORT = "not-a-port";

    const server = await createWorkflowDashboardServer(undefined, { port: explicitPort });
    servers.push(server);

    expect(server.url).toBe(`http://127.0.0.1:${explicitPort}`);
  });

  it("reports PORTLESS_URL when Portless provides one", async () => {
    process.env.PORTLESS_URL = "https://calm-meadow.weavekit-dashboard.localhost";

    const server = await createWorkflowDashboardServer(undefined);
    servers.push(server);

    expect(server.url).toBe("https://calm-meadow.weavekit-dashboard.localhost");
  });

  it("fails clearly when PORT is invalid", async () => {
    process.env.PORT = "not-a-port";

    await expect(createWorkflowDashboardServer(undefined)).rejects.toThrow("Invalid PORT value. Expected an integer between 1 and 65535.");
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
      expect(payload.state.currentPlan.nodes[0]).toMatchObject({
        model: "gpt-5.4",
      });
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

  it("keeps the same snapshot version for repeated watch reads of an unchanged run", async () => {
    const outputDir = await writeWorkflowRunFixture();
    try {
      const snapshot = await readWorkflowDashboardSnapshot(join(outputDir, "workflow-state.json"));
      const repeatedSnapshot = await readWorkflowDashboardSnapshot(join(outputDir, "workflow-state.json"));

      expect(createWorkflowDashboardSnapshotVersion(repeatedSnapshot)).toBe(createWorkflowDashboardSnapshotVersion(snapshot));
      expect(createWorkflowDashboardSnapshotVersion({
        ...snapshot,
        run: snapshot.run ? { ...snapshot.run, updatedAt: "2026-06-30T00:00:01.000Z" } : undefined,
      })).not.toBe(createWorkflowDashboardSnapshotVersion(snapshot));
    } finally {
      await rm(join(outputDir, ".."), { recursive: true, force: true });
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

  it("serves selected run artifacts without allowing path traversal", async () => {
    const outputDir = await writeWorkflowRunFixture();
    const watchDir = join(outputDir, "..");
    try {
      const server = await createWorkflowDashboardServer(undefined, { watchDir });
      servers.push(server);

      const reportResponse = await fetch(new URL("/api/artifact?runId=run-1&file=workflow-report.md", server.url));
      const reportText = await reportResponse.text();
      const traversalResponse = await fetch(new URL("/api/artifact?runId=run-1&file=../workflow-state.json", server.url));

      expect(reportResponse.status).toBe(200);
      expect(reportResponse.headers.get("content-type")).toContain("text/markdown");
      expect(reportText).toContain("# Macro Workflow Run Report");
      expect(traversalResponse.status).toBe(404);
    } finally {
      await rm(watchDir, { recursive: true, force: true });
    }
  });

  it("serves typed payload artifacts from workflow state when payload files are not written yet", async () => {
    const outputDir = await writeWorkflowRunFixture();
    const watchDir = join(outputDir, "..");
    try {
      const server = await createWorkflowDashboardServer(undefined, { watchDir });
      servers.push(server);

      const response = await fetch(new URL("/api/artifact?runId=run-1&file=source-corroboration.payload.json", server.url));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(payload).toEqual({ corroboration: { sourceId: "source-1" } });
    } finally {
      await rm(watchDir, { recursive: true, force: true });
    }
  });

  it("rejects manual source-to-project PR launch requests for visualization nodes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-dashboard-"));
    const configPath = join(rootDir, "config.toml");
    const launched: unknown[] = [];
    try {
      await writeFile(configPath, `
[source_to_project.pr_launcher]
agent_command = "codex"

[projects.weavekit]
display_name = "Weavekit"
working_tree = "/repo/weavekit"
mainline = "origin main"
remote = "origin"
validation_commands = ["nub run typecheck"]
autonomous_pr_allowed = true
`, "utf8");
      await writeWorkflowRunFixture(rootDir, "run-1", "Source Run", "passed", createSourceToProjectWorkflowState());
      const server = await createWorkflowDashboardServer(undefined, {
        watchDir: rootDir,
        configPath,
        prLauncher: {
          async launch(args) {
            launched.push(args);
            return {
              provider: "herdr",
              worktreePath: "/repo/worktree",
              branchName: "source-to-project/opp-1-run-1",
              agentName: "source-to-project-opp-1-run-1",
              startedCommand: "herdr agent start source-to-project-opp-1-run-1 -- codex",
            };
          },
        },
      });
      servers.push(server);

      const response = await fetch(new URL("/api/source-to-project/pr-launch", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ runId: "run-1", nodeId: "visual-design-opportunity-opp-1" }),
      });
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.error).toContain("passed report node");
      expect(launched).toHaveLength(0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("launches a manual source-to-project PR agent for a passed report node", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-dashboard-"));
    const configPath = join(rootDir, "config.toml");
    const launched: unknown[] = [];
    try {
      await writeFile(configPath, `
[source_to_project.pr_launcher]
agent_command = "codex"

[projects.weavekit]
display_name = "Weavekit"
working_tree = "/repo/weavekit"
mainline = "origin main"
remote = "origin"
validation_commands = ["nub run typecheck"]
autonomous_pr_allowed = true
`, "utf8");
      await writeWorkflowRunFixture(rootDir, "run-1", "Source Run", "passed", createSourceToProjectWorkflowState());
      const server = await createWorkflowDashboardServer(undefined, {
        watchDir: rootDir,
        configPath,
        prLauncher: {
          async launch(args) {
            launched.push(args);
            return {
              provider: "herdr",
              worktreePath: "/repo/worktree",
              branchName: "source-to-project/opp-1-run-1",
              agentName: "source-to-project-opp-1-run-1",
              startedCommand: "herdr pane run w1:p1 codex",
            };
          },
        },
      });
      servers.push(server);

      const response = await fetch(new URL("/api/source-to-project/pr-launch", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ runId: "run-1", nodeId: "report-opportunity-opp-1" }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(launched).toHaveLength(1);
      expect(launched[0]).toMatchObject({
        context: {
          nodeId: "report-opportunity-opp-1",
          opportunityId: "opp-1",
          opportunityTitle: "Add manual PR launch",
          reportMarkdown: "# Source-to-Project Report: opp-1\n\nImplement this reviewed opportunity.",
          recommendation: "Add a manual dashboard PR action.",
          initialPromptMode: "implement",
          projectBrief: {
            architecture: "Keep workflow runs in-process with single-writer handoffs.",
            constraints: ["No durable work queues."],
            goals: ["Expose manual PR handoffs for reviewed opportunities."],
            changeSurfaces: ["src/macro-workflow/dashboardServer.ts"],
            validationCommands: ["nub run typecheck"],
            risks: ["Prompt context can drift from project research."],
            evidence: [
              {
                id: "p1",
                source: "CONTEXT.md",
                quote: "Runs are isolated.",
              },
            ],
          },
        },
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("matches a Herdr worktree run to the configured project by git remote", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-dashboard-"));
    const configPath = join(rootDir, "config.toml");
    const configuredWeavekit = join(rootDir, "configured-weavekit");
    const herdrWeavekit = join(rootDir, "herdr-weavekit-worktree");
    const secondbrain = join(rootDir, "secondbrain");
    const launched: unknown[] = [];
    try {
      await initGitRepo(configuredWeavekit, "git@example.com:org/weavekit.git");
      await initGitRepo(herdrWeavekit, "git@example.com:org/weavekit.git");
      await initGitRepo(secondbrain, "git@example.com:org/secondbrain.git");
      await writeFile(configPath, `
[source_to_project.pr_launcher]
agent_command = "codex"

[projects.weavekit]
display_name = "Weavekit"
working_tree = "${configuredWeavekit}"
mainline = "origin main"
remote = "origin"
validation_commands = ["nub run typecheck"]
autonomous_pr_allowed = true

[projects.secondbrain]
display_name = "Second Brain"
working_tree = "${secondbrain}"
mainline = "origin main"
remote = "origin"
validation_commands = ["nub run typecheck"]
autonomous_pr_allowed = true
`, "utf8");
      await writeWorkflowRunFixture(rootDir, "run-1", "Source Run", "passed", createSourceToProjectWorkflowState({
        projectExecutionCwd: herdrWeavekit,
      }));
      const server = await createWorkflowDashboardServer(undefined, {
        watchDir: rootDir,
        configPath,
        prLauncher: {
          async launch(args) {
            launched.push(args);
            return {
              provider: "herdr",
              worktreePath: "/repo/worktree",
              branchName: "source-to-project/opp-1-run-1",
              agentName: "source-to-project-opp-1-run-1",
              startedCommand: "herdr pane run w1:p1 codex",
            };
          },
        },
      });
      servers.push(server);

      const response = await fetch(new URL("/api/source-to-project/pr-launch", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ runId: "run-1", nodeId: "report-opportunity-opp-1" }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(launched[0]).toMatchObject({
        context: {
          project: {
            id: "weavekit",
            workingTree: configuredWeavekit,
          },
        },
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("logs manual PR launch failures to stderr", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-dashboard-"));
    const configPath = join(rootDir, "config.toml");
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await writeFile(configPath, `
[source_to_project.pr_launcher]
agent_command = "codex"

[projects.weavekit]
display_name = "Weavekit"
working_tree = "/repo/weavekit"
mainline = "origin main"
remote = "origin"
validation_commands = ["nub run typecheck"]
autonomous_pr_allowed = true
`, "utf8");
      await writeWorkflowRunFixture(rootDir, "run-1", "Source Run", "passed", createSourceToProjectWorkflowState());
      const server = await createWorkflowDashboardServer(undefined, {
        watchDir: rootDir,
        configPath,
        prLauncher: {
          async launch() {
            throw new Error("Herdr launch failed in test.");
          },
        },
      });
      servers.push(server);

      const response = await fetch(new URL("/api/source-to-project/pr-launch", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ runId: "run-1", nodeId: "report-opportunity-opp-1" }),
      });
      const payload = await response.json();

      expect(response.status).toBe(500);
      expect(payload.error).toBe("Herdr launch failed in test.");
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("[weavekit][error] Manual PR launch failed (500): Herdr launch failed in test."));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects manual PR launch requests for incomplete visualization nodes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-dashboard-"));
    const configPath = join(rootDir, "config.toml");
    try {
      await writeFile(configPath, `
[projects.weavekit]
working_tree = "/repo/weavekit"
autonomous_pr_allowed = true
`, "utf8");
      const state = createSourceToProjectWorkflowState();
      state.nodeResults = state.nodeResults.map((result) =>
        result.nodeId === "visual-design-opportunity-opp-1"
          ? { ...result, status: "running" as const }
          : result
      );
      await writeWorkflowRunFixture(rootDir, "run-1", "Source Run", "running", state);
      const server = await createWorkflowDashboardServer(undefined, { watchDir: rootDir, configPath });
      servers.push(server);

      const response = await fetch(new URL("/api/source-to-project/pr-launch", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ runId: "run-1", nodeId: "visual-design-opportunity-opp-1" }),
      });
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.error).toContain("passed report node");
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

async function writeWorkflowRunFixture(
  rootDir = "",
  runId = "run-1",
  runName = "Replay Dashboard Run",
  status: MacroWorkflowRunStateLike["status"] = "running",
  state = createWorkflowState(runId, runName, status),
) {
  const resolvedRootDir = rootDir || (await mkdtemp(join(tmpdir(), "workflow-dashboard-")));
  const outputDir = join(resolvedRootDir, runId);
  await mkdir(outputDir);
  await writeFile(join(outputDir, "workflow-state.json"), JSON.stringify(state, null, 2));
  await writeFile(join(outputDir, "workflow-events.jsonl"), await readFile(fixtureEventsPath, "utf8"));
  await writeFile(join(outputDir, "workflow-report.md"), "# Macro Workflow Run Report\n\nFixture report.\n", "utf8");
  return outputDir;
}

function createSourceToProjectWorkflowState(options: { projectExecutionCwd?: string } = {}): MacroWorkflowRunStateLike {
  const projectExecutionCwd = options.projectExecutionCwd ?? "/repo/weavekit";
  return {
    runId: "run-1",
    runName: "Source Run",
    planId: "source-plan-1",
    objective: "Apply source lessons",
    templateId: "source-to-project",
    status: "passed",
    startedAt: new Date("2026-06-30T00:00:00.000Z"),
    currentPlan: {
      id: "source-plan-1",
      objective: "Apply source lessons",
      templateId: "source-to-project",
      maxReplans: 0,
      nodes: [
        {
          id: "report-opportunity-opp-1",
          kind: "report",
          harness: "reporter",
          title: "Report opp-1: Add manual PR launch",
          prompt: "Report",
          input: {
            opportunity: {
              id: "opp-1",
              title: "Add manual PR launch",
              lesson: "Expose manual handoffs for reviewed work.",
              projectChange: "Add a dashboard PR action.",
              changeSurface: "dashboard",
              score: { applicability: 0.9, impact: 0.9, confidence: 0.9, implementationCost: 0.4, risk: 0.2 },
              evidence: [{ id: "e1", source: "README.md" }],
              speculative: false,
            },
          },
          dependsOn: ["review-opportunity-opp-1"],
          gates: ["output-contract"],
          writeMode: "read-only",
          replanPolicy: "never",
        },
        {
          id: "visual-design-opportunity-opp-1",
          kind: "visualization",
          harness: "copilot-sdk",
          title: "Visual design opp-1: Add manual PR launch",
          prompt: "Visual",
          input: {
            opportunity: {
              id: "opp-1",
              title: "Add manual PR launch",
              lesson: "Expose manual handoffs for reviewed work.",
              projectChange: "Add a dashboard PR action.",
              changeSurface: "dashboard",
              score: { applicability: 0.9, impact: 0.9, confidence: 0.9, implementationCost: 0.4, risk: 0.2 },
              evidence: [{ id: "e1", source: "README.md" }],
              speculative: false,
            },
          },
          dependsOn: ["report-opportunity-opp-1"],
          gates: ["output-contract"],
          writeMode: "read-only",
          replanPolicy: "never",
        },
      ],
    },
    nodeResults: [
      {
        nodeId: "source-reading",
        status: "passed",
        output: "Source analysis complete.",
        payload: { sourceAnalysis: { sourceId: "https://example.com/source" } },
      },
      {
        nodeId: "project-research",
        status: "passed",
        output: "Project brief complete.",
        payload: {
          projectBrief: {
            projectId: "path-override",
            displayName: "Path override",
            architecture: "Keep workflow runs in-process with single-writer handoffs.",
            constraints: ["No durable work queues."],
            goals: ["Expose manual PR handoffs for reviewed opportunities."],
            changeSurfaces: ["src/macro-workflow/dashboardServer.ts"],
            validationCommands: ["nub run typecheck"],
            risks: ["Prompt context can drift from project research."],
            evidence: [
              {
                id: "p1",
                source: "CONTEXT.md",
                quote: "Runs are isolated.",
              },
            ],
          },
        },
        execution: {
          calls: [{ executor: "copilot-sdk", cwd: projectExecutionCwd }],
        },
      },
      {
        nodeId: "report-opportunity-opp-1",
        status: "passed",
        output: "# Source-to-Project Report: opp-1\n\nImplement this reviewed opportunity.",
        payload: {
          sourceToProjectReportMarkdown: "# Source-to-Project Report: opp-1\n\nImplement this reviewed opportunity.",
          plan: {
            opportunityIds: ["opp-1"],
            title: "Manual PR launch plan",
            recommendation: "Add a manual dashboard PR action.",
            problemSolved: "Manual handoff is missing.",
            sourceLessonApplied: "Expose manual handoffs for reviewed work.",
            targetChange: "Add endpoint and node action.",
            expectedUserValue: "User can launch implementation when ready.",
            implementationOutline: ["Add endpoint", "Add node action"],
            scope: "Dashboard and source-to-project launcher.",
            filesLikelyTouched: ["src/macro-workflow/dashboardServer.ts"],
            validationCommands: ["nub run typecheck"],
            risks: [],
          },
        },
      },
      {
        nodeId: "visual-design-opportunity-opp-1",
        status: "passed",
        output: "Visual design complete.",
        payload: {
          sourceToProjectVisualPlan: {
            opportunityId: "opp-1",
            title: "Add manual PR launch",
            sourceReportNodeId: "report-opportunity-opp-1",
            hostedArtifactUrl: "https://plan.agent-native.com/local-plans/opp-1",
          },
        },
        execution: {
          calls: [{ executor: "copilot-sdk", cwd: projectExecutionCwd }],
        },
      },
    ],
    replans: [],
  };
}

async function initGitRepo(repoPath: string, remoteUrl: string) {
  await mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["remote", "add", "origin", remoteUrl], { cwd: repoPath });
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
          description: "Research the request before execution.",
          model: "gpt-5.4",
          modelRationale: "Fixture model metadata.",
          prompt: "Research the request",
          dependsOn: [],
          gates: [],
          writeMode: "read-only",
          replanPolicy: "never",
        },
      ],
    },
    nodeResults: [
      {
        nodeId: "source-corroboration",
        status: "passed",
        output: "Corroboration complete.",
        payload: { corroboration: { sourceId: "source-1" } },
      },
    ],
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

function restoreEnv(name: "PORT" | "PORTLESS_URL", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function getAvailablePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  if (!address || typeof address !== "object") {
    throw new Error("Failed to allocate an available port.");
  }
  return address.port;
}
