import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { loadLocalEnvFiles } from "../src/config.js";
import { buildRouterComparisonConfig } from "../src/eval/routerComparisonConfig.js";
import { loadCorpus, type CorpusItem } from "../src/eval/schema.js";

type CliOptions = {
  corpusDir: string;
  resultsDir: string;
  maxConcurrency: number;
  limit?: number;
};

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    corpusDir: "evals/corpus/router",
    resultsDir: "evals/results/router-comparison",
    maxConcurrency: Number(process.env.EVAL_MAX_CONCURRENCY ?? 3),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--corpus-dir") {
      options.corpusDir = requireValue(argv[++index], arg);
      continue;
    }
    if (arg === "--results-dir" || arg === "--out-dir") {
      options.resultsDir = requireValue(argv[++index], arg);
      continue;
    }
    if (arg === "--limit") {
      const limit = Number(requireValue(argv[++index], arg));
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`--limit must be an integer >= 1; received ${String(limit)}.`);
      }
      options.limit = limit;
      continue;
    }
    if (arg === "--max-concurrency" || arg === "--concurrency") {
      options.maxConcurrency = parseConcurrency(requireValue(argv[++index], arg));
    }
  }
  options.maxConcurrency = parseConcurrency(String(options.maxConcurrency));
  return options;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseConcurrency(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`max concurrency must be an integer >= 1; received ${value}.`);
  }
  return parsed;
}

function renderSummary(items: CorpusItem[]): string {
  return [
    "# Router Promptfoo Comparison Summary",
    "",
    `- Items: ${items.length}`,
    "- Providers: router-deterministic, router-gpt-5-mini",
    "- Promptfoo description: Router deterministic vs gpt-5-mini comparison",
    "",
    "Open with `nubx promptfoo view --filter-description router -n` and select the Router comparison eval.",
    "",
    "## Items",
    ...items.map((item) => `- ${item.id} — ${item.title}`),
  ].join("\n");
}

async function main(): Promise<void> {
  loadLocalEnvFiles();
  const options = parseCliOptions(process.argv.slice(2));
  process.env.EVAL_JUDGE_MODEL ??= "gpt-5.5";
  process.env.EVAL_JUDGE_BASE_URL ??= "http://127.0.0.1:8080/v1";
  process.env.EVAL_JUDGE_API_KEY ??= process.env.COPILOT_PROXY_API_KEY ?? "sk-local";
  process.env.OPENAI_BASE_URL ??= process.env.EVAL_JUDGE_BASE_URL;
  process.env.OPENAI_API_KEY ??= process.env.EVAL_JUDGE_API_KEY;

  const items = loadCorpus(options.corpusDir).slice(0, options.limit);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(options.resultsDir, stamp);
  mkdirSync(outDir, { recursive: true });

  const providerPath = fileURLToPath(
    new URL("./promptfoo-router-provider-isolated.ts", import.meta.url),
  );
  const configPath = join(outDir, "promptfooconfig.yaml");
  const outputPath = join(outDir, "report.json");
  const judgeModel = process.env.EVAL_JUDGE_MODEL ?? "gpt-5.5";
  const judgeApiBaseUrl = process.env.EVAL_JUDGE_BASE_URL ?? "http://127.0.0.1:8080/v1";
  const judgeConfig =
    judgeApiBaseUrl.includes("127.0.0.1") || judgeApiBaseUrl.includes("localhost")
      ? {
          model: judgeModel,
          apiBaseUrl: judgeApiBaseUrl,
          apiKey: "sk-local",
        }
      : {
          model: judgeModel,
          apiBaseUrl: judgeApiBaseUrl,
          apiKeyEnvar: "EVAL_JUDGE_API_KEY",
        };
  writeFileSync(
    configPath,
    stringify(buildRouterComparisonConfig(items, providerPath, judgeConfig)),
    "utf8",
  );

  const result = spawnSync(
    "nubx",
    [
      "promptfoo",
      "eval",
      "--config",
      configPath,
      "--description",
      "Router deterministic vs gpt-5-mini comparison",
      "--max-concurrency",
      String(options.maxConcurrency),
      "--output",
      outputPath,
      "--no-cache",
      "--no-table",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    },
  );
  if (result.status !== 0 && result.status !== 100) {
    throw new Error(`promptfoo eval failed with exit code ${String(result.status)}.`);
  }

  writeFileSync(join(outDir, "summary.md"), renderSummary(items));
  console.log(`Promptfoo Router comparison complete. Results written to ${outDir}`);
  console.log("Open only Router evals with: nubx promptfoo view --filter-description router -n");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
