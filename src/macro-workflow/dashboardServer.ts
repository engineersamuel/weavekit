import { readdir, mkdir, readFile, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { MacroWorkflowEventKind, type MacroWorkflowEvent } from "./logger.js";
import type { MacroWorkflowRunStateLike, WorkflowReplayEvent } from "./types.js";

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
  publishState: (state: MacroWorkflowRunStateLike, event: MacroWorkflowEvent, history?: WorkflowReplayEvent[]) => void;
  stop: () => Promise<void>;
};

export type WorkflowDashboardPublisher = {
  publishState: (state: MacroWorkflowRunStateLike, event: MacroWorkflowEvent, history?: WorkflowReplayEvent[]) => Promise<void>;
};

export type WorkflowDashboardServerOptions = {
  port?: number;
  watchDir?: string;
};

const CONTENT_TYPES = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

export async function createWorkflowDashboardServer(
  initialState: MacroWorkflowRunStateLike | undefined,
  options: WorkflowDashboardServerOptions = {},
): Promise<WorkflowDashboardServer> {
  const dashboardDir = fileURLToPath(new URL("./dashboard/", import.meta.url));
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const port = options.port ?? 0;

  await ensureDashboardBundle(dashboardDir, repoRoot);
  const watchDir = options.watchDir ? resolve(options.watchDir) : undefined;
  const clients = new Set<{ response: ServerResponse }>();

  let latestState: MacroWorkflowRunStateLike | undefined = initialState;
  let latestEvent: MacroWorkflowEvent | undefined;
  let latestHistory: WorkflowReplayEvent[] | undefined;
  let latestRun: WorkflowDashboardRunSummary | undefined;
  let latestRuns: WorkflowDashboardRunSummary[] | undefined;

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
      response.end(JSON.stringify(toSerializablePayload(latestState, latestEvent, latestHistory, latestRun, latestRuns)));
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
        }).catch(() => undefined);
      }
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(toSerializablePayload(latestState, latestEvent, latestHistory, latestRun, latestRuns)));
      return;
    }

    if (requestUrl.pathname === "/api/runs") {
      if (watchDir) {
        latestRuns = await listWorkflowDashboardRuns(watchDir).catch(() => latestRuns);
      }
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ runs: latestRuns ?? [], activeRunId: latestRun?.runId ?? latestState?.runId }));
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
  const baseUrl = `http://127.0.0.1:${resolvedPort}`;

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
      latestRun = summarizeWorkflowRun(nextState, "", new Date());
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
        latestState = snapshot.state;
        latestEvent = snapshot.event;
        latestHistory = snapshot.history;
        latestRun = snapshot.run;
        latestRuns = snapshot.runs;
        if (snapshot.state && snapshot.event) {
          publishStateInternal(snapshot.state, snapshot.event, snapshot.history);
        }
      }).catch(() => undefined);
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

export async function createWorkflowDashboardPublisher(baseUrl: string): Promise<WorkflowDashboardPublisher> {
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

function writeSseEvent(response: ServerResponse, eventName: string, payload: WorkflowDashboardSnapshot) {
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
  return JSON.parse(JSON.stringify({ state, history, event, run, runs, activeRunId: run?.runId ?? state?.runId })) as WorkflowDashboardSnapshot;
}

function resolveStaticPath(pathname: string, dashboardDir: string, repoRoot: string): string | undefined {
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
        throw new Error(`Invalid workflow replay event JSON on line ${index + 1}: ${(error as Error).message}`);
      }
    });
}

export async function readWorkflowDashboardSnapshot(stateFilePath: string): Promise<WorkflowDashboardSnapshot> {
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

export async function listWorkflowDashboardRuns(rootDir: string): Promise<WorkflowDashboardRunSummary[]> {
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

async function refreshWorkflowSnapshot(watchDir: string, runId: string | undefined, onSnapshot: (snapshot: WorkflowDashboardSnapshot) => void) {
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
  const words = objective.split(/\s+/).filter(Boolean).slice(0, 5).map((word) => word.slice(0, 18));
  if (words.length === 0) {
    return "Workflow Run";
  }
  return words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`).join(" ");
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

async function listWorkflowStateFiles(rootDir: string): Promise<Array<{ path: string; mtimeMs: number }>> {
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
