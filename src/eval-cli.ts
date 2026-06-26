import { pathToFileURL } from "node:url";
import { runEval } from "./eval/run.js";

export interface ParsedEvalArgs {
  filterIds?: string[];
  maxConcurrency?: number;
}

function parseConcurrency(value: string | undefined, source: string): number {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${source} requires an integer value >= 1.`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${source} must be an integer >= 1; received "${value}".`);
  }
  return parsed;
}

export function parseEvalArgs(argv: string[]): ParsedEvalArgs {
  const filterIds: string[] = [];
  let maxConcurrency: number | undefined;
  let sawConcurrencyFlag = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      filterIds.push(...argv.slice(index + 1).filter((value) => !value.startsWith("-")));
      break;
    }

    const inlineMaxConcurrency = arg.match(/^--(?:max-concurrency|concurrency)=(.*)$/);
    if (inlineMaxConcurrency) {
      sawConcurrencyFlag = true;
      maxConcurrency = parseConcurrency(inlineMaxConcurrency[1], "--max-concurrency");
      continue;
    }

    if (arg === "--max-concurrency" || arg === "--concurrency") {
      sawConcurrencyFlag = true;
      maxConcurrency = parseConcurrency(argv[index + 1], arg);
      index += 1;
      continue;
    }

    if (!arg.startsWith("-")) {
      filterIds.push(arg);
    }
  }

  if (!sawConcurrencyFlag && process.env.EVAL_MAX_CONCURRENCY !== undefined && process.env.EVAL_MAX_CONCURRENCY.trim() !== "") {
    maxConcurrency = parseConcurrency(process.env.EVAL_MAX_CONCURRENCY, "EVAL_MAX_CONCURRENCY");
  }

  return {
    filterIds: filterIds.length > 0 ? filterIds : undefined,
    maxConcurrency,
  };
}

function runCli(): void {
  let parsed: ParsedEvalArgs;
  try {
    parsed = parseEvalArgs(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  runEval(parsed)
    .then((dir) => {
      console.log(`Eval complete. Results written to ${dir}`);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
