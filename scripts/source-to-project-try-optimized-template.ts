import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

type TryOptimizedTemplateArgs = {
  runId: string;
  candidateId?: string;
  runsRoot: string;
  outputDir: string;
  project: string;
  mode: "advisory" | "autonomous-pr";
  dashboardUrl?: string;
  dashboardPort?: string;
  prompt: string;
};

const DEFAULT_RUNS_ROOT = "evals/template-optimizer/runs";

export function parseTryOptimizedTemplateArgs(argv: string[]): TryOptimizedTemplateArgs {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex === -1) {
    throw new Error(usage("Missing -- before the source-to-project prompt."));
  }
  const head = argv.slice(0, separatorIndex);
  const prompt = argv
    .slice(separatorIndex + 1)
    .join(" ")
    .trim();
  const runId = head.shift();
  if (!runId) {
    throw new Error(usage("Missing optimizer run id."));
  }
  if (!prompt) {
    throw new Error(usage("Missing source-to-project prompt after --."));
  }

  const parsed: TryOptimizedTemplateArgs = {
    runId,
    runsRoot: DEFAULT_RUNS_ROOT,
    outputDir: "runs",
    project: "weavekit",
    mode: "advisory",
    prompt,
  };

  for (let index = 0; index < head.length; index += 1) {
    const arg = head[index]!;
    if (arg === "--candidate") {
      parsed.candidateId = readNext(head, ++index, arg);
      continue;
    }
    if (arg === "--runs-root") {
      parsed.runsRoot = readNext(head, ++index, arg);
      continue;
    }
    if (arg === "--output") {
      parsed.outputDir = readNext(head, ++index, arg);
      continue;
    }
    if (arg === "--project") {
      parsed.project = readNext(head, ++index, arg);
      continue;
    }
    if (arg === "--mode") {
      parsed.mode = readMode(readNext(head, ++index, arg));
      continue;
    }
    if (arg === "--dashboard-url") {
      parsed.dashboardUrl = readNext(head, ++index, arg);
      continue;
    }
    if (arg === "--dashboard-port") {
      parsed.dashboardPort = readNext(head, ++index, arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

export function buildTryOptimizedTemplateWorkflowArgs(args: TryOptimizedTemplateArgs): string[] {
  const workflowArgs = [
    "src/cli.ts",
    "workflow",
    "run",
    "--template",
    "source-to-project",
    "--template-candidate-run",
    args.runId,
    "--template-candidate-runs-root",
    args.runsRoot,
    "--prompt",
    args.prompt,
    "--project",
    args.project,
    "--mode",
    args.mode,
    "--output",
    args.outputDir,
  ];
  if (args.candidateId) {
    workflowArgs.push("--template-candidate", args.candidateId);
  }
  if (args.dashboardUrl) {
    workflowArgs.push("--dashboard-url", args.dashboardUrl);
  } else if (args.dashboardPort) {
    workflowArgs.push("--dashboard-port", args.dashboardPort);
  } else {
    workflowArgs.push("--dashboard-port", "4323");
  }
  return workflowArgs;
}

export async function runTryOptimizedTemplate(
  args: TryOptimizedTemplateArgs,
): Promise<number | null> {
  const child = spawn("nub", buildTryOptimizedTemplateWorkflowArgs(args), {
    stdio: "inherit",
    env: process.env,
  });
  return await new Promise((resolve) => {
    child.on("close", resolve);
  });
}

function readNext(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function readMode(value: string): TryOptimizedTemplateArgs["mode"] {
  if (value !== "advisory" && value !== "autonomous-pr") {
    throw new Error("Invalid --mode value. Expected advisory or autonomous-pr.");
  }
  return value;
}

function usage(message: string): string {
  return `${message}\nUsage: nub scripts/source-to-project-try-optimized-template.ts <optimizer-run-id> [--candidate <candidate-id>] [--dashboard-port <port>|--dashboard-url <url>] -- <prompt>`;
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  runTryOptimizedTemplate(parseTryOptimizedTemplateArgs(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code ?? 1;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
