import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { createDefaultController } from "../src/submind-poc/runtime.js";
import { runHelper } from "../src/submind-poc/helper.js";
import { buildSubmindRunFooter } from "../src/submind-poc/output.js";
import { SubmindStore } from "../src/submind-poc/store.js";
import { shutdownTelemetry } from "../src/submind-poc/telemetry.js";
import { loadTelemetryEnvironment, startTelemetry } from "../src/telemetry/bootstrap.js";

const execFileAsync = promisify(execFile);
const tracer = trace.getTracer("weavekit");

async function main(traceId?: string): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const controlRoot = option(args, "--control-root") ?? (await defaultControlRoot());
  if (command === "helper") {
    const runId = requiredOption(args, "--run");
    const operation = requiredOption(args, "--operation");
    const rawInput = option(args, "--input") ?? "{}";
    const result = await runHelper({
      controlRoot,
      runId,
      operation,
      payload: JSON.parse(rawInput),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const controller = await createDefaultController(controlRoot);
  switch (command) {
    case "start": {
      const state = await controller.start(
        requiredOption(args, "--cwd"),
        args.includes("--detach"),
      );
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
      if (state.state === "completed" || state.state === "failed") {
        await printTranscript(controlRoot, state.runId);
      }
      printRunFooter(state, traceId);
      process.exitCode = state.state === "failed" ? 1 : 0;
      break;
    }
    case "status": {
      const state = await controller.status(requiredOption(args, "--run"));
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
      printRunFooter(state, traceId);
      process.exitCode = state.state === "failed" ? 1 : 0;
      break;
    }
    case "wait": {
      const runId = requiredOption(args, "--run");
      const state = await controller.wait(runId);
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
      await printTranscript(controlRoot, runId);
      printRunFooter(state, traceId);
      process.exitCode = state.state === "failed" ? 1 : 0;
      break;
    }
    default:
      throw new Error(
        "Usage: nub scripts/submind-poc.ts start --cwd <repo> [--detach] | status --run <id> | wait --run <id>",
      );
  }
}

function printRunFooter(state: Awaited<ReturnType<SubmindStore["readState"]>>, traceId?: string) {
  if (!traceId) {
    throw new Error("Submind CLI trace ID is unavailable.");
  }
  process.stdout.write(buildSubmindRunFooter(state, traceId));
}

async function printTranscript(controlRoot: string, runId: string): Promise<void> {
  const store = new SubmindStore(join(controlRoot, ".weavekit", "submind-poc", runId));
  const events = await store.readEvents();
  process.stdout.write("\nTranscript receipts:\n");
  for (const event of events) {
    process.stdout.write(
      `${event.sequence}. ${event.timestamp} ${event.type} ${JSON.stringify(event.data)}\n`,
    );
  }
  try {
    const manifest = await store.readManifest();
    process.stdout.write(
      `\nInspection: workspace=${manifest.workspaceId} orchestrator=${manifest.orchestrator.agentId} pane=${manifest.orchestrator.paneId}\n`,
    );
    for (const worker of manifest.workers) {
      process.stdout.write(
        `${worker.kind}: ${worker.question} Answer: ${worker.answer} Acknowledgement: ${worker.acknowledgement} [agent=${worker.agentId} pane=${worker.paneId}]\n`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`Required option missing: ${name}`);
  return value;
}

async function defaultControlRoot(): Promise<string> {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: scriptDirectory,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

loadTelemetryEnvironment(homedir());
const telemetry = await startTelemetry("weavekit-submind-poc");
try {
  if (process.argv[2] === "helper") {
    await main();
  } else {
    await tracer.startActiveSpan("submind.cli", async (span) => {
      try {
        await main(span.spanContext().traceId);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        const exception = error instanceof Error ? error : new Error(String(error));
        span.recordException(exception);
        span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
        throw exception;
      } finally {
        span.end();
      }
    });
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await shutdownTelemetry(telemetry);
}
