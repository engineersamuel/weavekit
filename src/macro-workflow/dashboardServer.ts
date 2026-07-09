import { execFile } from "node:child_process";
import { readdir, mkdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import {
  loadTypedWeavekitConfig,
  type ProjectCatalogEntry,
  type WeavekitConfig,
} from "../config.js";
import { MacroWorkflowEventKind, type MacroWorkflowEvent } from "./logger.js";
import type { MacroWorkflowRunStateLike, WorkflowReplayEvent } from "./types.js";
import type { ProjectBrief } from "../generated/baml_client/index.js";
import {
  launchSourceToProjectPrAgent,
  type SourceToProjectPrLaunchArgs,
  type SourceToProjectPrLaunchContext,
  type SourceToProjectPrLauncher,
} from "./sourceToProject/prLauncher.js";

const execFileAsync = promisify(execFile);

export type WorkflowDashboardRunSummary = {
  runId: string;
  runName: string;
  objective: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  outputDir: string;
  statePath: string;
  updatedAt: string;
};

export type WorkflowDashboardSnapshot = {
  state?: MacroWorkflowRunStateLike;
  history?: WorkflowReplayEvent[];
  event?: MacroWorkflowEvent;
  run?: WorkflowDashboardRunSummary;
  runs?: WorkflowDashboardRunSummary[];
  activeRunId?: string;
};

export type WorkflowDashboardServer = {
  url: string;
  publishState: (
    state: MacroWorkflowRunStateLike,
    event: MacroWorkflowEvent,
    history?: WorkflowReplayEvent[],
  ) => void;
  stop: () => Promise<void>;
};

export type WorkflowDashboardPublisher = {
  publishState: (
    state: MacroWorkflowRunStateLike,
    event: MacroWorkflowEvent,
    history?: WorkflowReplayEvent[],
  ) => Promise<void>;
};

export type WorkflowDashboardServerOptions = {
  port?: number;
  watchDir?: string;
  configPath?: string;
  prLauncher?: SourceToProjectPrLauncher;
};

const CONTENT_TYPES = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

export async function createWorkflowDashboardServer(
  initialState: MacroWorkflowRunStateLike | undefined,
  options: WorkflowDashboardServerOptions = {},
): Promise<WorkflowDashboardServer> {
  const dashboardDir = fileURLToPath(new URL("./dashboard/", import.meta.url));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const port = resolveDashboardListenPort(options.port);

  await ensureDashboardBundle(dashboardDir, repoRoot);
  const watchDir = options.watchDir ? resolve(options.watchDir) : undefined;
  const clients = new Set<{ response: ServerResponse }>();

  let latestState: MacroWorkflowRunStateLike | undefined = initialState;
  let latestEvent: MacroWorkflowEvent | undefined;
  let latestHistory: WorkflowReplayEvent[] | undefined;
  let latestRun: WorkflowDashboardRunSummary | undefined;
  let latestRuns: WorkflowDashboardRunSummary[] | undefined;
  let latestWatchSnapshotVersion: string | undefined;

  const server = createServer(async (request, response) => {
    if (!request.url) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Missing request URL.");
      return;
    }

    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (requestUrl.pathname === "/events") {
      const client = { response };
      handleSseConnection(response, latestState, latestEvent, latestHistory);
      clients.add(client);
      request.on("close", () => {
        clients.delete(client);
      });
      return;
    }

    if (requestUrl.pathname === "/api/state") {
      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          try {
            const payload = JSON.parse(body) as WorkflowDashboardSnapshot;
            if (!payload.state || !payload.event) {
              throw new Error("Missing dashboard state or event.");
            }
            publishStateInternal(payload.state, payload.event, payload.history);
            response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ ok: true }));
          } catch {
            response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ ok: false, error: "Invalid dashboard payload." }));
          }
        });
        return;
      }

      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify(
          toSerializablePayload(latestState, latestEvent, latestHistory, latestRun, latestRuns),
        ),
      );
      return;
    }

    if (requestUrl.pathname === "/api/replay") {
      if (watchDir) {
        const runId = requestUrl.searchParams.get("runId") ?? undefined;
        await refreshWorkflowSnapshot(watchDir, runId, (snapshot) => {
          latestState = snapshot.state;
          latestEvent = snapshot.event;
          latestHistory = snapshot.history;
          latestRun = snapshot.run;
          latestRuns = snapshot.runs;
        }).catch((error: unknown) => {
          logDashboardError(
            `Dashboard replay refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify(
          toSerializablePayload(latestState, latestEvent, latestHistory, latestRun, latestRuns),
        ),
      );
      return;
    }

    if (requestUrl.pathname === "/api/runs") {
      if (watchDir) {
        latestRuns = await listWorkflowDashboardRuns(watchDir).catch(() => latestRuns);
      }
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          runs: latestRuns ?? [],
          activeRunId: latestRun?.runId ?? latestState?.runId,
        }),
      );
      return;
    }

    if (requestUrl.pathname === "/api/source-to-project/agent-options") {
      try {
        const config = loadTypedWeavekitConfig(options.configPath);
        const agentOptions = config.sourceToProject.prLauncher.agentOptions;
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(
          JSON.stringify({
            options: agentOptions,
            defaultAgentId:
              agentOptions.find(
                (option) => option.agentCommand === config.sourceToProject.prLauncher.agentCommand,
              )?.id ?? agentOptions[0]?.id,
          }),
        );
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(
          JSON.stringify({
            options: [],
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return;
    }

    if (requestUrl.pathname === "/api/source-to-project/pr-launch") {
      if (request.method !== "POST") {
        writePrLaunchErrorResponse(response, 405, "Method not allowed.");
        return;
      }
      if (!watchDir) {
        writePrLaunchErrorResponse(
          response,
          404,
          "PR launch requires a dashboard watch directory.",
        );
        return;
      }
      const body = await readRequestBody(request).catch(() => "");
      try {
        const payload = parsePrLaunchRequestBody(body);
        const state = await readSelectedWorkflowStateForArtifact(
          watchDir,
          payload.runId,
          latestState,
          latestRun,
          latestRuns,
        );
        if (!state) {
          throw dashboardRequestError(404, "Workflow run not found.");
        }
        const config = loadTypedWeavekitConfig(options.configPath);
        const launchArgs = await buildSourceToProjectPrLaunchArgs({
          state,
          nodeId: payload.nodeId,
          agentId: payload.agentId,
          config,
        });
        const launcher = options.prLauncher ?? { launch: launchSourceToProjectPrAgent };
        const launch = await launcher.launch(launchArgs);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true, launch }));
      } catch (error) {
        const statusCode =
          typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : 500;
        writePrLaunchErrorResponse(
          response,
          statusCode,
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }

    if (requestUrl.pathname === "/api/artifact") {
      if (!watchDir) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Artifact serving requires a dashboard watch directory.");
        return;
      }

      const filePath = await resolveRunArtifactRequest(
        requestUrl,
        watchDir,
        latestRun,
        latestRuns,
      ).catch(() => undefined);
      if (!filePath) {
        const payloadArtifact = await resolveRunPayloadArtifactRequest(
          requestUrl,
          watchDir,
          latestState,
          latestRun,
          latestRuns,
        ).catch(() => undefined);
        if (payloadArtifact) {
          response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `inline; filename="${payloadArtifact.filename.replace(/"/g, "")}"`,
          });
          response.end(payloadArtifact.contents);
          return;
        }
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Artifact not found.");
        return;
      }

      const contentType = CONTENT_TYPES.get(extname(filePath)) ?? "application/octet-stream";
      try {
        const contents = await readFile(filePath);
        response.writeHead(200, {
          "Content-Type": contentType,
          "Content-Disposition": `inline; filename="${basename(filePath).replace(/"/g, "")}"`,
        });
        response.end(contents);
      } catch {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Artifact not found.");
      }
      return;
    }

    if (requestUrl.pathname === "/api/health") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    const filePath = resolveStaticPath(requestUrl.pathname, dashboardDir, repoRoot);
    if (!filePath) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }

    const contentType = CONTENT_TYPES.get(extname(filePath)) ?? "application/octet-stream";
    try {
      const contents = await readFile(filePath);
      response.writeHead(200, { "Content-Type": contentType });
      response.end(contents);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found.");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = process.env.PORTLESS_URL || `http://127.0.0.1:${resolvedPort}`;

  const publishStateInternal = (
    nextState: MacroWorkflowRunStateLike,
    event: MacroWorkflowEvent,
    history?: WorkflowReplayEvent[],
  ) => {
    latestState = nextState;
    latestEvent = event;
    if (history) {
      latestHistory = history;
    }
    if (nextState.runId) {
      const existingRun =
        latestRun?.runId === nextState.runId
          ? latestRun
          : latestRuns?.find((run) => run.runId === nextState.runId);
      latestRun = summarizeWorkflowRun(nextState, existingRun?.statePath ?? "", new Date());
    }
    const snapshot = toSerializablePayload(nextState, event, latestHistory, latestRun, latestRuns);
    for (const client of clients) {
      writeSseEvent(client.response, "state", snapshot);
    }
  };

  let watchInterval: NodeJS.Timeout | undefined;
  if (watchDir) {
    watchInterval = setInterval(() => {
      void refreshWorkflowSnapshot(watchDir, undefined, (snapshot) => {
        const snapshotVersion = createWorkflowDashboardSnapshotVersion(snapshot);
        latestState = snapshot.state;
        latestEvent = snapshot.event;
        latestHistory = snapshot.history;
        latestRun = snapshot.run;
        latestRuns = snapshot.runs;
        if (snapshot.state && snapshot.event && snapshotVersion !== latestWatchSnapshotVersion) {
          latestWatchSnapshotVersion = snapshotVersion;
          publishStateInternal(snapshot.state, snapshot.event, snapshot.history);
        }
      }).catch((error: unknown) => {
        logDashboardError(
          `Dashboard watch refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, 1000);
  }

  return {
    url: baseUrl,
    publishState(nextState, event, history) {
      publishStateInternal(nextState, event, history);
    },
    async stop() {
      if (watchInterval) {
        clearInterval(watchInterval);
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function resolveDashboardListenPort(explicitPort: number | undefined): number {
  if (explicitPort !== undefined) {
    return explicitPort;
  }
  const rawPort = process.env.PORT;
  if (rawPort === undefined) {
    return 0;
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid PORT value. Expected an integer between 1 and 65535.");
  }
  return port;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.on("data", (chunk: Buffer | string) => {
      body += chunk;
    });
    request.on("end", () => resolveBody(body));
    request.on("error", rejectBody);
  });
}

export async function createWorkflowDashboardPublisher(
  baseUrl: string,
): Promise<WorkflowDashboardPublisher> {
  return {
    async publishState(state, event, history) {
      const response = await fetch(new URL("/api/state", baseUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ state, event, history }),
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(`Dashboard update failed (${response.status}): ${message}`);
      }
    },
  };
}

function handleSseConnection(
  response: ServerResponse,
  state: MacroWorkflowRunStateLike | undefined,
  event: MacroWorkflowEvent | undefined,
  history?: WorkflowReplayEvent[],
) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  if (state) {
    const run = state.runId ? summarizeWorkflowRun(state, "", new Date()) : undefined;
    writeSseEvent(response, "state", toSerializablePayload(state, event, history, run));
  }
}

function writeSseEvent(
  response: ServerResponse,
  eventName: string,
  payload: WorkflowDashboardSnapshot,
) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function toSerializablePayload(
  state: MacroWorkflowRunStateLike | undefined,
  event: MacroWorkflowEvent | undefined,
  history?: WorkflowReplayEvent[],
  run?: WorkflowDashboardRunSummary,
  runs?: WorkflowDashboardRunSummary[],
): WorkflowDashboardSnapshot {
  return JSON.parse(
    JSON.stringify({ state, history, event, run, runs, activeRunId: run?.runId ?? state?.runId }),
  ) as WorkflowDashboardSnapshot;
}

export function createWorkflowDashboardSnapshotVersion(
  snapshot: WorkflowDashboardSnapshot,
): string {
  const latestHistoryEvent = snapshot.history?.at(-1);
  return JSON.stringify({
    stateRunId: snapshot.state?.runId,
    stateStatus: snapshot.state?.status,
    runUpdatedAt: snapshot.run?.updatedAt,
    event: latestHistoryEvent
      ? {
          seq: latestHistoryEvent.seq,
          ts: latestHistoryEvent.ts,
          kind: latestHistoryEvent.kind,
          nodeId: latestHistoryEvent.nodeId,
        }
      : undefined,
    historyLength: snapshot.history?.length ?? 0,
    runs:
      snapshot.runs?.map((run) => ({
        runId: run.runId,
        status: run.status,
        updatedAt: run.updatedAt,
      })) ?? [],
  });
}

function parsePrLaunchRequestBody(body: string): {
  runId?: string;
  nodeId: string;
  agentId?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw dashboardRequestError(400, "Invalid PR launch request JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw dashboardRequestError(400, "Invalid PR launch request.");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.nodeId !== "string" || !record.nodeId.trim()) {
    throw dashboardRequestError(400, "Missing nodeId.");
  }
  return {
    runId: typeof record.runId === "string" && record.runId.trim() ? record.runId : undefined,
    nodeId: record.nodeId,
    agentId:
      typeof record.agentId === "string" && record.agentId.trim() ? record.agentId : undefined,
  };
}

async function buildSourceToProjectPrLaunchArgs(args: {
  state: MacroWorkflowRunStateLike;
  nodeId: string;
  agentId?: string;
  config: WeavekitConfig;
}): Promise<SourceToProjectPrLaunchArgs> {
  if (args.state.templateId !== "source-to-project") {
    throw dashboardRequestError(
      409,
      "Manual PR launch is only available for source-to-project runs.",
    );
  }
  const node = (args.state.currentPlan?.nodes ?? args.state.plan?.nodes ?? []).find(
    (candidate) => candidate.id === args.nodeId,
  );
  const isReportNode = node?.kind === "report" && node.id.startsWith("report-opportunity-");
  if (!node || !isReportNode) {
    throw dashboardRequestError(409, "Manual PR launch requires a passed report node.");
  }
  const result = args.state.nodeResults?.find((entry) => entry.nodeId === args.nodeId);
  if (result?.status !== "passed") {
    throw dashboardRequestError(409, "Manual PR launch requires a passed report node.");
  }
  const reportMarkdown = readString(result.payload?.sourceToProjectReportMarkdown) ?? result.output;
  if (!reportMarkdown?.trim()) {
    throw dashboardRequestError(409, "Node is missing its reviewed source-to-project report.");
  }
  const project = await resolveProjectForSourceToProjectRun(args.state, args.config);
  if (!project.autonomousPrAllowed) {
    throw dashboardRequestError(403, `Autonomous PR work is disabled for project ${project.id}.`);
  }
  const opportunity = readObject(node.input?.opportunity);
  const plan = readObject(result.payload?.plan);
  const projectBrief = readProjectBrief(args.state);
  const context: SourceToProjectPrLaunchContext = {
    runId: args.state.runId ?? args.state.planId,
    nodeId: args.nodeId,
    objective: args.state.objective,
    source: readSourceReference(args.state),
    project,
    opportunityId: readString(opportunity?.id) ?? args.nodeId,
    opportunityTitle: readString(opportunity?.title) ?? node.title,
    reportMarkdown,
    planTitle: readString(plan?.title),
    recommendation: readString(plan?.recommendation),
    projectBrief,
    // The report node's plan was already produced and reviewed earlier in the workflow (see
    // reportMarkdown's embedded "Full Plan" section), so the manually-launched agent should
    // implement it directly rather than re-running /plan mode from scratch in the new worktree.
    initialPromptMode: "implement",
  };
  return {
    config: resolveSourceToProjectPrLauncherConfig(
      args.config.sourceToProject.prLauncher,
      args.agentId,
    ),
    context,
  };
}

function resolveSourceToProjectPrLauncherConfig(
  prLauncher: WeavekitConfig["sourceToProject"]["prLauncher"],
  agentId: string | undefined,
): WeavekitConfig["sourceToProject"]["prLauncher"] {
  if (!agentId) {
    return prLauncher;
  }
  const selected = prLauncher.agentOptions.find((option) => option.id === agentId);
  if (!selected) {
    throw dashboardRequestError(400, `Unknown agent id: ${agentId}.`);
  }
  return {
    ...prLauncher,
    agentCommand: selected.agentCommand,
    agentArgs: selected.agentArgs,
  };
}

async function resolveProjectForSourceToProjectRun(
  state: MacroWorkflowRunStateLike,
  config: WeavekitConfig,
): Promise<ProjectCatalogEntry> {
  const projects = Object.values(config.projects);
  if (projects.length === 0) {
    throw dashboardRequestError(409, "No configured project matches this source-to-project run.");
  }
  const cwdCandidates = Array.from(new Set(executionCwdCandidates(state)));
  for (const cwd of cwdCandidates) {
    const matched = projects.find((project) => resolve(project.workingTree) === resolve(cwd));
    if (matched) {
      return matched;
    }
  }
  const gitRemoteMatched = await resolveProjectByGitRemote(cwdCandidates, projects);
  if (gitRemoteMatched) {
    return gitRemoteMatched;
  }
  if (projects.length === 1) {
    return projects[0]!;
  }
  throw dashboardRequestError(
    409,
    "Could not determine which configured project owns this source-to-project run.",
  );
}

async function resolveProjectByGitRemote(
  cwdCandidates: string[],
  projects: ProjectCatalogEntry[],
): Promise<ProjectCatalogEntry | undefined> {
  const candidateRemoteUrls = new Set<string>();
  const remoteNames = Array.from(new Set(projects.map((project) => project.remote || "origin")));
  for (const cwd of cwdCandidates) {
    for (const remoteName of remoteNames) {
      const remoteUrl = await readGitRemoteUrl(cwd, remoteName);
      if (remoteUrl) {
        candidateRemoteUrls.add(remoteUrl);
      }
    }
  }
  if (candidateRemoteUrls.size === 0) {
    return undefined;
  }

  const matches: ProjectCatalogEntry[] = [];
  for (const project of projects) {
    const remoteUrl = await readGitRemoteUrl(project.workingTree, project.remote || "origin");
    if (remoteUrl && candidateRemoteUrls.has(remoteUrl)) {
      matches.push(project);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

async function readGitRemoteUrl(cwd: string, remoteName: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, "remote", "get-url", remoteName], {
      timeout: 3000,
    });
    const remoteUrl = normalizeGitRemoteUrl(result.stdout);
    return remoteUrl || undefined;
  } catch {
    return undefined;
  }
}

function normalizeGitRemoteUrl(value: string): string {
  return value
    .trim()
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
}

function executionCwdCandidates(state: MacroWorkflowRunStateLike): string[] {
  const candidates: string[] = [];
  for (const result of state.nodeResults ?? []) {
    const execution = result.execution;
    if (execution?.cwd) {
      candidates.push(execution.cwd);
    }
    for (const call of execution?.calls ?? []) {
      if (call.cwd) {
        candidates.push(call.cwd);
      }
    }
  }
  return candidates;
}

function readSourceReference(state: MacroWorkflowRunStateLike): string {
  const sourcePayload = state.nodeResults?.find(
    (result) => result.nodeId === "source-reading",
  )?.payload;
  const sourceAnalysis = readObject(sourcePayload?.sourceAnalysis);
  return readString(sourceAnalysis?.sourceId) ?? state.objective;
}

function readProjectBrief(state: MacroWorkflowRunStateLike): ProjectBrief | undefined {
  const projectResearchPayload = state.nodeResults?.find(
    (result) => result.nodeId === "project-research",
  )?.payload;
  return readObject(projectResearchPayload?.projectBrief) as ProjectBrief | undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function dashboardRequestError(
  statusCode: number,
  message: string,
): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function writePrLaunchErrorResponse(response: ServerResponse, statusCode: number, message: string) {
  logDashboardError(`Manual PR launch failed (${statusCode}): ${message}`);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ ok: false, error: message }));
}

function logDashboardError(message: string) {
  process.stderr.write(`[weavekit][error] ${message}\n`);
}

async function resolveRunArtifactRequest(
  requestUrl: URL,
  watchDir: string,
  latestRun: WorkflowDashboardRunSummary | undefined,
  latestRuns: WorkflowDashboardRunSummary[] | undefined,
): Promise<string | undefined> {
  const artifactFile = requestUrl.searchParams.get("file") ?? "";
  if (
    !artifactFile ||
    artifactFile.startsWith("/") ||
    artifactFile.split(/[\\/]+/).includes("..")
  ) {
    return undefined;
  }

  const runs = latestRuns ?? (await listWorkflowDashboardRuns(watchDir));
  const runId = requestUrl.searchParams.get("runId") ?? undefined;
  const selectedRun = runId ? runs.find((run) => run.runId === runId) : (latestRun ?? runs[0]);
  if (!selectedRun?.outputDir) {
    return undefined;
  }

  const outputDir = resolve(selectedRun.outputDir);
  const candidate = resolve(outputDir, artifactFile);
  if (candidate !== outputDir && !candidate.startsWith(`${outputDir}/`)) {
    return undefined;
  }

  const fileStats = await stat(candidate);
  return fileStats.isFile() ? candidate : undefined;
}

async function resolveRunPayloadArtifactRequest(
  requestUrl: URL,
  watchDir: string,
  latestState: MacroWorkflowRunStateLike | undefined,
  latestRun: WorkflowDashboardRunSummary | undefined,
  latestRuns: WorkflowDashboardRunSummary[] | undefined,
): Promise<{ filename: string; contents: string } | undefined> {
  const artifactFile = requestUrl.searchParams.get("file") ?? "";
  if (
    !artifactFile ||
    artifactFile.startsWith("/") ||
    artifactFile.split(/[\\/]+/).includes("..")
  ) {
    return undefined;
  }
  const suffix = ".payload.json";
  if (!artifactFile.endsWith(suffix)) {
    return undefined;
  }

  const nodeId = artifactFile.slice(0, -suffix.length);
  const runId = requestUrl.searchParams.get("runId") ?? undefined;
  const state = await readSelectedWorkflowStateForArtifact(
    watchDir,
    runId,
    latestState,
    latestRun,
    latestRuns,
  );
  const payload = state?.nodeResults.find((result) => result.nodeId === nodeId)?.payload;
  if (!payload) {
    return undefined;
  }

  return {
    filename: artifactFile,
    contents: JSON.stringify(payload, null, 2),
  };
}

async function readSelectedWorkflowStateForArtifact(
  watchDir: string,
  runId: string | undefined,
  latestState: MacroWorkflowRunStateLike | undefined,
  latestRun: WorkflowDashboardRunSummary | undefined,
  latestRuns: WorkflowDashboardRunSummary[] | undefined,
): Promise<MacroWorkflowRunStateLike | undefined> {
  if ((!runId || latestState?.runId === runId) && latestState) {
    return latestState;
  }

  const cachedRun = runId
    ? (latestRuns?.find((run) => run.runId === runId) ??
      (latestRun?.runId === runId ? latestRun : undefined))
    : (latestRun ?? latestRuns?.[0]);
  const runs = cachedRun?.statePath ? [cachedRun] : await listWorkflowDashboardRuns(watchDir);
  const selectedRun = runId ? runs.find((run) => run.runId === runId) : runs[0];
  if (!selectedRun?.statePath) {
    return undefined;
  }

  const contents = await readFile(selectedRun.statePath, "utf8");
  return JSON.parse(contents) as MacroWorkflowRunStateLike;
}

function resolveStaticPath(
  pathname: string,
  dashboardDir: string,
  repoRoot: string,
): string | undefined {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  if (normalizedPath.startsWith("/node_modules/")) {
    const relative = normalizedPath.slice("/node_modules/".length);
    const candidate = resolve(repoRoot, "node_modules", relative);
    return candidate.startsWith(repoRoot) ? candidate : undefined;
  }

  const candidate = resolve(dashboardDir, `.${normalizedPath}`);
  return candidate.startsWith(dashboardDir) ? candidate : undefined;
}

async function ensureDashboardBundle(dashboardDir: string, repoRoot: string) {
  const entryPoint = resolve(dashboardDir, "main.js");
  const outputFile = resolve(dashboardDir, "dist/main.js");
  await mkdir(resolve(dashboardDir, "dist"), { recursive: true });
  await build({
    entryPoints: [entryPoint],
    outfile: outputFile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    absWorkingDir: repoRoot,
    sourcemap: false,
    minify: false,
    logLevel: "silent",
    loader: { ".js": "jsx" },
  });
}

export async function readWorkflowReplayEvents(filePath: string): Promise<WorkflowReplayEvent[]> {
  const contents = await readFile(filePath, "utf8");
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as WorkflowReplayEvent;
      } catch (error) {
        throw new Error(
          `Invalid workflow replay event JSON on line ${index + 1}: ${(error as Error).message}`,
        );
      }
    });
}

export async function readWorkflowDashboardSnapshot(
  stateFilePath: string,
): Promise<WorkflowDashboardSnapshot> {
  const contents = await readFile(stateFilePath, "utf8");
  const state = JSON.parse(contents) as MacroWorkflowRunStateLike;
  const historyPath = join(dirname(stateFilePath), "workflow-events.jsonl");
  const history = await readWorkflowReplayEvents(historyPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

  const fileStats = await stat(stateFilePath);
  const run = summarizeWorkflowRun(state, stateFilePath, new Date(fileStats.mtimeMs));

  return {
    state,
    history,
    run,
    activeRunId: run.runId,
    event: {
      type: MacroWorkflowEventKind.RUN_STARTED,
      planId: state.planId,
      timestamp: new Date(),
    },
  };
}

export async function listWorkflowDashboardRuns(
  rootDir: string,
): Promise<WorkflowDashboardRunSummary[]> {
  const stateFilePaths = await listWorkflowStateFiles(rootDir);
  const runs: WorkflowDashboardRunSummary[] = [];
  for (const filePath of stateFilePaths) {
    try {
      const contents = await readFile(filePath.path, "utf8");
      const state = JSON.parse(contents) as MacroWorkflowRunStateLike;
      runs.push(summarizeWorkflowRun(state, filePath.path, new Date(filePath.mtimeMs)));
    } catch {
      // Ignore partially written or invalid snapshots while a run is being updated.
    }
  }
  return runs.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

async function refreshWorkflowSnapshot(
  watchDir: string,
  runId: string | undefined,
  onSnapshot: (snapshot: WorkflowDashboardSnapshot) => void,
) {
  const runs = await listWorkflowDashboardRuns(watchDir);
  if (runs.length === 0) {
    return;
  }

  const selectedRun = runId ? runs.find((run) => run.runId === runId) : runs[0];
  if (!selectedRun) {
    return;
  }
  const snapshot = await readWorkflowDashboardSnapshot(selectedRun.statePath);
  onSnapshot({ ...snapshot, runs });
}

function summarizeWorkflowRun(
  state: MacroWorkflowRunStateLike,
  statePath: string,
  updatedAt: Date,
): WorkflowDashboardRunSummary {
  const outputDir = statePath ? dirname(statePath) : "";
  const fallbackId = outputDir ? basename(outputDir) : state.planId;
  return {
    runId: state.runId ?? fallbackId,
    runName: state.runName ?? generateFallbackRunName(state.objective),
    objective: state.objective,
    status: String(state.status),
    startedAt: serializeDateLike(state.startedAt),
    completedAt: serializeDateLike(state.completedAt),
    outputDir,
    statePath,
    updatedAt: updatedAt.toISOString(),
  };
}

function generateFallbackRunName(objective: string): string {
  const words = objective
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .map((word) => word.slice(0, 18));
  if (words.length === 0) {
    return "Workflow Run";
  }
  return words
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

function serializeDateLike(value: Date | string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

async function listWorkflowStateFiles(
  rootDir: string,
): Promise<Array<{ path: string; mtimeMs: number }>> {
  const results: Array<{ path: string; mtimeMs: number }> = [];

  async function visit(currentDir: string) {
    try {
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = resolve(currentDir, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath);
          continue;
        }
        if (entry.isFile() && entry.name === "workflow-state.json") {
          const fileStats = await stat(entryPath);
          results.push({ path: entryPath, mtimeMs: fileStats.mtimeMs });
        }
      }
    } catch {
      // Ignore missing or unreadable directories.
    }
  }

  await visit(rootDir);
  return results;
}
