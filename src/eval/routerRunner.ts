import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runEval } from "./run.js";
import { RouterProvider } from "./providers/router.js";
import { type CorpusItem, loadCorpus } from "./schema.js";
import { createInitialWorkflowRouter } from "../initialRouter.js";

export interface RouteClassificationResult {
  id: string;
  title: string;
  prompt: string;
  expectedRoute: string;
  actualRoute: string;
  score: number;
  rationale: string;
  consideration: string;
  needsElicitation: boolean;
}

export interface RunRouteClassificationOptions {
  corpusDir?: string;
  resultsDir?: string;
  maxConcurrency?: number;
}

function toSafeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderDashboard(
  items: CorpusItem[],
  results: RouteClassificationResult[],
  summary: unknown,
): string {
  const stats = ((summary as { stats?: Record<string, unknown> } | undefined)?.stats ??
    {}) as Record<string, unknown>;
  const routeMatches = results.filter(
    (result) => result.actualRoute === result.expectedRoute,
  ).length;
  const routeMismatches = results.length - routeMatches;
  const rows = results
    .map((result) => {
      const passed = result.actualRoute === result.expectedRoute;
      return `
        <tr class="${passed ? "pass" : "fail"}">
          <td>${escapeHtml(result.id)}</td>
          <td>${escapeHtml(result.title)}</td>
          <td>${escapeHtml(result.expectedRoute)}</td>
          <td>${escapeHtml(result.actualRoute)}</td>
          <td>${escapeHtml(String(result.score))}</td>
          <td>${escapeHtml(String(result.needsElicitation))}</td>
          <td>${escapeHtml(result.rationale)}</td>
        </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Router classification dashboard</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
      body { margin: 0; background: #111827; color: #f9fafb; padding: 2rem; }
      h1, h2 { margin-top: 0; }
      .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
      .card { background: #1f2937; padding: 1rem; border-radius: 12px; border: 1px solid #374151; }
      .card strong { display: block; font-size: 1.5rem; margin-top: 0.25rem; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 0.75rem; border-bottom: 1px solid #374151; text-align: left; vertical-align: top; }
      th { background: #111827; position: sticky; top: 0; }
      tr.pass { background: rgba(34, 197, 94, 0.12); }
      tr.fail { background: rgba(248, 113, 113, 0.12); }
      code { color: #fbbf24; }
    </style>
  </head>
  <body>
    <h1>Router classification dashboard</h1>
    <p>Promptfoo eval results for the initial workflow router, grouped by route.</p>
    <div class="summary">
      <div class="card"><span>Items</span><strong>${items.length}</strong></div>
      <div class="card"><span>Route matches</span><strong>${routeMatches}</strong></div>
      <div class="card"><span>Route mismatches</span><strong>${routeMismatches}</strong></div>
      <div class="card"><span>Promptfoo successes</span><strong>${toSafeString(stats.successes ?? "n/a")}</strong></div>
      <div class="card"><span>Promptfoo failures</span><strong>${toSafeString(stats.failures ?? "n/a")}</strong></div>
    </div>
    <h2>Results</h2>
    <table>
      <thead>
        <tr>
          <th>Id</th>
          <th>Title</th>
          <th>Expected</th>
          <th>Actual</th>
          <th>Score</th>
          <th>Needs elicitation</th>
          <th>Rationale</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </body>
</html>`;
}

export async function runRouteClassificationEval(
  options: RunRouteClassificationOptions = {},
): Promise<string> {
  const corpusDir = options.corpusDir ?? "evals/corpus/router-classification";
  const resultsDir = options.resultsDir ?? "evals/results/router-classification";
  const router = createInitialWorkflowRouter();
  const items = loadCorpus(corpusDir);
  const results: RouteClassificationResult[] = [];

  for (const item of items) {
    const decision = await router.route({
      prompt: item.prompt,
      context: item.context.join("\n"),
    });
    results.push({
      id: item.id,
      title: item.title,
      prompt: item.prompt,
      expectedRoute: item.referenceAnswer.recommendation,
      actualRoute: decision.route,
      score: decision.score,
      rationale: decision.rationale,
      consideration: decision.consideration,
      needsElicitation: decision.needsElicitation,
    });
  }

  const outDir = await runEval(
    { corpusDir, resultsDir, maxConcurrency: options.maxConcurrency },
    { providers: [new RouterProvider({ router })] },
  );

  const summaryPath = join(outDir, "report.json");
  const summaryText = readFileSync(summaryPath, "utf8");
  const parsedSummary = summaryText ? JSON.parse(summaryText) : {};
  writeFileSync(join(outDir, "route-results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(outDir, "dashboard.html"), renderDashboard(items, results, parsedSummary));
  return outDir;
}
