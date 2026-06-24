import { readFile } from "node:fs/promises";
import { runCouncil } from "./council/runner.js";
import type { CouncilInput } from "./council/types.js";

export type CouncilCliArgs = {
  inputPath: string;
  outputDir: string;
};

export function parseCouncilCliArgs(argv: string[]): CouncilCliArgs {
  if (argv[0] !== "council" || argv[1] !== "run") {
    throw new Error("Usage: weavekit council run --input <path> [--output <dir>]");
  }

  const inputIndex = argv.indexOf("--input");
  if (inputIndex === -1 || !argv[inputIndex + 1]) {
    throw new Error("Missing required --input <path> argument.");
  }

  const outputIndex = argv.indexOf("--output");

  return {
    inputPath: argv[inputIndex + 1]!,
    outputDir: outputIndex === -1 ? "runs/latest" : argv[outputIndex + 1] ?? "runs/latest",
  };
}

export async function readCouncilInputFile(inputPath: string): Promise<CouncilInput> {
  const prompt = await readFile(inputPath, "utf8");
  return { prompt, context: [], constraints: [] };
}

async function main(): Promise<void> {
  const args = parseCouncilCliArgs(process.argv.slice(2));
  const input = await readCouncilInputFile(args.inputPath);
  const report = await runCouncil(input, { outputDir: args.outputDir });

  process.stdout.write(`${report.recommendation}\n`);
  process.stdout.write(`Artifacts written to ${args.outputDir}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
