import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runEval } from "./run.js";
import { type CorpusItem, loadCorpus } from "./schema.js";
import { loadTypedWeavekitConfig } from "../config.js";
import { routerBamlClientNameForModel } from "../macro-workflow/router/harnesses.js";
import { BamlRouterProvider } from "./providers/router.js";

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

export async function runRouterEval(options: RunRouterEvalOptions = {}): Promise<string> {
  const corpusDir = options.corpusDir ?? "evals/corpus/router";
  const resultsDir = options.resultsDir ?? "evals/results/router";
  const items = loadCorpus(corpusDir);
  const routerConfig = loadTypedWeavekitConfig().router;

  const outDir = await runEval(
    { corpusDir, resultsDir, maxConcurrency: options.maxConcurrency },
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
  const summaryText = readFileSync(join(outDir, "report.json"), "utf8");
  const results = extractRouterEvalResults(items, JSON.parse(summaryText) as RouterEvalSummary);
  writeFileSync(join(outDir, "router-results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(outDir, "router-summary.md"), renderSummary(items, results));
  writeFileSync(join(outDir, "router-report.json"), summaryText);
  return outDir;
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
