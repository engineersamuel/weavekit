import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createTemplateOptimizerDashboardServer } from "../src/macro-workflow/templateOptimizer/dashboardServer.js";

type SourceToProjectTemplateOptimizerUiArgs = {
  port: number;
  runsRoot: string;
  open: boolean;
};

const DEFAULT_PORT = 4322;
const DEFAULT_RUNS_ROOT = "evals/template-optimizer/runs";

export function parseSourceToProjectTemplateOptimizerUiArgs(
  argv: string[],
): SourceToProjectTemplateOptimizerUiArgs {
  const parsed: SourceToProjectTemplateOptimizerUiArgs = {
    port: DEFAULT_PORT,
    runsRoot: DEFAULT_RUNS_ROOT,
    open: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--port") {
      parsed.port = readPort(readNext(argv, ++index, arg));
      continue;
    }
    if (arg === "--runs-root") {
      parsed.runsRoot = readNext(argv, ++index, arg);
      continue;
    }
    if (arg === "--open") {
      parsed.open = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

export async function runSourceToProjectTemplateOptimizerUi(
  args: SourceToProjectTemplateOptimizerUiArgs,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = await createTemplateOptimizerDashboardServer({
    port: args.port,
    runsRoot: args.runsRoot,
    templateId: "source-to-project",
  });

  if (args.open && process.platform === "darwin") {
    const { execFile } = await import("node:child_process");
    execFile("open", [server.url]);
  }

  return {
    url: server.url,
    stop: server.stop,
  };
}

async function main() {
  try {
    const args = parseSourceToProjectTemplateOptimizerUiArgs(process.argv.slice(2));
    const server = await runSourceToProjectTemplateOptimizerUi(args);
    console.log(`[weavekit] Source-to-project template optimizer UI: ${server.url}`);
    console.log(`[weavekit] Watching optimizer runs in: ${args.runsRoot}`);
    console.log("[weavekit] Press Ctrl+C to stop.");
    await waitForever();
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

function readNext(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function readPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid --port value. Expected an integer between 1 and 65535.");
  }
  return port;
}

async function waitForever(): Promise<never> {
  for (;;) {
    await delay(2_147_483_647);
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  void main();
}
