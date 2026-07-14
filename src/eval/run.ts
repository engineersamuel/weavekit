import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiProvider, EvaluateSummaryV3 } from "promptfoo";
import { type CorpusItem, loadCorpus } from "./schema.js";
import { buildSuite } from "./buildSuite.js";
import {
  runPersistedPromptfooEvaluation,
  type PromptfooEvaluationTags,
} from "./promptfooRunner.js";

type RunEvalWorkflow = Extract<PromptfooEvaluationTags["workflow"], "decision" | "router">;

export interface RunEvalMetadata {
  description: string;
  workflow: RunEvalWorkflow;
}

export interface RunEvalOptions {
  corpusDir?: string;
  resultsDir?: string;
  filterIds?: string[];
  maxConcurrency?: number;
  evaluation?: RunEvalMetadata;
}

export interface RunEvalDeps {
  providers?: ApiProvider[];
  runPromptfoo?: typeof runPersistedPromptfooEvaluation;
}

export interface RunEvalResult {
  outputDir: string;
  evaluationId: string;
  summary: EvaluateSummaryV3;
}

interface SummaryLike {
  stats?: { successes?: number; failures?: number };
}

async function defaultProviders(): Promise<ApiProvider[]> {
  const [{ CouncilProvider }, { CopilotCliProvider }] = await Promise.all([
    import("./providers/council.js"),
    import("./providers/copilot.js"),
  ]);
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

export async function runEval(
  options: RunEvalOptions = {},
  deps: RunEvalDeps = {},
): Promise<RunEvalResult> {
  if (
    options.maxConcurrency !== undefined &&
    (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1)
  ) {
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
  const suite = buildSuite(items, { providers });
  const evaluation = options.evaluation ?? {
    description: "Decision council evaluation",
    workflow: "decision",
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(options.resultsDir ?? "evals/results", stamp);
  mkdirSync(outDir, { recursive: true });

  const { evaluationId, summary } = await (deps.runPromptfoo ?? runPersistedPromptfooEvaluation)({
    suite,
    description: evaluation.description,
    tags: {
      workflow: evaluation.workflow,
      phase: "judge",
      runId: randomUUID(),
    },
    cache: false,
    maxConcurrency: options.maxConcurrency ?? 1,
  });

  writeFileSync(join(outDir, "report.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, "summary.md"), renderSummary(items, summary));
  writeFileSync(
    join(outDir, "promptfoo-evaluation.json"),
    JSON.stringify({ evaluationId }, null, 2),
  );
  return { outputDir: outDir, evaluationId, summary };
}
