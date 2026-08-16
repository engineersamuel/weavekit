import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { MastermindExecutionDefaults } from "../config.js";
import {
  ExecutorKind,
  type DirectExecutionRequest,
  type DirectExecutionResult,
  type DirectExecutor,
  type ExecutorHandle,
  type ExecutorStatus,
} from "./contracts.js";
import { findHerdrString, findWorkspaceRootPaneId, parseHerdrEnvelope } from "./herdrJson.js";
import {
  LocalExecutionCommandRunner,
  runExecutionPreflight,
  type ExecutionCommandRunner,
  type ExecutionPreflightReport,
} from "./preflight.js";
import { readAndValidateResultManifest } from "./resultManifest.js";
import type { WorkspaceShell } from "./workspace.js";

const execFileAsync = promisify(execFile);
const PANE_READY_RETRY_COUNT = 20;
const PANE_READY_RETRY_DELAY_MS = 250;

export class HerdrDirectExecutor implements DirectExecutor {
  constructor(
    private readonly config: MastermindExecutionDefaults,
    private readonly shell: WorkspaceShell = { run: runCommand },
    private readonly commandRunner: ExecutionCommandRunner = new LocalExecutionCommandRunner(),
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
    const agentName = directExecutionAgentName(request.workId, request.attemptNumber);
    const live = await this.resolveLiveWorktree(request.workspace.checkoutPath);
    const handle: ExecutorHandle = {
      executor: ExecutorKind.HERDR_COPILOT,
      agentName,
      worktreePath: request.workspace.checkoutPath,
      lastObservedWorkspaceId: live.workspaceId,
      lastObservedTabId: live.tabId,
      lastObservedPaneId: live.rootPaneId,
    };
    const existing = await this.tryGetAgent(agentName, request.workspace.checkoutPath);
    if (!existing) {
      await this.startAgentWhenPaneReady(request.workspace.checkoutPath, agentName, handle);
      await this.submitPrompt(request, agentName);
    } else {
      handle.agentSessionId = existing.sessionId;
      handle.lastObservedWorkspaceId = existing.workspaceId;
      handle.lastObservedTabId = existing.tabId;
      handle.lastObservedPaneId = existing.paneId;
      const markerExists = await hasMatchingDispatchEvidence(request);
      if (
        !markerExists &&
        existing.state !== "working" &&
        existing.state !== "blocked" &&
        existing.state !== "done"
      ) {
        throw new Error(
          "Existing idle agent has no attempt marker; prompt dispatch is ambiguous and will not be repeated.",
        );
      }
    }
    return handle;
  }

  private async startAgentWhenPaneReady(
    checkoutPath: string,
    agentName: string,
    handle: ExecutorHandle,
  ): Promise<void> {
    let paneId = handle.lastObservedPaneId;
    if (!paneId) {
      throw new Error("Herdr execution workspace has no root pane.");
    }
    const harnessCommand = this.config.harnessCommand ?? this.config.harnessKind;
    const harnessArgs = this.config.harnessArgs ?? [];
    if (harnessCommand !== this.config.harnessKind) {
      await this.startCustomCommandAgent(checkoutPath, agentName, paneId, harnessArgs);
      return;
    }
    for (let attempt = 1; attempt <= PANE_READY_RETRY_COUNT; attempt += 1) {
      try {
        await this.shell.run(
          "herdr",
          [
            "agent",
            "start",
            agentName,
            "--kind",
            this.config.harnessKind,
            "--pane",
            paneId,
            "--",
            ...harnessArgs,
            ...copilotAutopilotArgs(this.config),
          ],
          { cwd: checkoutPath },
        );
        return;
      } catch (error) {
        if (!isAgentPaneBusy(error) || attempt === PANE_READY_RETRY_COUNT) {
          throw error;
        }
        await delay(PANE_READY_RETRY_DELAY_MS);
        const live = await this.resolveLiveWorktree(checkoutPath);
        handle.lastObservedWorkspaceId = live.workspaceId;
        handle.lastObservedTabId = live.tabId;
        handle.lastObservedPaneId = live.rootPaneId;
        paneId = live.rootPaneId;
      }
    }
  }

  private async startCustomCommandAgent(
    checkoutPath: string,
    agentName: string,
    paneId: string,
    args: string[],
  ): Promise<void> {
    const command = [this.config.harnessCommand!, ...args].map(shellQuote).join(" ");
    await this.shell.run("herdr", ["pane", "run", paneId, command], { cwd: checkoutPath });
    for (let attempt = 1; attempt <= PANE_READY_RETRY_COUNT; attempt += 1) {
      try {
        const result = parseHerdrEnvelope(
          await this.shell.run("herdr", ["agent", "get", paneId], { cwd: checkoutPath }),
          "herdr agent get",
        );
        if (findHerdrString(result, "agent_status", "status", "kind")) {
          await this.shell.run("herdr", ["agent", "rename", paneId, agentName], {
            cwd: checkoutPath,
          });
          return;
        }
      } catch (error) {
        if (attempt === PANE_READY_RETRY_COUNT) throw error;
      }
      await delay(PANE_READY_RETRY_DELAY_MS);
    }
    throw new Error(`Custom Herdr agent command was not detected for ${agentName}.`);
  }

  async status(handle: ExecutorHandle): Promise<ExecutorStatus> {
    try {
      const result = parseHerdrEnvelope(
        await this.shell.run("herdr", ["agent", "get", requireAgentName(handle)], {
          cwd: handle.worktreePath,
        }),
        "herdr agent get",
      );
      const state = normalizeHerdrState(findHerdrString(result, "agent_status", "status"));
      return {
        state,
        observedAt: new Date().toISOString(),
        ...(state === "blocked" || state === "unknown"
          ? { detail: await this.readDiagnostic(handle) }
          : {}),
      };
    } catch (error) {
      return {
        state: "unknown",
        observedAt: new Date().toISOString(),
        detail: sanitizeDetail(error),
      };
    }
  }

  async cancel(handle: ExecutorHandle): Promise<{ confirmed: boolean; status: ExecutorStatus }> {
    const agentName = requireAgentName(handle);
    await this.shell.run("herdr", ["agent", "send-keys", agentName, "ctrl-c"], {
      cwd: handle.worktreePath,
    });
    try {
      await this.shell.run(
        "herdr",
        [
          "agent",
          "wait",
          agentName,
          "--until",
          "idle",
          "--until",
          "done",
          "--timeout",
          String(this.config.cancellationGraceMs),
        ],
        { cwd: handle.worktreePath },
      );
    } catch {
      return { confirmed: false, status: await this.status(handle) };
    }
    const status = await this.status(handle);
    return { confirmed: status.state === "idle" || status.state === "done", status };
  }

  async collect(
    handle: ExecutorHandle,
    _request: DirectExecutionRequest,
  ): Promise<DirectExecutionResult> {
    return readAndValidateResultManifest(handle.worktreePath);
  }

  private async resolveLiveWorktree(
    checkoutPath: string,
  ): Promise<{ workspaceId: string; tabId?: string; rootPaneId: string }> {
    const canonicalCheckout = await realpath(checkoutPath);
    const result = parseHerdrEnvelope(
      await this.shell.run("herdr", ["workspace", "list"], { cwd: checkoutPath }),
      "herdr workspace list",
    );
    let match: unknown;
    for (const item of Array.isArray(result.workspaces) ? result.workspaces : []) {
      const record = asRecord(item);
      const worktree = asRecord(record.worktree);
      if (
        typeof worktree.checkout_path === "string" &&
        (await realpath(worktree.checkout_path)) === canonicalCheckout
      ) {
        match = item;
        break;
      }
    }
    const workspaceId = findHerdrString(match, "workspace_id");
    if (!workspaceId) {
      throw new Error("Herdr has no live workspace for the execution worktree.");
    }
    const workspace = parseHerdrEnvelope(
      await this.shell.run("herdr", ["workspace", "get", workspaceId], { cwd: checkoutPath }),
      "herdr workspace get",
    );
    const tabId = findHerdrString(workspace, "active_tab_id", "tab_id");
    let rootPaneId = findHerdrString(workspace, "root_pane_id", "pane_id");
    if (!rootPaneId) {
      const panes = parseHerdrEnvelope(
        await this.shell.run("herdr", ["pane", "list"], { cwd: checkoutPath }),
        "herdr pane list",
      );
      rootPaneId = findWorkspaceRootPaneId(panes, workspaceId, tabId);
    }
    if (!rootPaneId) {
      throw new Error("Herdr execution workspace has no root pane.");
    }
    return {
      workspaceId,
      tabId,
      rootPaneId,
    };
  }

  private async tryGetAgent(
    agentName: string,
    checkoutPath: string,
  ): Promise<
    | {
        state: ExecutorStatus["state"];
        paneId?: string;
        tabId?: string;
        workspaceId?: string;
        sessionId?: string;
      }
    | undefined
  > {
    try {
      const result = parseHerdrEnvelope(
        await this.shell.run("herdr", ["agent", "get", agentName], { cwd: checkoutPath }),
        "herdr agent get",
      );
      const cwd = findHerdrString(result, "cwd");
      if (!cwd || (await realpath(cwd)) !== (await realpath(checkoutPath))) {
        throw new Error(`Herdr agent name collision for ${agentName}.`);
      }
      return {
        state: normalizeHerdrState(findHerdrString(result, "agent_status", "status")),
        paneId: findHerdrString(result, "pane_id"),
        tabId: findHerdrString(result, "tab_id"),
        workspaceId: findHerdrString(result, "workspace_id"),
        sessionId: findHerdrString(result, "terminal_id"),
      };
    } catch (error) {
      if (/\b(?:not found|unknown agent|no agent)\b/iu.test(String(error))) {
        return undefined;
      }
      throw error;
    }
  }

  private async submitPrompt(request: DirectExecutionRequest, agentName: string): Promise<void> {
    await this.shell.run(
      "herdr",
      [
        "agent",
        "prompt",
        agentName,
        buildDirectExecutionPrompt(request),
        "--wait",
        "--until",
        "working",
        "--until",
        "blocked",
        "--until",
        "done",
        "--timeout",
        String(this.config.promptAcceptanceTimeoutMs),
      ],
      { cwd: request.workspace.checkoutPath },
    );
  }

  private async readDiagnostic(handle: ExecutorHandle): Promise<string | undefined> {
    try {
      const output = await this.shell.run(
        "herdr",
        [
          "agent",
          "read",
          requireAgentName(handle),
          "--source",
          "recent-unwrapped",
          "--lines",
          "20",
        ],
        { cwd: handle.worktreePath },
      );
      return output.replace(/\s+/gu, " ").trim().slice(0, 500) || undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * `ExecutorHandle.agentName` is optional because {@link ExecutorKind.RLM_SUBMIND} has no Herdr
 * agent. This executor always names one, so an absent name means the handle came from elsewhere.
 */
function requireAgentName(handle: ExecutorHandle): string {
  if (!handle.agentName) {
    throw new Error(
      `Herdr executor handle for ${handle.worktreePath} has no agent name to operate on.`,
    );
  }
  return handle.agentName;
}

export function directExecutionAgentName(workId: string, attemptNumber: number): string {
  const suffix = workId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "")
    .slice(0, 18);
  return `mm-${suffix || "work"}-a${attemptNumber}`.slice(0, 32);
}

export function buildDirectExecutionPrompt(request: DirectExecutionRequest): string {
  const startMarker = ".weavekit/mastermind-attempt.json";
  return [
    "Implement this reviewed Linear ticket directly in the current worktree.",
    "",
    "Hard boundaries:",
    "- Do not mutate Linear or call Linear APIs.",
    "- Do not write outside the current worktree.",
    "- Do not remove the worktree or repository.",
    `- First durable action: write ${startMarker} with schemaVersion 1 and the exact work/attempt IDs below.`,
    `- Final durable action: atomically write ${request.resultManifestPath} using the required result contract.`,
    "",
    "Execution environment:",
    ...(request.workspace.kind === "greenfield-repository-worktree"
      ? [
          "- This current worktree is the dedicated greenfield prototype worktree requested by the ticket.",
          "- An empty seeded repository is expected. Acquire required upstream source into this worktree and implement here; do not request another project or worktree.",
        ]
      : ["- This current worktree is the governed checkout selected for the ticket."]),
    "- A successful `gh auth status` is sufficient proof of GitHub CLI authentication. Do not infer that Copilot Requests permission is missing from the OAuth scope list because that permission is not enumerable there; escalate only if an authenticated operation rejects it.",
    "",
    `Work ID: ${request.workId}`,
    `Attempt ID: ${request.attemptId}`,
    `Attempt number: ${request.attemptNumber}`,
    `Ticket: ${request.ticket.identifier} - ${request.ticket.title}`,
    `Objective: ${request.objective}`,
    "",
    "Ticket description:",
    request.ticket.description,
    "",
    "Stored review summary:",
    request.review.dossier.summary,
    "",
    "Decision rationale:",
    request.decision.rationale,
    "",
    "Required validation commands:",
    ...(request.validationCommands.length > 0
      ? request.validationCommands.map((command) => `- ${command}`)
      : ["- Record at least one relevant structured verification entry."]),
    "",
    "Result contract:",
    "- schemaVersion: 1",
    "- exact workId, attemptId, and attemptNumber",
    "- outcome: succeeded | retryable-failure | terminal-failure | needs-human",
    "- concise summary",
    "- artifactPaths: relative existing paths inside this worktree",
    "- optional HTTPS pullRequestUrl",
    "- verification entries with command, exitCode, and concise summary",
    "- set expectedExitCode on a verification entry only when its passing code is not 0 (for example `git check-ignore`, which exits 1 exactly when the paths are not ignored)",
    "- knownRisks and remainingWork arrays",
    "",
    "Final response requirements:",
    "- Summarize all work completed, including the key files and behavior changed.",
    "- Report the validation performed and its results.",
    "- Give the user concrete, step-by-step instructions to manually verify the completed work.",
    "- Make manual verification specific to this implementation, including commands, paths, or expected behavior where useful.",
  ].join("\n");
}

function permissionArgs(config: MastermindExecutionDefaults): string[] {
  return [
    ...config.allowTools.map((value) => `--allow-tool=${value}`),
    ...config.denyTools.map((value) => `--deny-tool=${value}`),
    ...config.allowUrls.map((value) => `--allow-url=${value}`),
    ...config.denyUrls.map((value) => `--deny-url=${value}`),
  ];
}

function copilotAutopilotArgs(config: MastermindExecutionDefaults): string[] {
  if (config.harnessKind !== "copilot") return [];
  return [
    "--autopilot",
    "--allow-all",
    "--no-ask-user",
    "--max-autopilot-continues",
    String(config.maxAutopilotContinues),
    ...permissionArgs(config),
  ];
}

function isAgentPaneBusy(error: unknown): boolean {
  return error instanceof Error && error.message.includes('"code":"agent_pane_busy"');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function normalizeHerdrState(value: string | undefined): ExecutorStatus["state"] {
  return value && ["idle", "working", "blocked", "done", "unknown"].includes(value)
    ? (value as ExecutorStatus["state"])
    : "unknown";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sanitizeDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

async function hasMatchingDispatchEvidence(request: DirectExecutionRequest): Promise<boolean> {
  for (const path of [
    join(request.workspace.checkoutPath, ".weavekit", "mastermind-attempt.json"),
    join(request.workspace.checkoutPath, request.resultManifestPath),
  ]) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (
        value !== null &&
        typeof value === "object" &&
        "workId" in value &&
        value.workId === request.workId &&
        "attemptId" in value &&
        value.attemptId === request.attemptId &&
        "attemptNumber" in value &&
        value.attemptNumber === request.attemptNumber
      ) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }
  return false;
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<string> {
  const result = await execFileAsync(command, args, { cwd: options.cwd, encoding: "utf8" });
  return result.stdout;
}
