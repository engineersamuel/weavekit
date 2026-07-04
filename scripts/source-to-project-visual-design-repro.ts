#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createCopilotSdkHarnessClient,
  createSourceToProjectHarnessRegistry,
  type CopilotHarnessClient,
  type CopilotHarnessLogEvent,
} from "../src/macro-workflow/sourceToProject/harnesses.js";
import type { WorkflowExecutionContext } from "../src/macro-workflow/harness.js";
import { WorkflowHarnessKind, type RuntimeWorkflowNode, type WorkflowNodePayload } from "../src/macro-workflow/types.js";

const DEFAULT_FIXTURE_PATH = "tests/fixtures/source-to-project/visual-design-o3-replay.json";

export type VisualDesignReplayMode = "live" | "mock-hosted" | "mock-local-plan" | "mock-local-html" | "mock-no-url";

export type VisualDesignReplayFixture = {
  sourceRunId: string;
  sourceRunOutputDir: string;
  sourcePayloadFile: string;
  visualDesignNode: RuntimeWorkflowNode;
  payloads: Record<string, WorkflowNodePayload>;
};

export type VisualDesignReplayOptions = {
  fixturePath?: string;
  mode?: VisualDesignReplayMode;
  cwd?: string;
  outputDir?: string;
  checkInstall?: boolean;
  timeoutMs?: number;
  bridgeTtlMs?: number;
  trace?: boolean;
  traceEvents?: boolean;
  onTrace?: (message: string) => void;
};

export async function loadVisualDesignReplayFixture(path = DEFAULT_FIXTURE_PATH): Promise<VisualDesignReplayFixture> {
  const raw = await readFile(resolve(path), "utf8");
  const parsed = JSON.parse(raw) as VisualDesignReplayFixture;
  if (!parsed.visualDesignNode?.id?.startsWith("visual-design-opportunity-")) {
    throw new Error(`Invalid visual-design replay fixture ${path}: missing visualDesignNode.`);
  }
  if (!parsed.payloads?.[parsed.visualDesignNode.dependsOn[0] ?? ""]) {
    throw new Error(`Invalid visual-design replay fixture ${path}: missing report dependency payload.`);
  }
  return parsed;
}

export function payloadMapForVisualDesignReplay(
  fixture: VisualDesignReplayFixture,
  options: { checkInstall?: boolean } = {},
): Map<string, WorkflowNodePayload> {
  const entries = Object.entries(fixture.payloads)
    .filter(([nodeId]) => !options.checkInstall || nodeId !== "visual-plan-preflight");
  return new Map(entries);
}

export async function runVisualDesignReplay(options: VisualDesignReplayOptions = {}) {
  const startedAt = Date.now();
  const trace = createReplayTrace(options, startedAt);
  trace(`start mode=${options.mode ?? "live"} fixture=${options.fixturePath ?? DEFAULT_FIXTURE_PATH}`);
  const fixture = await loadVisualDesignReplayFixture(options.fixturePath);
  trace(`fixture loaded run=${fixture.sourceRunId} node=${fixture.visualDesignNode.id}`);
  const cwd = resolve(options.cwd ?? process.cwd());
  const mode = options.mode ?? "live";
  const urlWatcher = options.trace ? startPlanUrlWatcher(cwd, startedAt, trace) : undefined;
  const copilot = createReplayCopilot(mode, {
    timeoutMs: options.timeoutMs,
    trace,
    traceEvents: options.traceEvents,
  });
  trace(`registry create cwd=${cwd}`);
  const registry = createSourceToProjectHarnessRegistry({
    source: `replay:${fixture.sourceRunId}/${fixture.sourcePayloadFile}`,
    project: {
      id: "visual-design-replay",
      displayName: "Visual Design Replay",
      workingTree: cwd,
      mainline: "origin main",
      remote: "origin",
      contextDocs: [],
      validationCommands: [],
      autonomousPrAllowed: false,
      notification: "cli",
      knowledgeExport: "off",
    },
    mode: "advisory",
    copilot,
    visualPlanBridgeCleanupTtlMs: options.bridgeTtlMs,
    ...(mode === "live" ? {} : {
      visualPlanBridgeCleanup(args) {
        const bridge = bridgeFromHostedArtifactUrl(args.hostedArtifactUrl);
        return bridge
          ? {
            status: "scheduled",
            bridgeUrl: bridge.bridgeUrl,
            port: bridge.port,
            cleanupAfterMs: args.cleanupAfterMs,
            cleanupCommand: `mock cleanup port ${bridge.port}`,
          }
          : undefined;
      },
    }),
    ...(options.checkInstall ? {} : { shell: {
      async run(command, args) {
        throw new Error(`Visual-design replay unexpectedly invoked installer command: ${[command, ...args].join(" ")}`);
      },
    } }),
  });
  const adapter = registry.get(WorkflowHarnessKind.COPILOT_SDK);
  if (!adapter) {
    throw new Error("No Copilot SDK harness registered for visual-design replay.");
  }

  const context: WorkflowExecutionContext = {
    payloads: payloadMapForVisualDesignReplay(fixture, { checkInstall: options.checkInstall }),
    artifacts: new Map(),
    objective: `Replay visual design for ${fixture.visualDesignNode.id}`,
    outputDir: options.outputDir,
  };
  try {
    trace(`adapter start node=${fixture.visualDesignNode.id}`);
    const result = await adapter(fixture.visualDesignNode, context);
    trace(`adapter complete status=${result.status}`);
    const hostedArtifactUrl = result.payload?.sourceToProjectVisualPlan
      && typeof result.payload.sourceToProjectVisualPlan === "object"
      && "hostedArtifactUrl" in result.payload.sourceToProjectVisualPlan
      ? String(result.payload.sourceToProjectVisualPlan.hostedArtifactUrl)
      : undefined;
    if (hostedArtifactUrl) {
      trace(`result url=${hostedArtifactUrl}`);
    }
    return result;
  } finally {
    urlWatcher?.stop();
    trace("finished");
  }
}

function createReplayCopilot(
  mode: VisualDesignReplayMode,
  options: {
    timeoutMs?: number;
    trace?: (message: string) => void;
    traceEvents?: boolean;
  } = {},
): CopilotHarnessClient {
  if (mode === "live") {
    return createCopilotSdkHarnessClient({
      timeoutMs: options.timeoutMs,
      verboseEvents: options.traceEvents,
      onLog(event) {
        options.trace?.(formatCopilotTraceEvent(event));
      },
    });
  }
  return {
    model: `fixture-${mode}`,
    async run(args) {
      if (mode === "mock-hosted") {
        return [
          `Mock visual-plan replay for ${args.operation}.`,
          "Published visual-plan MDX artifact: https://plan.agent-native.com/builder/replay-o3-readiness",
        ].join("\n");
      }
      if (mode === "mock-local-plan") {
        return [
          `Mock local visual-plan replay for ${args.operation}.`,
          "Created local Agent-Native plan:",
          "https://plan.agent-native.com/local-plans/replay-o3-readiness?bridge=http%3A%2F%2F127.0.0.1%3A57044%2Flocal-plan.json%3Ftoken%3Dfixture",
        ].join("\n");
      }
      if (mode === "mock-local-html") {
        return [
          "Created and opened the visual review artifact.",
          "File: `~/.copilot/session-state/replay/files/o3-visual-plan.html` (self-contained, no dependencies)",
        ].join("\n");
      }
      return "Created a visual artifact, but no hosted Agent-Native Plan URL was returned.";
    },
  };
}

function createReplayTrace(
  options: Pick<VisualDesignReplayOptions, "trace" | "onTrace">,
  startedAt: number,
): (message: string) => void {
  return (message) => {
    if (!options.trace) {
      return;
    }
    const line = `[repro +${formatElapsed(Date.now() - startedAt)}] ${message}`;
    if (options.onTrace) {
      options.onTrace(line);
    } else {
      process.stderr.write(`${line}\n`);
    }
  };
}

function formatCopilotTraceEvent(event: CopilotHarnessLogEvent): string {
  return [
    `copilot ${event.phase}`,
    event.mode ? `mode=${event.mode}` : undefined,
    event.model ? `model=${event.model}` : undefined,
    event.eventType ? `event=${event.eventType}` : undefined,
    event.skillName ? `skill=${event.skillName}` : undefined,
    event.toolName ? `tool=${event.toolName}` : undefined,
    event.toolCallCount !== undefined ? `toolCalls=${event.toolCallCount}` : undefined,
    event.maxToolCalls !== undefined ? `maxToolCalls=${event.maxToolCalls}` : undefined,
    event.promptLength !== undefined ? `promptChars=${event.promptLength}` : undefined,
    event.contentLength !== undefined ? `contentChars=${event.contentLength}` : undefined,
    event.timeoutMs !== undefined ? `timeoutMs=${event.timeoutMs}` : undefined,
    event.elapsedMs !== undefined ? `sdkElapsed=${formatElapsed(event.elapsedMs)}` : undefined,
    event.message ? `message=${JSON.stringify(event.message)}` : undefined,
  ].filter((part): part is string => Boolean(part)).join(" ");
}

function startPlanUrlWatcher(
  cwd: string,
  startedAt: number,
  trace: (message: string) => void,
): { stop(): void } {
  const seen = new Map<string, string>();
  let stopped = false;
  const scan = async () => {
    if (stopped) {
      return;
    }
    for (const file of await readPlanUrlFiles(cwd)) {
      if (file.mtimeMs < startedAt - 1000 || seen.get(file.path) === file.url) {
        continue;
      }
      seen.set(file.path, file.url);
      trace(`plan-url detected path=${file.path} url=${file.url}`);
    }
  };
  void scan();
  const interval = setInterval(() => {
    void scan();
  }, 1000);
  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}

async function readPlanUrlFiles(cwd: string): Promise<Array<{ path: string; mtimeMs: number; url: string }>> {
  const plansDir = join(cwd, "plans");
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(plansDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: Array<{ path: string; mtimeMs: number; url: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(plansDir, entry.name, ".plan-url");
    try {
      const [stats, raw] = await Promise.all([stat(path), readFile(path, "utf8")]);
      const url = raw.trim();
      if (url) {
        files.push({ path, mtimeMs: stats.mtimeMs, url });
      }
    } catch {
      // The plan may still be in progress and not have a URL file yet.
    }
  }
  return files;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function parseArgs(argv: string[]): VisualDesignReplayOptions {
  const options: VisualDesignReplayOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fixture") {
      options.fixturePath = readArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--mode") {
      const value = readArgValue(argv, index, arg);
      if (!isVisualDesignReplayMode(value)) {
        throw new Error("Invalid --mode. Expected live, mock-hosted, mock-local-plan, mock-local-html, or mock-no-url.");
      }
      options.mode = value;
      index += 1;
    } else if (arg === "--cwd") {
      options.cwd = readArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--output") {
      options.outputDir = readArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--timeout-ms") {
      const value = Number(readArgValue(argv, index, arg));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("Invalid --timeout-ms. Expected a positive integer.");
      }
      options.timeoutMs = value;
      index += 1;
    } else if (arg === "--bridge-ttl-ms") {
      const value = Number(readArgValue(argv, index, arg));
      if (!Number.isInteger(value) || value < 0) {
        throw new Error("Invalid --bridge-ttl-ms. Expected a non-negative integer.");
      }
      options.bridgeTtlMs = value;
      index += 1;
    } else if (arg === "--check-install") {
      options.checkInstall = true;
    } else if (arg === "--trace") {
      options.trace = true;
    } else if (arg === "--trace-events") {
      options.trace = true;
      options.traceEvents = true;
    } else {
      throw new Error([
        `Unknown argument: ${arg ?? ""}`,
        "Usage: nub scripts/source-to-project-visual-design-repro.ts [--fixture <path>] [--mode live|mock-hosted|mock-local-plan|mock-local-html|mock-no-url] [--cwd <path>] [--timeout-ms <ms>] [--bridge-ttl-ms <ms>] [--trace] [--trace-events]",
      ].join("\n"));
    }
  }
  return options;
}

function readArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function isVisualDesignReplayMode(value: string): value is VisualDesignReplayMode {
  return value === "live" || value === "mock-hosted" || value === "mock-local-plan" || value === "mock-local-html" || value === "mock-no-url";
}

function bridgeFromHostedArtifactUrl(hostedArtifactUrl: string): { bridgeUrl: string; port: number } | undefined {
  try {
    const hosted = new URL(hostedArtifactUrl);
    const bridgeParam = hosted.searchParams.get("bridge");
    if (!bridgeParam) {
      return undefined;
    }
    const bridge = new URL(bridgeParam);
    const port = Number(bridge.port);
    if (!Number.isInteger(port)) {
      return undefined;
    }
    return { bridgeUrl: bridge.toString(), port };
  } catch {
    return undefined;
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  runVisualDesignReplay(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
