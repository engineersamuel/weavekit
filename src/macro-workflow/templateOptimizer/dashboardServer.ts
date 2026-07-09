import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Server } from "node:http";
import type { TemplateOptimizerRunArtifact } from "./artifacts.js";

export type TemplateOptimizerDashboardRunSummary = {
  runId: string;
  templateId?: string;
  mode?: string;
  status: string;
  finalRecommendation?: string;
  finalCandidateId?: string;
  generatedAt?: string;
  updatedAt: string;
  outputDir: string;
  runPath: string;
  iterationCount: number;
  scoreDelta?: number;
  decisionConfidence?: number;
  criticalRegressionCount: number;
  rejectedMoveCount: number;
};

export type TemplateOptimizerDashboardRunDetail = {
  run: TemplateOptimizerRunArtifact;
  summary?: TemplateOptimizerDashboardRunSummary;
  baselineGraph: TemplateOptimizerDashboardGraph;
  finalGraph: TemplateOptimizerDashboardGraph;
  graphComparison: TemplateOptimizerGraphComparison;
  candidateComparisons: TemplateOptimizerCandidateComparison[];
  summaryMarkdown?: string;
  applyDryRunMarkdown?: string;
};

export type TemplateOptimizerCandidateComparison = {
  id: string;
  role: "baseline" | "challenger" | "final-incumbent";
  summary?: string;
  recommendation?: string;
  strategy?: string;
  scoreDelta?: number;
  decisionConfidence?: number;
  replacedIncumbent?: boolean;
  criticalRegressionCount?: number;
};

export type TemplateOptimizerDashboardGraph = {
  nodes: Array<{
    id: string;
    title: string;
    kind?: string;
    harness?: string;
    source: "shared-initial" | "expansion";
    mode?: string;
    expansionCaseId?: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
  }>;
};

export type TemplateOptimizerGraphMetrics = {
  totalNodes: number;
  sharedInitialNodes: number;
  expansionNodes: number;
  edges: number;
  expansionCases: number;
};

export type TemplateOptimizerGraphComparison = {
  baseline: TemplateOptimizerGraphMetrics;
  proposed: TemplateOptimizerGraphMetrics;
  addedNodes: TemplateOptimizerDashboardGraph["nodes"];
  removedNodes: TemplateOptimizerDashboardGraph["nodes"];
  addedEdges: TemplateOptimizerDashboardGraph["edges"];
  removedEdges: TemplateOptimizerDashboardGraph["edges"];
};

export type TemplateOptimizerDashboardServer = {
  url: string;
  stop: () => Promise<void>;
};

export type TemplateOptimizerDashboardServerOptions = {
  port?: number;
  runsRoot?: string;
  templateId?: string;
};

const CONTENT_TYPES = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
]);

const ALLOWED_ARTIFACTS = new Set([
  "optimizer-run.json",
  "summary.md",
  "apply-dry-run.md",
  "apply-summary.md",
]);

export async function createTemplateOptimizerDashboardServer(
  options: TemplateOptimizerDashboardServerOptions = {},
): Promise<TemplateOptimizerDashboardServer> {
  const dashboardDir = fileURLToPath(new URL("./dashboard/", import.meta.url));
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const port = options.port ?? 0;
  const runsRoot = resolve(options.runsRoot ?? join("evals", "template-optimizer", "runs"));
  const templateId = options.templateId;

  await ensureTemplateOptimizerDashboardBundle(dashboardDir, repoRoot);

  const server = createServer(async (request, response) => {
    if (!request.url) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Missing request URL.");
      return;
    }

    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (requestUrl.pathname === "/") {
      requestUrl.pathname = "/index.html";
    }

    if (requestUrl.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (requestUrl.pathname === "/api/health") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (requestUrl.pathname === "/api/runs") {
      const runs = await listTemplateOptimizerDashboardRuns(runsRoot, { templateId }).catch(
        () => [],
      );
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ runs, latestRunId: runs[0]?.runId }));
      return;
    }

    if (requestUrl.pathname === "/api/run") {
      const runId = requestUrl.searchParams.get("runId") ?? undefined;
      const detail = await readTemplateOptimizerDashboardRun(runsRoot, runId, { templateId }).catch(
        () => undefined,
      );
      if (!detail) {
        response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Run not found." }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(detail));
      return;
    }

    if (requestUrl.pathname === "/api/artifact") {
      const filePath = await resolveArtifactRequest(requestUrl, runsRoot, { templateId }).catch(
        () => undefined,
      );
      if (!filePath) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Artifact not found.");
        return;
      }

      try {
        const contents = await readFile(filePath);
        response.writeHead(200, {
          "Content-Type": CONTENT_TYPES.get(extname(filePath)) ?? "application/octet-stream",
          "Content-Disposition": `inline; filename="${basename(filePath).replace(/"/g, "")}"`,
        });
        response.end(contents);
      } catch {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Artifact not found.");
      }
      return;
    }

    const filePath = resolveTemplateOptimizerStaticPath(
      requestUrl.pathname,
      dashboardDir,
      repoRoot,
    );
    if (filePath) {
      const contentType = CONTENT_TYPES.get(extname(filePath)) ?? "application/octet-stream";
      try {
        const contents = await readFile(filePath);
        response.writeHead(200, { "Content-Type": contentType });
        response.end(contents);
      } catch {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found.");
      }
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found.");
  });

  await listen(server, port);
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `http://127.0.0.1:${resolvedPort}`,
    stop: () => close(server),
  };
}

export async function listTemplateOptimizerDashboardRuns(
  runsRoot: string,
  options: { templateId?: string } = {},
): Promise<TemplateOptimizerDashboardRunSummary[]> {
  const runPaths = await listOptimizerRunFiles(resolve(runsRoot));
  const runs: TemplateOptimizerDashboardRunSummary[] = [];
  for (const filePath of runPaths) {
    try {
      const run = await readTemplateOptimizerRunArtifact(filePath.path);
      if (options.templateId && run.templateId !== options.templateId) {
        continue;
      }
      runs.push(summarizeTemplateOptimizerRun(run, filePath.path, new Date(filePath.mtimeMs)));
    } catch {
      // Ignore partially written runs while an optimizer process is still updating files.
    }
  }
  return runs.sort(
    (left, right) =>
      Date.parse(right.generatedAt ?? right.updatedAt) -
      Date.parse(left.generatedAt ?? left.updatedAt),
  );
}

export async function readTemplateOptimizerDashboardRun(
  runsRoot: string,
  runId: string | undefined,
  options: { templateId?: string } = {},
): Promise<TemplateOptimizerDashboardRunDetail | undefined> {
  const runs = await listTemplateOptimizerDashboardRuns(runsRoot, options);
  const selectedRun = runId ? runs.find((run) => run.runId === runId) : runs[0];
  if (!selectedRun) {
    return undefined;
  }

  const run = await readTemplateOptimizerRunArtifact(selectedRun.runPath);
  const outputDir = resolve(selectedRun.outputDir);
  const baselineGraph = buildTemplateOptimizerDashboardGraph(run.baseline);
  const finalGraph = buildTemplateOptimizerDashboardGraph(run.finalIncumbent);
  return {
    run,
    summary: selectedRun,
    baselineGraph,
    finalGraph,
    graphComparison: compareTemplateOptimizerDashboardGraphs(baselineGraph, finalGraph),
    candidateComparisons: buildTemplateOptimizerCandidateComparisons(run),
    summaryMarkdown: await readOptionalUtf8(resolve(outputDir, "summary.md")),
    applyDryRunMarkdown: await readOptionalUtf8(resolve(outputDir, "apply-dry-run.md")),
  };
}

function buildTemplateOptimizerCandidateComparisons(
  run: TemplateOptimizerRunArtifact,
): TemplateOptimizerCandidateComparison[] {
  return [
    {
      id: run.baselineCandidateId,
      role: "baseline",
      summary: run.baselineRecommendation.summary,
      recommendation: "current-template",
    },
    ...run.iterations.map((iteration) => ({
      id: iteration.challengerId,
      role: "challenger" as const,
      strategy: iteration.strategy,
      scoreDelta: iteration.aggregateJudgment.scoreDelta,
      decisionConfidence: iteration.aggregateJudgment.decisionConfidence,
      replacedIncumbent: iteration.replacedIncumbent,
      criticalRegressionCount: iteration.aggregateJudgment.criticalRegressionCount,
    })),
    {
      id: run.finalRecommendation.candidateId,
      role: "final-incumbent",
      summary: run.finalIncumbent.summary,
      recommendation: run.finalRecommendation.recommendation,
    },
  ];
}

function buildTemplateOptimizerDashboardGraph(
  candidate: TemplateOptimizerRunArtifact["finalIncumbent"],
): TemplateOptimizerDashboardGraph {
  const nodes: TemplateOptimizerDashboardGraph["nodes"] = [];
  const edges: TemplateOptimizerDashboardGraph["edges"] = [];
  const sharedNodeIds = new Map<string, string>();

  for (const node of candidate.sharedInitialNodes) {
    sharedNodeIds.set(node.id, node.id);
    nodes.push({
      id: node.id,
      title: node.title || node.id,
      kind: node.kind,
      harness: node.harness,
      source: "shared-initial",
    });
  }

  for (const node of candidate.sharedInitialNodes) {
    for (const dependency of node.dependsOn) {
      const dependencyId = sharedNodeIds.get(dependency);
      if (dependencyId) {
        edges.push({ from: dependencyId, to: node.id });
      }
    }
  }

  for (const policy of candidate.modePolicies) {
    for (const expansion of policy.expansionCases) {
      const expansionNodeIds = new Map<string, string>();
      for (const node of expansion.nodes) {
        const graphNodeId = `${policy.mode}:${expansion.id}:${node.id}`;
        expansionNodeIds.set(node.id, graphNodeId);
        nodes.push({
          id: graphNodeId,
          title: node.title || node.id,
          kind: node.kind,
          harness: node.harness,
          source: "expansion",
          mode: policy.mode,
          expansionCaseId: expansion.id,
        });
      }

      for (const node of expansion.nodes) {
        const to = expansionNodeIds.get(node.id);
        if (!to) {
          continue;
        }
        for (const dependency of node.dependsOn) {
          const from = expansionNodeIds.get(dependency) ?? sharedNodeIds.get(dependency);
          if (from) {
            edges.push({ from, to });
          }
        }
      }
    }
  }

  return { nodes, edges };
}

function compareTemplateOptimizerDashboardGraphs(
  baseline: TemplateOptimizerDashboardGraph,
  proposed: TemplateOptimizerDashboardGraph,
): TemplateOptimizerGraphComparison {
  const baselineNodeIds = new Set(baseline.nodes.map((node) => node.id));
  const proposedNodeIds = new Set(proposed.nodes.map((node) => node.id));
  const baselineEdgeIds = new Set(baseline.edges.map(edgeKey));
  const proposedEdgeIds = new Set(proposed.edges.map(edgeKey));

  return {
    baseline: summarizeTemplateOptimizerDashboardGraph(baseline),
    proposed: summarizeTemplateOptimizerDashboardGraph(proposed),
    addedNodes: proposed.nodes.filter((node) => !baselineNodeIds.has(node.id)),
    removedNodes: baseline.nodes.filter((node) => !proposedNodeIds.has(node.id)),
    addedEdges: proposed.edges.filter((edge) => !baselineEdgeIds.has(edgeKey(edge))),
    removedEdges: baseline.edges.filter((edge) => !proposedEdgeIds.has(edgeKey(edge))),
  };
}

function summarizeTemplateOptimizerDashboardGraph(
  graph: TemplateOptimizerDashboardGraph,
): TemplateOptimizerGraphMetrics {
  const expansionCases = new Set(
    graph.nodes
      .map((node) => node.expansionCaseId)
      .filter((expansionCaseId): expansionCaseId is string => Boolean(expansionCaseId)),
  );
  return {
    totalNodes: graph.nodes.length,
    sharedInitialNodes: graph.nodes.filter((node) => node.source === "shared-initial").length,
    expansionNodes: graph.nodes.filter((node) => node.source === "expansion").length,
    edges: graph.edges.length,
    expansionCases: expansionCases.size,
  };
}

function edgeKey(edge: TemplateOptimizerDashboardGraph["edges"][number]): string {
  return `${edge.from}->${edge.to}`;
}

function summarizeTemplateOptimizerRun(
  run: TemplateOptimizerRunArtifact,
  runPath: string,
  updatedAt: Date,
): TemplateOptimizerDashboardRunSummary {
  const latestIteration = run.iterations.at(-1);
  const aggregate = latestIteration?.aggregateJudgment;
  const fallbackRunId = basename(resolve(runPath, ".."));
  const finalCandidateId = run.finalRecommendation?.candidateId ?? run.finalIncumbent?.id;
  return {
    runId: run.runId ?? fallbackRunId,
    templateId: run.templateId,
    mode: run.mode,
    status: run.status,
    finalRecommendation: run.finalRecommendation?.recommendation,
    finalCandidateId,
    generatedAt: run.generatedAt,
    updatedAt: updatedAt.toISOString(),
    outputDir: resolve(runPath, ".."),
    runPath,
    iterationCount: run.iterations.length,
    scoreDelta: aggregate?.scoreDelta,
    decisionConfidence: aggregate?.decisionConfidence,
    criticalRegressionCount: aggregate?.criticalRegressionCount ?? 0,
    rejectedMoveCount: run.rejectedMoves.length + (run.liveRejectedMoves?.length ?? 0),
  };
}

async function readTemplateOptimizerRunArtifact(
  filePath: string,
): Promise<TemplateOptimizerRunArtifact> {
  const contents = await readFile(filePath, "utf8");
  return JSON.parse(contents) as TemplateOptimizerRunArtifact;
}

async function listOptimizerRunFiles(
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
        if (entry.isFile() && entry.name === "optimizer-run.json") {
          const fileStats = await stat(entryPath);
          results.push({ path: entryPath, mtimeMs: fileStats.mtimeMs });
        }
      }
    } catch {
      // Missing or unreadable directories are treated as no runs.
    }
  }
  await visit(rootDir);
  return results;
}

async function resolveArtifactRequest(
  requestUrl: URL,
  runsRoot: string,
  options: { templateId?: string } = {},
): Promise<string | undefined> {
  const artifactFile = requestUrl.searchParams.get("file") ?? "";
  if (!ALLOWED_ARTIFACTS.has(artifactFile)) {
    return undefined;
  }

  const runId = requestUrl.searchParams.get("runId") ?? undefined;
  const runs = await listTemplateOptimizerDashboardRuns(runsRoot, options);
  const selectedRun = runId ? runs.find((run) => run.runId === runId) : runs[0];
  if (!selectedRun) {
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

async function readOptionalUtf8(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolveClose();
    });
  });
}

function resolveTemplateOptimizerStaticPath(
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

async function ensureTemplateOptimizerDashboardBundle(dashboardDir: string, repoRoot: string) {
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
