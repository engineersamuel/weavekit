import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvaluateSummaryV3 } from "promptfoo";
import { loadTypedWeavekitConfig } from "../config.js";
import { routerBamlClientNameForModel } from "../macro-workflow/router/harnesses.js";
import { BamlRouterProvider } from "./providers/router.js";
import { runEval as defaultRunEval } from "./run.js";
import { type CorpusItem, loadCorpus } from "./schema.js";

export interface RouterEvalResult {
  id: string;
  title: string;
  prompt: string;
  expectedRoute: string;
  actualRoute: string;
  promptRewrite: string;
  createWorktreeEligible: boolean;
}

export interface RunRouterEvalOptions {
  corpusDir?: string;
  resultsDir?: string;
  maxConcurrency?: number;
}

export interface RunRouterEvalResult {
  outputDir: string;
  evaluationId: string;
  summary: EvaluateSummaryV3;
}

export interface RunRouterEvalDeps {
  runEval?: typeof defaultRunEval;
}

export async function runRouterEval(
  options: RunRouterEvalOptions = {},
  deps: RunRouterEvalDeps = {},
): Promise<RunRouterEvalResult> {
  const corpusDir = options.corpusDir ?? "evals/corpus/router";
  const resultsDir = options.resultsDir ?? "evals/results/router";
  const items = loadCorpus(corpusDir);
  const routerConfig = loadTypedWeavekitConfig().router;

  const { outputDir, evaluationId, summary } = await (deps.runEval ?? defaultRunEval)(
    {
      corpusDir,
      resultsDir,
      maxConcurrency: options.maxConcurrency,
      evaluation: {
        description: "Router evaluation",
        workflow: "router",
      },
    },
    {
      providers: [
        new BamlRouterProvider({
          id: "weavekit:router",
          clientName: routerBamlClientNameForModel(routerConfig.primaryModel),
          config: routerConfig,
        }),
      ],
    },
  );
  const results = extractRouterEvalResults(items, summary);
  const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(join(outputDir, "router-results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(outputDir, "router-summary.md"), renderSummary(items, results));
  writeFileSync(join(outputDir, "router-report.json"), summaryText);
  return { outputDir, evaluationId, summary };
}

type RouterEvalSummary = {
  results?: Array<{
    vars?: Record<string, unknown>;
    response?: { metadata?: Record<string, unknown> };
  }>;
};

export function extractRouterEvalResults(
  items: CorpusItem[],
  summary: RouterEvalSummary,
): RouterEvalResult[] {
  const resultsByCase = new Map(
    (summary.results ?? []).map((result) => [String(result.vars?.caseId ?? ""), result]),
  );
  return items.map((item) => {
    const metadata = resultsByCase.get(item.id)?.response?.metadata;
    return {
      id: item.id,
      title: item.title,
      prompt: item.prompt,
      expectedRoute: item.referenceAnswer.recommendation,
      actualRoute: typeof metadata?.route === "string" ? metadata.route : "error",
      promptRewrite: typeof metadata?.promptRewrite === "string" ? metadata.promptRewrite : "",
      createWorktreeEligible: metadata?.createWorktreeEligible === true,
    };
  });
}

function renderSummary(items: CorpusItem[], results: RouterEvalResult[]): string {
  const routeMatches = results.filter(
    (result) => result.actualRoute === result.expectedRoute,
  ).length;
  return [
    "# Router Eval Summary",
    "",
    `- Items: ${items.length}`,
    `- Route matches: ${routeMatches}`,
    `- Route mismatches: ${items.length - routeMatches}`,
    "",
    "## Items",
    ...results.map(
      (result) =>
        `- ${result.id}: expected ${result.expectedRoute}, actual ${result.actualRoute}, rewrite ${result.promptRewrite ? "yes" : "no"}`,
    ),
  ].join("\n");
}
