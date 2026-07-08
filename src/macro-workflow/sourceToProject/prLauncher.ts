import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import type { ProjectCatalogEntry, SourceToProjectPrLauncherConfig } from "../../config.js";
import type { ProjectBrief } from "../../generated/baml_client/index.js";

const execFileAsync = promisify(execFile);

export type SourceToProjectPrLaunchContext = {
  runId: string;
  nodeId: string;
  objective: string;
  source: string;
  project: ProjectCatalogEntry;
  opportunityId: string;
  opportunityTitle: string;
  reportMarkdown: string;
  visualPlanUrl?: string;
  planTitle?: string;
  recommendation?: string;
  projectBrief?: ProjectBrief;
  /**
   * "plan" (default) starts the agent in Copilot plan mode and waits for human approval
   * before editing files -- this is the manual "Create PR" button behavior.
   * "implement" skips plan mode and asks the agent to implement the reviewed opportunity
   * directly, since the plan was already produced and reviewed earlier in the workflow.
   */
  initialPromptMode?: "plan" | "implement";
};

export type SourceToProjectPrLaunchResult = {
  provider: "herdr";
  worktreePath: string;
  branchName: string;
  agentName: string;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  startedCommand: string;
};

export type SourceToProjectPrLauncher = {
  launch(args: SourceToProjectPrLaunchArgs): Promise<SourceToProjectPrLaunchResult>;
};

export type SourceToProjectPrLaunchArgs = {
  config: SourceToProjectPrLauncherConfig;
  context: SourceToProjectPrLaunchContext;
  shell?: SourceToProjectPrLauncherShell;
  /**
   * Detects whether the "superpowers" Codex plugin (which provides the subagent-driven-development
   * skill) is installed and enabled for the *local machine* running the agent -- this is a global
   * Codex plugin, not a per-target-project install. Defaults to reading `~/.codex/config.toml`.
   * Overridable for tests so assertions don't depend on the developer's local Codex config.
   */
  isSuperpowersInstalled?: () => boolean;
};

export type SourceToProjectPrLauncherShell = {
  run(command: string, args: string[], options: { cwd: string }): Promise<string>;
};

export async function launchSourceToProjectPrAgent(args: SourceToProjectPrLaunchArgs): Promise<SourceToProjectPrLaunchResult> {
  if (args.config.provider !== "herdr") {
    throw new Error(`Unsupported source-to-project PR launcher provider: ${String(args.config.provider)}`);
  }
  const shell = args.shell ?? { run: defaultRun };
  const launchIds = sourceToProjectPrLaunchIds(args.context);
  const label = labelForOpportunity(args.context);

  const createArgs = [
    "worktree",
    "create",
    "--cwd",
    args.context.project.workingTree,
    "--branch",
    launchIds.branchName,
    "--label",
    label,
    "--json",
  ];
  const createOutput = await runCreateOrOpenWorktree({
    shell,
    cwd: args.context.project.workingTree,
    createArgs,
    branchName: launchIds.branchName,
  });
  const createResult = parseHerdrWorktreeCreateOutput(createOutput);
  const worktreePath = createResult.worktreePath;
  const agentCommand = await resolveAgentCommandPath(args.config.agentCommand, shell, args.context.project.workingTree);
  const isSuperpowersInstalled = args.isSuperpowersInstalled ?? isSuperpowersInstalledForCodex;
  const prompt = args.context.initialPromptMode === "implement"
    ? buildSourceToProjectPrAgentAutoImplementInitialPrompt(args.context, agentCommand, isSuperpowersInstalled)
    : buildSourceToProjectPrAgentInitialPrompt(args.context);
  const agentArgs = buildAgentCommandArgs({
    agentCommand,
    configuredArgs: args.config.agentArgs,
    prompt,
  });
  const startCommand = createResult.rootPaneId
    ? await runAgentInRootPane({
      shell,
      cwd: args.context.project.workingTree,
      paneId: createResult.rootPaneId,
      agentName: launchIds.agentName,
      agentCommand,
      agentArgs,
    })
    : await startAgentInNewPane({
      shell,
      cwd: args.context.project.workingTree,
      launchIds,
      worktreePath,
      createResult,
      config: args.config,
      agentCommand,
      agentArgs,
    });

  return {
    provider: "herdr",
    worktreePath,
    branchName: launchIds.branchName,
    agentName: launchIds.agentName,
    workspaceId: createResult.workspaceId,
    tabId: createResult.tabId,
    paneId: createResult.rootPaneId,
    startedCommand: startCommand,
  };
}

async function runAgentInRootPane(args: {
  shell: SourceToProjectPrLauncherShell;
  cwd: string;
  paneId: string;
  agentName: string;
  agentCommand: string;
  agentArgs: string[];
}): Promise<string> {
  const commandLine = [args.agentCommand, ...args.agentArgs].map(shellQuote).join(" ");
  await args.shell.run("herdr", ["pane", "run", args.paneId, commandLine], { cwd: args.cwd });
  await args.shell.run("herdr", ["agent", "wait", args.paneId, "--status", "idle", "--timeout", "30000"], { cwd: args.cwd }).catch(() => undefined);
  await args.shell.run("herdr", ["agent", "rename", args.paneId, args.agentName], { cwd: args.cwd }).catch(() => undefined);
  return formatCommand("herdr", ["pane", "run", args.paneId, commandLine]);
}

async function startAgentInNewPane(args: {
  shell: SourceToProjectPrLauncherShell;
  cwd: string;
  launchIds: { branchName: string; agentName: string };
  worktreePath: string;
  createResult: { worktreePath: string; workspaceId?: string; tabId?: string; rootPaneId?: string };
  config: SourceToProjectPrLauncherConfig;
  agentCommand: string;
  agentArgs: string[];
}): Promise<string> {
  const placementArgs = args.createResult.workspaceId
    ? [
      "--workspace",
      args.createResult.workspaceId,
      ...(args.createResult.tabId ? ["--tab", args.createResult.tabId] : []),
    ]
    : ["--split", args.config.split];
  const startArgs = [
    "agent",
    "start",
    args.launchIds.agentName,
    "--cwd",
    args.worktreePath,
    ...placementArgs,
    "--",
    args.agentCommand,
    ...args.agentArgs,
  ];
  await args.shell.run("herdr", startArgs, { cwd: args.cwd });
  return formatCommand("herdr", startArgs);
}

function buildAgentCommandArgs(args: { agentCommand: string; configuredArgs: string[]; prompt: string }): string[] {
  const configuredArgs = [...args.configuredArgs];
  const permissionArgs = isCodexCommand(args.agentCommand) && !hasCodexPermissionOverride(configuredArgs)
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : isCopilotCommand(args.agentCommand) && !hasCopilotPermissionOverride(configuredArgs)
      ? ["--allow-all"]
      : [];
  return [...permissionArgs, ...configuredArgs, args.prompt];
}

function isCodexCommand(command: string): boolean {
  return command.split(/[\\/]/).pop() === "codex";
}

function isCopilotCommand(command: string): boolean {
  return command.split(/[\\/]/).pop() === "copilot";
}

/**
 * Checks the local machine's Codex config for an enabled "superpowers" plugin (e.g.
 * `superpowers@openai-curated`), which provides the subagent-driven-development skill. This is a
 * global, per-machine Codex plugin install -- unrelated to the target project's working tree.
 */
function isSuperpowersInstalledForCodex(): boolean {
  try {
    const configPath = join(homedir(), ".codex", "config.toml");
    const parsed = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const plugins = parsed.plugins;
    if (!plugins || typeof plugins !== "object") {
      return false;
    }
    return Object.entries(plugins as Record<string, unknown>).some(([name, value]) => {
      const enabled = value && typeof value === "object" ? (value as Record<string, unknown>).enabled : undefined;
      return name.split("@")[0] === "superpowers" && enabled === true;
    });
  } catch {
    return false;
  }
}

function hasCopilotPermissionOverride(args: string[]): boolean {
  return args.some((arg) => (
    arg === "--allow-all"
    || arg === "--allow-all-tools"
    || arg.startsWith("--allow-tool")
  ));
}

function hasCodexPermissionOverride(args: string[]): boolean {
  return args.some((arg) => (
    arg === "--dangerously-bypass-approvals-and-sandbox"
    || arg === "--sandbox"
    || arg.startsWith("--sandbox=")
    || arg === "-s"
    || arg === "--ask-for-approval"
    || arg.startsWith("--ask-for-approval=")
    || arg === "-a"
  ));
}

async function runCreateOrOpenWorktree(args: {
  shell: SourceToProjectPrLauncherShell;
  cwd: string;
  createArgs: string[];
  branchName: string;
}): Promise<string> {
  try {
    return await args.shell.run("herdr", args.createArgs, { cwd: args.cwd });
  } catch (error) {
    if (!isExistingWorktreeError(error)) {
      throw error;
    }
    return args.shell.run("herdr", [
      "worktree",
      "open",
      "--cwd",
      args.cwd,
      "--branch",
      args.branchName,
      "--json",
    ], { cwd: args.cwd });
  }
}

async function resolveAgentCommandPath(
  command: string,
  shell: SourceToProjectPrLauncherShell,
  cwd: string,
): Promise<string> {
  if (command.includes("/")) {
    return command;
  }
  try {
    const resolved = (await shell.run("sh", ["-lc", `command -v ${shellQuote(command)}`], { cwd })).trim();
    return resolved || command;
  } catch {
    return command;
  }
}

function isExistingWorktreeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:already exists|exists|already checked out)\b/i.test(message);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildSourceToProjectPrAgentPrompt(context: SourceToProjectPrLaunchContext): string {
  return [
    "Requirements:",
    "- Implement the reviewed opportunity only; do not switch to a different recommendation.",
    "- Run the configured validation commands before opening the PR.",
    "- Commit the completed implementation in this worktree.",
    "- Open a pull request against the configured mainline and include the source-to-project context in the PR body.",
    "",
    `Run: ${context.runId}`,
    `Node: ${context.nodeId}`,
    `Objective: ${context.objective}`,
    `Source: ${context.source}`,
    `Project: ${context.project.displayName} (${context.project.id})`,
    `Project working tree: ${context.project.workingTree}`,
    `Mainline: ${context.project.mainline}`,
    `Opportunity: ${context.opportunityId} - ${context.opportunityTitle}`,
    context.planTitle ? `Plan: ${context.planTitle}` : undefined,
    context.recommendation ? `Recommendation: ${context.recommendation}` : undefined,
    context.visualPlanUrl ? `Visual plan: ${context.visualPlanUrl}` : undefined,
    ...renderProjectBrief(context.projectBrief),
    "",
    "Validation commands:",
    ...(context.project.validationCommands.length > 0
      ? context.project.validationCommands.map((command) => `- ${command}`)
      : ["- No validation commands were configured; run the smallest relevant checks you can justify."]),
    "",
    "Reviewed source-to-project report:",
    context.reportMarkdown,
  ].filter((part): part is string => Boolean(part)).join("\n");
}

function renderProjectBrief(projectBrief: ProjectBrief | undefined): string[] {
  if (!projectBrief) {
    return [];
  }
  return [
    "",
    "Target project research brief:",
    projectBrief.architecture ? `Architecture: ${projectBrief.architecture}` : undefined,
    ...renderNamedList("Constraints", projectBrief.constraints),
    ...renderNamedList("Goals", projectBrief.goals),
    ...renderNamedList("Change surfaces", projectBrief.changeSurfaces),
    ...renderNamedList("Project research validation commands", projectBrief.validationCommands),
    ...renderNamedList("Project risks", projectBrief.risks),
    ...renderNamedList("Project evidence", projectBrief.evidence.map((evidence) =>
      `${evidence.id}: ${evidence.source}${evidence.quote ? ` - ${evidence.quote}` : ""}`
    )),
  ].filter((part): part is string => Boolean(part));
}

function renderNamedList(title: string, values: string[]): string[] {
  if (values.length === 0) {
    return [];
  }
  return [
    "",
    `${title}:`,
    ...values.map((value) => `- ${value}`),
  ];
}

export function buildSourceToProjectPrAgentInitialPrompt(context: SourceToProjectPrLaunchContext): string {
  return [
    "/plan",
    "",
    buildSourceToProjectPrAgentPrompt(context),
  ].join("\n");
}

/**
 * Skips plan mode entirely: the opportunity was already planned and reviewed earlier in the
 * source-to-project workflow, so this asks the agent to implement it directly in the freshly
 * created worktree rather than re-planning and waiting for a separate approval step.
 *
 * The opening line is tailored per agent:
 * - Copilot (and anything else): keeps the "no plan-mode approval step" explanation, since
 *   Copilot has no equivalent concept of an installed skill library to defer to.
 * - Codex: drops that parenthetical (Codex doesn't have a "plan mode" to explain away) and, when
 *   the superpowers plugin is installed locally, asks the agent to use its
 *   subagent-driven-development skill instead of a bare "implement this" instruction.
 */
export function buildSourceToProjectPrAgentAutoImplementInitialPrompt(
  context: SourceToProjectPrLaunchContext,
  agentCommand: string,
  isSuperpowersInstalled: () => boolean = isSuperpowersInstalledForCodex,
): string {
  const openingLine = isCodexCommand(agentCommand)
    ? isSuperpowersInstalled()
      ? "Use subagent-driven development to implement this reviewed source-to-project opportunity directly."
      : "Implement this reviewed source-to-project opportunity directly."
    : "Implement this reviewed source-to-project opportunity directly (no plan-mode approval step; it was already planned and reviewed upstream in the workflow).";
  return [
    openingLine,
    "",
    buildSourceToProjectPrAgentPrompt(context),
  ].join("\n");
}

function sourceToProjectPrLaunchIds(context: SourceToProjectPrLaunchContext): { branchName: string; agentName: string } {
  const opportunitySlug = shortLaunchPart(context.opportunityId, 24) || shortLaunchPart(context.nodeId, 24);
  const runSlug = shortLaunchPart(context.runId, 8);
  const shortId = [opportunitySlug, runSlug].filter(Boolean).join("-") || "manual-pr";
  return {
    // Keep this short: Herdr derives the worktree directory name from the branch name, and a
    // long "source-to-project/<opportunity-id>-<full-run-uuid>" branch produced an unwieldy
    // worktree directory. `worktree/<short-id>` mirrors Herdr's own short worktree naming.
    branchName: `worktree/${shortId}`.slice(0, 60),
    agentName: `source-to-project-${shortId}`.slice(0, 60),
  };
}

function labelForOpportunity(context: SourceToProjectPrLaunchContext): string {
  return (context.opportunityTitle || context.opportunityId || "Source-to-project PR").slice(0, 80);
}

function sanitizeLaunchPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/(^-|-$)/g, "");
}

function shortLaunchPart(value: string, maxLen: number): string {
  return sanitizeLaunchPart(value).slice(0, maxLen).replace(/-+$/, "");
}

function parseHerdrWorktreeCreateOutput(output: string): { worktreePath: string; workspaceId?: string; tabId?: string; rootPaneId?: string } {
  const parsed = parseJsonObject(output);
  const worktreePath = findStringByKey(parsed, "path") ?? findStringByKey(parsed, "worktree_path");
  if (!worktreePath) {
    throw new Error("Herdr worktree create did not return a worktree path.");
  }
  return {
    worktreePath,
    workspaceId: findStringByKey(parsed, "workspace_id") ?? findStringByKey(parsed, "open_workspace_id"),
    tabId: findStringInNamedObject(parsed, "tab", "tab_id") ?? findStringByKey(parsed, "tab_id"),
    rootPaneId: findStringInNamedObject(parsed, "root_pane", "pane_id"),
  };
}

function parseJsonObject(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Herdr worktree create returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function findStringByKey(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, key);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string" && record[key].trim()) {
    return record[key];
  }
  for (const child of Object.values(record)) {
    const found = findStringByKey(child, key);
    if (found) return found;
  }
  return undefined;
}

function findStringInNamedObject(value: unknown, objectKey: string, valueKey: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringInNamedObject(item, objectKey, valueKey);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const named = record[objectKey];
  if (named && typeof named === "object" && !Array.isArray(named)) {
    const namedRecord = named as Record<string, unknown>;
    if (typeof namedRecord[valueKey] === "string" && namedRecord[valueKey].trim()) {
      return namedRecord[valueKey];
    }
  }
  for (const child of Object.values(record)) {
    const found = findStringInNamedObject(child, objectKey, valueKey);
    if (found) return found;
  }
  return undefined;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(" ");
}

async function defaultRun(command: string, args: string[], options: { cwd: string }): Promise<string> {
  const result = await execFileAsync(command, args, { cwd: options.cwd });
  return result.stdout;
}
