import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MastermindRlmExecutionDefaults } from "../config.js";
import { buildLangfuseTraceUrl } from "../mastermind/telemetry.js";
import {
  ExecutorKind,
  type DirectExecutionRequest,
  type DirectExecutionResult,
  type DirectExecutor,
  type ExecutorHandle,
  type ExecutorStatus,
  type SubmindTraceReference,
} from "./contracts.js";
import { buildDirectExecutionPrompt } from "./herdr.js";
import {
  LocalExecutionCommandRunner,
  runExecutionPreflight,
  type ExecutionCommandRunner,
  type ExecutionPreflightReport,
} from "./preflight.js";
import { readAndValidateResultManifest } from "./resultManifest.js";

const DEFAULT_RLM_SCRIPT_PATH = fileURLToPath(new URL("../../scripts/rlm-poc.ts", import.meta.url));

const PROMPT_FILE_NAME = "mastermind-rlm-prompt.txt";
const LOG_FILE_NAME = "mastermind-rlm.log";
const OUTPUT_JSON_FILE_NAME = "mastermind-rlm-output.json";
const WEAVEKIT_DIR_NAME = ".weavekit";

/**
 * Raw payload written by `scripts/rlm-poc.ts --output-json` the instant `runRlmSubmind()`
 * resolves (success or failure). This is Submind's literal final output, captured to disk so this
 * out-of-process executor can read it back after the detached process exits (or crashes and is
 * restarted, per ADR 0009).
 */
type RlmOutputPayload =
  | {
      ok: true;
      result: { finalText: string; conversationId?: string; traceId: string };
      observedAt: string;
    }
  | { ok: false; error: string; observedAt: string };

/** Spawns and tracks the detached `rlm-poc` child process. Swappable for tests. */
export type RlmProcessLauncher = {
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; logPath: string },
  ): { pid: number };
  /** Returns whether the process identified by `pid` is still alive. */
  isAlive(pid: number): boolean;
  /** Sends `signal` to the process identified by `pid`; a no-op if it is already gone. */
  kill(pid: number, signal: NodeJS.Signals): void;
};

export class DefaultRlmProcessLauncher implements RlmProcessLauncher {
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; logPath: string },
  ): { pid: number } {
    const logFd = openSync(options.logPath, "a");
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    if (!child.pid) {
      throw new Error("Failed to spawn the detached rlm-poc process.");
    }
    return { pid: child.pid };
  }

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  kill(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited; nothing to do.
    }
  }
}

/**
 * Delegates `MastermindAction.DELEGATE_SUBMIND` work to the RLM ("Submind") recursive Copilot SDK
 * meta-harness (`src/rlm-poc/runtime.ts`) instead of a Herdr-managed `copilot` CLI pane.
 *
 * `runRlmSubmind()` itself is a plain async function call, not an external pane - but this
 * executor still spawns it as a **detached** child process (`scripts/rlm-poc.ts`) so Mastermind's
 * coordinator can `start()`, disconnect, restart, and `collect()` later, matching the
 * `start`/`status`/`collect`/`cancel` contract it already implements for
 * {@link HerdrDirectExecutor}, per ADR 0009's durable-control-plane design.
 *
 * `collect()` prefers the shared `.weavekit/mastermind-result.json` manifest contract (identical
 * to the Herdr path) as the real completion signal. If the delegated implementation session never
 * wrote one, it falls back to the always-captured `.weavekit/mastermind-rlm-output.json` -
 * Submind's literal final answer - and routes the attempt to `needs-human` rather than guessing at
 * a structured outcome from freeform text.
 */
export class RlmDirectExecutor implements DirectExecutor {
  constructor(
    private readonly config: MastermindRlmExecutionDefaults,
    private readonly launcher: RlmProcessLauncher = new DefaultRlmProcessLauncher(),
    private readonly commandRunner: ExecutionCommandRunner = new LocalExecutionCommandRunner(),
    private readonly scriptPath: string = DEFAULT_RLM_SCRIPT_PATH,
    private readonly nodeCommand: string = process.execPath,
  ) {}

  preflight(request: DirectExecutionRequest): Promise<ExecutionPreflightReport> {
    return runExecutionPreflight({
      requirements: request.preflightRequirements,
      workspacePath: request.workspace.checkoutPath,
      runner: this.commandRunner,
    });
  }

  async start(
    request: DirectExecutionRequest,
    _approval: Parameters<DirectExecutor["start"]>[1],
  ): Promise<ExecutorHandle> {
    const worktreePath = request.workspace.checkoutPath;
    const weavekitDir = join(worktreePath, WEAVEKIT_DIR_NAME);
    await mkdir(weavekitDir, { recursive: true });

    const promptPath = join(weavekitDir, PROMPT_FILE_NAME);
    const logPath = join(weavekitDir, LOG_FILE_NAME);
    const outputJsonPath = join(weavekitDir, OUTPUT_JSON_FILE_NAME);
    await Promise.all([
      rm(join(worktreePath, request.resultManifestPath), { force: true }),
      rm(outputJsonPath, { force: true }),
      rm(join(weavekitDir, "mastermind-attempt.json"), { force: true }),
    ]);
    await writeFile(logPath, "", "utf8");
    await writeFile(promptPath, buildRlmDirectExecutionPrompt(request), "utf8");

    const args = [
      this.scriptPath,
      "--prompt-file",
      promptPath,
      "--cwd",
      worktreePath,
      "--output-json",
      outputJsonPath,
      "--max-depth",
      String(this.config.maxDepth),
      "--max-total-calls",
      String(this.config.maxTotalCalls),
      ...(this.config.model ? ["--model", this.config.model] : []),
      ...(this.config.enableTrellage ? ["--trellage"] : []),
    ];
    const { pid } = this.launcher.spawn(this.nodeCommand, args, { cwd: worktreePath, logPath });

    return {
      executor: ExecutorKind.RLM_SUBMIND,
      worktreePath,
      pid,
      logPath,
    };
  }

  async status(handle: ExecutorHandle): Promise<ExecutorStatus> {
    const observedAt = new Date().toISOString();
    const outputJsonPath = join(handle.worktreePath, WEAVEKIT_DIR_NAME, OUTPUT_JSON_FILE_NAME);
    const outputPayload = await readOutputPayload(outputJsonPath);
    if (outputPayload) {
      return outputPayload.ok
        ? { state: "done", observedAt }
        : { state: "blocked", observedAt, detail: sanitizeDetail(outputPayload.error) };
    }
    if (handle.pid === undefined) {
      return { state: "unknown", observedAt, detail: "Execution handle has no tracked process." };
    }
    if (this.launcher.isAlive(handle.pid)) {
      return { state: "working", observedAt };
    }
    return {
      state: "unknown",
      observedAt,
      detail: "Detached rlm-poc process exited without writing an output JSON file.",
    };
  }

  async cancel(handle: ExecutorHandle): Promise<{ confirmed: boolean; status: ExecutorStatus }> {
    if (handle.pid !== undefined) {
      this.launcher.kill(handle.pid, "SIGTERM");
      await waitFor(this.config.cancellationGraceMs, () => !this.launcher.isAlive(handle.pid!));
      if (this.launcher.isAlive(handle.pid)) {
        this.launcher.kill(handle.pid, "SIGKILL");
      }
    }
    const status = await this.status(handle);
    const confirmed = handle.pid === undefined || !this.launcher.isAlive(handle.pid);
    return { confirmed, status };
  }

  async collect(
    handle: ExecutorHandle,
    request: DirectExecutionRequest,
  ): Promise<DirectExecutionResult> {
    const outputJsonPath = join(handle.worktreePath, WEAVEKIT_DIR_NAME, OUTPUT_JSON_FILE_NAME);
    const outputPayload = await readOutputPayload(outputJsonPath);
    const submindTrace =
      outputPayload?.ok === true ? buildSubmindTraceReference(outputPayload.result) : undefined;
    try {
      const manifestResult = await readAndValidateResultManifest(handle.worktreePath);
      return submindTrace ? { ...manifestResult, submindTrace } : manifestResult;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (!outputPayload) {
      throw new Error(
        "RLM execution has neither a result manifest nor a captured Submind output yet.",
      );
    }
    return buildNeedsHumanResult(request, outputPayload, submindTrace);
  }
}

function buildSubmindTraceReference(result: {
  conversationId?: string;
  traceId: string;
}): SubmindTraceReference {
  const url = buildLangfuseTraceUrl(result.traceId);
  return {
    traceId: result.traceId,
    ...(result.conversationId ? { conversationId: result.conversationId } : {}),
    ...(url ? { url } : {}),
  };
}

/** Passes the reviewed implementation contract to the same routing path used by `mise run rlm`. */
function buildRlmDirectExecutionPrompt(request: DirectExecutionRequest): string {
  return buildDirectExecutionPrompt(request);
}

function buildNeedsHumanResult(
  request: DirectExecutionRequest,
  payload: RlmOutputPayload,
  submindTrace: SubmindTraceReference | undefined,
): DirectExecutionResult {
  const summary = payload.ok
    ? `Submind completed without writing a result manifest. Captured final answer: ${truncate(payload.result.finalText, 800)}`
    : `Submind run failed before producing a result manifest: ${truncate(payload.error, 800)}`;
  return {
    schemaVersion: 1,
    workId: request.workId,
    attemptId: request.attemptId,
    attemptNumber: request.attemptNumber,
    outcome: "needs-human",
    summary,
    artifactPaths: [],
    verification: [],
    knownRisks: [
      "The delegated RLM implementation session did not honor the .weavekit/mastermind-result.json manifest contract.",
    ],
    remainingWork: [
      "Review the captured Submind output and worktree state, then decide whether to accept, retry, or manually finish this work.",
    ],
    ...(submindTrace ? { submindTrace } : {}),
  };
}

async function readOutputPayload(path: string): Promise<RlmOutputPayload | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RlmOutputPayload;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function waitFor(timeoutMs: number, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function sanitizeDetail(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 500);
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}
