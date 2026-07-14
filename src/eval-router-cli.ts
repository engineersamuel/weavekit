import { pathToFileURL } from "node:url";
import { runRouterEval } from "./eval/routerRunner.js";

function parseCliArgs(argv: string[]): {
  corpusDir?: string;
  resultsDir?: string;
  maxConcurrency?: number;
} {
  const options: { corpusDir?: string; resultsDir?: string; maxConcurrency?: number } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--corpus-dir") {
      options.corpusDir = argv[index + 1];
      index += 1;
    } else if (arg === "--results-dir") {
      options.resultsDir = argv[index + 1];
      index += 1;
    } else if (arg === "--max-concurrency") {
      options.maxConcurrency = Number(argv[index + 1]);
      index += 1;
    }
  }
  return options;
}

function runCli(): void {
  runRouterEval(parseCliArgs(process.argv.slice(2)))
    .then((dir) => {
      console.log(`Router eval complete. Results written to ${dir}`);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
