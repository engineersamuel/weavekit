import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "promptfoo";
import type { ApiProvider } from "promptfoo";
import { type CorpusItem, loadCorpus } from "./schema.js";
import { buildSuite } from "./buildSuite.js";

export interface RunEvalOptions {
  corpusDir?: string;
  resultsDir?: string;
  filterIds?: string[];
  maxConcurrency?: number;
}

export interface RunEvalDeps {
  providers?: ApiProvider[];
  evaluateFn?: typeof evaluate;
}

interface SummaryLike {
  stats?: { successes?: number; failures?: number };
}

async function defaultProviders(): Promise<ApiProvider[]> {
  const [{ CouncilProvider }, { CopilotCliProvider }] = await Promise.all([import("./providers/council.js"), import("./providers/copilot.js")]);
  return [new CouncilProvider(), new CopilotCliProvider()];
}

function renderSummary(items: CorpusItem[], summary: SummaryLike): string {
  const stats = summary.stats ?? {};
  return [
    "# Decision Council Eval Summary",
    "",
    `- Items: ${items.length}`,
    `- Successes: ${stats.successes ?? "n/a"}`,
    `- Failures: ${stats.failures ?? "n/a"}`,
    "",
    "Per-criterion (weighted g-eval) and pairwise (select-best) results are in report.json.",
    "",
    "## Items",
    ...items.map((item) => `- ${item.id} — ${item.title}`),
  ].join("\n");
}

export async function runEval(options: RunEvalOptions = {}, deps: RunEvalDeps = {}): Promise<string> {
  if (options.maxConcurrency !== undefined && (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1)) {
    throw new Error(`maxConcurrency must be an integer >= 1; received ${options.maxConcurrency}.`);
  }

  const corpusDir = options.corpusDir ?? "evals/corpus";
  let items = loadCorpus(corpusDir);
  if (options.filterIds && options.filterIds.length > 0) {
    const wanted = new Set(options.filterIds);
    items = items.filter((item) => wanted.has(item.id));
  }
  if (items.length === 0) {
    throw new Error("No corpus items selected.");
  }

  const providers = deps.providers ?? (await defaultProviders());
  const evaluateFn = deps.evaluateFn ?? evaluate;
  const suite = buildSuite(items, { providers });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(options.resultsDir ?? "evals/results", stamp);
  mkdirSync(outDir, { recursive: true });

  const result = await evaluateFn(suite, {
    maxConcurrency: options.maxConcurrency ?? 1,
    cache: false,
  });
  const summary = (await result.toEvaluateSummary()) as SummaryLike;

  writeFileSync(join(outDir, "report.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, "summary.md"), renderSummary(items, summary));
  return outDir;
}
