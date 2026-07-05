#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { expandHomePath, loadLocalEnvFiles, loadTypedWeavekitConfig, loadWeavekitConfig, resolveProjectCatalogEntry, type ProjectCatalogEntry } from "./config.js";
import { DecisionCouncilRunFailedError } from "./decision-council/errors.js";
import type { DecisionCouncilInput } from "./decision-council/types.js";
import type { DecisionCouncilLogger } from "./decision-council/logger.js";
import type { TelemetryHandle } from "./telemetry/bootstrap.js";
import { WorkflowHarnessKind, type WorkflowPlanTemplateId, type WorkflowReplayEvent } from "./macro-workflow/types.js";
import { MacroWorkflowEventKind } from "./macro-workflow/logger.js";
import { extractXPostUrls, preprocessWorkflowPrompt, type XPostFetchResult } from "./macro-workflow/promptPreprocessor.js";

export type LogFormat = "pretty" | "json" | "silent";

const noopTelemetryHandle: TelemetryHandle = {
  async shutdown() {},
};

export type DecisionCouncilCliArgs = {
  inputPath: string;
  outputDir: string;
  logFormat: LogFormat;
  maxRounds?: number;
  smoke: boolean;
};

export type EntityCliArgs = {
  command: "validate";
};

export type WorkflowCliArgs = {
  command: "plan" | "run" | "dashboard";
  inputPath?: string;
  prompt?: string;
  outputDir: string;
  staticTemplate: boolean;
  dryRun: boolean;
  dashboard?: boolean;
  dashboardPort?: number;
  dashboardUrl?: string;
  watchDir?: string;
  template?: string;
  source?: string;
  project?: string;
  projectPath?: string;
  mode?: "advisory" | "autonomous-pr";
  configPath?: string;
};

export type WorkflowRunDescriptor = {
  runId: string;
  runName: string;
  outputDir: string;
};

export function parseEntityCliArgs(argv: string[]): EntityCliArgs {
  if (argv[0] !== "entity" || argv[1] !== "validate" || argv.length !== 2) {
    throw new Error("Usage: weavekit entity validate");
  }
  return { command: "validate" };
}

export async function runEntityCli(_args: EntityCliArgs): Promise<string> {
  const { formatEntityValidationErrors, validateEntityCatalog } = await import("./entities/index.js");
  const result = validateEntityCatalog(process.cwd());
  if (!result.valid) {
    throw new Error(formatEntityValidationErrors(result.errors));
  }
  const { materializeWorkflowPlan, verifyWorkflowPlan } = await import("./macro-workflow/index.js");
  const sourceToProjectPlan = materializeWorkflowPlan("source-to-project", {
    objective: "Validate source-to-project workflow metadata",
    source: "static-doctor",
    project: "weavekit",
    mode: "advisory",
  });
  const workflowValidation = verifyWorkflowPlan(sourceToProjectPlan);
  if (!workflowValidation.valid) {
    throw new Error([
      `Workflow metadata validation failed with ${workflowValidation.issues.length} error(s).`,
      "",
      ...workflowValidation.issues.map((issue, index) =>
        `${index + 1}. ${issue.nodeId ?? "<plan>"} ${issue.code}: ${issue.message}`
      ),
    ].join("\n"));
  }
  return "Entity catalog valid.\n";
}

export function parseDecisionCouncilCliArgs(argv: string[]): DecisionCouncilCliArgs {
  if (argv[0] !== "decision-council" || argv[1] !== "run") {
    throw new Error(
      "Usage: weavekit decision-council run --input <path> [--output <dir>] [--max-rounds <n>] [--smoke] [--log-format <pretty|json|silent>]",
    );
  }

  const inputIndex = argv.indexOf("--input");
  if (inputIndex === -1 || !argv[inputIndex + 1]) {
    throw new Error("Missing required --input <path> argument.");
  }

  const outputIndex = argv.indexOf("--output");
  const logFormatIndex = argv.indexOf("--log-format");
  const logFormat = logFormatIndex === -1 ? "pretty" : argv[logFormatIndex + 1];

  if (logFormat !== "pretty" && logFormat !== "json" && logFormat !== "silent") {
    throw new Error("Invalid --log-format value. Expected pretty, json, or silent.");
  }

  const smoke = argv.includes("--smoke");

  const maxRoundsIndex = argv.indexOf("--max-rounds");
  if (maxRoundsIndex !== -1 && !argv[maxRoundsIndex + 1]) {
    throw new Error("Missing value for --max-rounds <n>.");
  }
  let maxRounds = maxRoundsIndex === -1 ? undefined : Number(argv[maxRoundsIndex + 1]);
  if (maxRounds !== undefined && (!Number.isInteger(maxRounds) || maxRounds < 1)) {
    throw new Error("Invalid --max-rounds value. Expected a positive integer.");
  }

  const removedNamedSelectionFlag = `--persona${"-set"}`;
  if (argv.includes(removedNamedSelectionFlag)) {
    throw new Error("Static persona sets are not supported. Usage: weavekit decision-council run --input <path> [--output <dir>] [--max-rounds <n>] [--smoke] [--log-format <pretty|json|silent>]");
  }

  // --smoke is a runtime preset only: dynamic selection still chooses personas.
  if (smoke && maxRounds === undefined) {
    maxRounds = 1;
  }

  return {
    inputPath: argv[inputIndex + 1]!,
    outputDir: outputIndex === -1 ? "runs/latest" : argv[outputIndex + 1] ?? "runs/latest",
    logFormat,
    maxRounds,
    smoke,
  };
}

export function parseWorkflowCliArgs(argv: string[]): WorkflowCliArgs {
  if (argv[0] !== "workflow") {
    throw new Error("Usage: weavekit workflow <plan|run|dashboard> [--input <path>|--prompt <text>] [--output <dir>] [--template <id>] [--dry-run] [--dashboard] [--dashboard-port <port>] [--dashboard-url <url>] [--watch-dir <dir>]");
  }

  const command = argv[1];
  if (command !== "plan" && command !== "run" && command !== "dashboard") {
    throw new Error("Usage: weavekit workflow <plan|run|dashboard> [--input <path>|--prompt <text>] [--output <dir>] [--template <id>] [--dry-run] [--dashboard] [--dashboard-port <port>] [--dashboard-url <url>] [--watch-dir <dir>]");
  }

  const outputIndex = argv.indexOf("--output");
  const templateIndex = argv.indexOf("--template");
  const dashboardPortIndex = argv.indexOf("--dashboard-port");
  const dashboardUrlIndex = argv.indexOf("--dashboard-url");
  const watchDirIndex = argv.indexOf("--watch-dir");
  const portIndex = argv.indexOf("--port");
  const inputIndex = argv.indexOf("--input");
  const promptIndex = argv.indexOf("--prompt");
  const sourceIndex = argv.indexOf("--source");
  const projectIndex = argv.indexOf("--project");
  const projectPathIndex = argv.indexOf("--project-path");
  const modeIndex = argv.indexOf("--mode");
  const configIndex = argv.indexOf("--config");

  if (templateIndex !== -1 && !argv[templateIndex + 1]) {
    throw new Error("Missing value for --template <id>.");
  }
  if (dashboardPortIndex !== -1 && !argv[dashboardPortIndex + 1]) {
    throw new Error("Missing value for --dashboard-port <port>.");
  }
  if (dashboardUrlIndex !== -1 && !argv[dashboardUrlIndex + 1]) {
    throw new Error("Missing value for --dashboard-url <url>.");
  }
  if (watchDirIndex !== -1 && !argv[watchDirIndex + 1]) {
    throw new Error("Missing value for --watch-dir <dir>.");
  }
  if (portIndex !== -1 && !argv[portIndex + 1]) {
    throw new Error("Missing value for --port <port>.");
  }
  if (sourceIndex !== -1 && !argv[sourceIndex + 1]) {
    throw new Error("Missing value for --source <url-or-path>.");
  }
  if (projectIndex !== -1 && !argv[projectIndex + 1]) {
    throw new Error("Missing value for --project <id>.");
  }
  if (projectPathIndex !== -1 && !argv[projectPathIndex + 1]) {
    throw new Error("Missing value for --project-path <path>.");
  }
  if (modeIndex !== -1 && !argv[modeIndex + 1]) {
    throw new Error("Missing value for --mode <advisory|autonomous-pr>.");
  }
  if (configIndex !== -1 && !argv[configIndex + 1]) {
    throw new Error("Missing value for --config <path>.");
  }
  if (promptIndex !== -1 && !argv[promptIndex + 1]) {
    throw new Error("Missing value for --prompt <text>.");
  }

  const template = templateIndex === -1 ? undefined : argv[templateIndex + 1];
  const isSourceToProject = template === "source-to-project";
  if (command !== "dashboard" && inputIndex === -1 && promptIndex === -1 && !isSourceToProject) {
    throw new Error("Missing required --input <path> or --prompt <text> argument.");
  }
  if (command !== "dashboard" && inputIndex !== -1 && !argv[inputIndex + 1]) {
    throw new Error("Missing value for --input <path>.");
  }
  if (command !== "dashboard" && inputIndex !== -1 && promptIndex !== -1) {
    throw new Error("Use either --input <path> or --prompt <text>, not both.");
  }
  if (command !== "dashboard" && isSourceToProject && projectIndex === -1 && projectPathIndex === -1) {
    throw new Error("Missing required --project <id> or --project-path <path> argument.");
  }

  const dryRun = command === "plan" || argv.includes("--dry-run");
  const portValue = portIndex === -1 ? undefined : Number(argv[portIndex + 1]);
  const dashboardPortValue = dashboardPortIndex === -1 ? portValue : Number(argv[dashboardPortIndex + 1]);
  const dashboard = command !== "dashboard" && (argv.includes("--dashboard") || dashboardPortValue !== undefined);
  const dashboardUrl = dashboardUrlIndex === -1 ? undefined : argv[dashboardUrlIndex + 1];
  const watchDir = watchDirIndex === -1 ? undefined : argv[watchDirIndex + 1];
  const mode = modeIndex === -1 ? undefined : argv[modeIndex + 1];

  if (dashboardPortValue !== undefined && (!Number.isInteger(dashboardPortValue) || dashboardPortValue < 1 || dashboardPortValue > 65535)) {
    throw new Error("Invalid --dashboard-port value. Expected an integer between 1 and 65535.");
  }
  if (mode !== undefined && mode !== "advisory" && mode !== "autonomous-pr") {
    throw new Error("Invalid --mode value. Expected advisory or autonomous-pr.");
  }

  const parsed: WorkflowCliArgs = {
    command,
    outputDir: outputIndex === -1 ? "runs" : argv[outputIndex + 1] ?? "runs",
    staticTemplate: template !== undefined,
    dryRun,
  };

  if (command !== "dashboard" && inputIndex !== -1) {
    parsed.inputPath = argv[inputIndex + 1]!;
  }
  if (command !== "dashboard" && promptIndex !== -1) {
    parsed.prompt = argv[promptIndex + 1]!;
  }
  if (dashboard) {
    parsed.dashboard = true;
  }
  if (dashboardPortValue !== undefined) {
    parsed.dashboardPort = dashboardPortValue;
  }
  if (dashboardUrl !== undefined) {
    parsed.dashboardUrl = dashboardUrl;
  }
  if (watchDir !== undefined) {
    parsed.watchDir = watchDir;
  }
  if (template !== undefined) {
    parsed.template = template;
  }
  if (sourceIndex !== -1) {
    parsed.source = argv[sourceIndex + 1]!;
  }
  if (projectIndex !== -1) {
    parsed.project = argv[projectIndex + 1]!;
  }
  if (projectPathIndex !== -1) {
    parsed.projectPath = argv[projectPathIndex + 1]!;
  }
  if (mode !== undefined) {
    parsed.mode = mode;
  }
  if (configIndex !== -1) {
    parsed.configPath = argv[configIndex + 1];
  }
  return parsed;
}

export async function readDecisionCouncilInputFile(inputPath: string): Promise<DecisionCouncilInput> {
  const prompt = await readFile(inputPath, "utf8");
  return { prompt, context: [], constraints: [] };
}

export function formatDecisionCouncilSuccessMessage(args: { recommendation: string; outputDir: string }): string {
  return [
    args.recommendation,
    `Markdown report: ${join(args.outputDir, "DecisionCouncilReport.md")}`,
    `Artifacts written to ${args.outputDir}`,
    "",
  ].join("\n");
}

export async function createDecisionCouncilLogger(format: LogFormat): Promise<DecisionCouncilLogger> {
  const { createConsoleDecisionCouncilLogger, createJsonDecisionCouncilLogger, createSilentDecisionCouncilLogger } = await import("./decision-council/logger.js");
  if (format === "json") return createJsonDecisionCouncilLogger();
  if (format === "silent") return createSilentDecisionCouncilLogger();
  return createConsoleDecisionCouncilLogger();
}

export function formatWorkflowCliSuccessMessage(args: { outputDir: string }): string {
  return [`Macro workflow plan: ${args.outputDir}`, ""].join("\n");
}

export function formatWorkflowRunStartedMessage(args: { runId: string; outputDir: string }): string {
  return [
    `[weavekit] Workflow run id: ${args.runId}`,
    `[weavekit] Workflow output: ${args.outputDir}`,
  ].join("\n") + "\n";
}

export function formatWorkflowNodeFailureMessage(args: {
  nodeId: string;
  title?: string;
  status?: string;
  error?: string;
  output?: string;
}): string {
  const details = [
    `[weavekit][error] Workflow node failed: ${args.title ? `${args.title} (${args.nodeId})` : args.nodeId}`,
    args.status ? `[weavekit][error] Status: ${args.status}` : undefined,
    args.error ? `[weavekit][error] Error: ${args.error}` : undefined,
    !args.error && args.output ? `[weavekit][error] Output: ${args.output}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return `${details.join("\n")}\n`;
}

export function createWorkflowRunDescriptor(outputRoot: string, objective: string): WorkflowRunDescriptor {
  const runId = randomUUID();
  const normalizedRoot = basename(outputRoot) === "latest" ? dirname(outputRoot) : outputRoot;
  return {
    runId,
    runName: generateWorkflowRunName(objective),
    outputDir: join(normalizedRoot, runId),
  };
}

export function inferSourceReferenceFromPrompt(prompt: string): string | undefined {
  const urlMatch = prompt.match(/https?:\/\/[^\s)>\]}"]+/);
  if (urlMatch) {
    return urlMatch[0]!.replace(/[.,;:!?]+$/, "");
  }

  const explicitLine = prompt.match(/^\s*(?:source|blog)\s*:\s*(.+?)\s*$/im);
  if (!explicitLine?.[1]) {
    return undefined;
  }
  return explicitLine[1].trim().replace(/[.,;:!?]+$/, "") || undefined;
}

function generateWorkflowRunName(objective: string): string {
  const words = objective
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .map((word) => word.slice(0, 18));
  if (words.length === 0) {
    return "Workflow Run";
  }
  return words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`).join(" ");
}

function resolveWorkflowTemplateId(template: string | undefined): WorkflowPlanTemplateId | undefined {
  if (template === undefined) {
    return undefined;
  }
  if (template !== "implementation-review" && template !== "source-to-project" && template !== "x-article-summary") {
    throw new Error(`Unknown workflow template: ${template}`);
  }
  return template;
}

function createProjectCatalogEntryFromPath(projectPath: string): ProjectCatalogEntry {
  return {
    id: "path-override",
    displayName: "Path override",
    workingTree: expandHomePath(projectPath),
    mainline: "origin main",
    remote: "origin",
    contextDocs: [],
    validationCommands: [],
    autonomousPrAllowed: false,
    notification: "cli",
    knowledgeExport: "off",
  };
}

export function createWorkflowProgressReporter(stream: Pick<NodeJS.WritableStream, "write"> = process.stderr) {
  let timer: NodeJS.Timeout | undefined;

  return {
    start(message: string, intervalMs = 10000) {
      if (timer) {
        clearInterval(timer);
      }
      stream.write(`[weavekit] ${message}\n`);
      timer = setInterval(() => {
        stream.write(`[weavekit] still working... ${message}\n`);
      }, intervalMs);
    },
    stop(finalMessage?: string) {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (finalMessage) {
        stream.write(`[weavekit] ${finalMessage}\n`);
      }
    },
  };
}

type WorkflowCopilotLogEvent = {
  phase: string;
  mode?: string;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  elapsedMs?: number;
  promptLength?: number;
  eventType?: string;
  contentLength?: number;
  message?: string;
  toolName?: string;
  toolCallCount?: number;
  maxToolCalls?: number;
};

export function formatWorkflowCopilotLog(event: WorkflowCopilotLogEvent): string {
  const details = [
    event.mode ? `mode=${event.mode}` : undefined,
    event.model ? `model=${event.model}` : undefined,
    event.cwd ? `cwd=${event.cwd}` : undefined,
    event.eventType ? `event=${event.eventType}` : undefined,
    event.toolName ? `tool=${event.toolName}` : undefined,
    event.toolCallCount !== undefined ? `toolCalls=${event.toolCallCount}` : undefined,
    event.maxToolCalls !== undefined ? `maxToolCalls=${event.maxToolCalls}` : undefined,
    event.timeoutMs !== undefined ? `timeoutMs=${event.timeoutMs}` : undefined,
    event.elapsedMs !== undefined ? `elapsedMs=${event.elapsedMs}` : undefined,
    event.promptLength !== undefined ? `promptChars=${event.promptLength}` : undefined,
    event.contentLength !== undefined ? `contentChars=${event.contentLength}` : undefined,
    event.message ? `message=${event.message.replace(/\s+/g, " ").slice(0, 160)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return `[weavekit][copilot-sdk] ${event.phase}${details.length ? ` ${details.join(" ")}` : ""}\n`;
}

export async function runWorkflowCli(args: WorkflowCliArgs): Promise<string> {
  loadLocalEnvFiles();
  const typedConfig = loadTypedWeavekitConfig(args.configPath);

  if (args.command === "dashboard") {
    const workflowDashboardModule = await import("./macro-workflow/dashboardServer.js");
    const dashboardServer = await workflowDashboardModule.createWorkflowDashboardServer(undefined, {
      port: args.dashboardPort,
      watchDir: args.watchDir ?? args.outputDir,
      configPath: args.configPath,
    });
    process.stdout.write(`Workflow dashboard: ${dashboardServer.url}\n`);
    await new Promise<void>((resolve) => {
      const stopDashboard = () => {
        dashboardServer.stop().then(() => resolve()).catch((error) => {
          process.stderr.write(`Dashboard shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
          resolve();
        });
      };
      process.once("SIGINT", stopDashboard);
      process.once("SIGTERM", stopDashboard);
    });
    return "Workflow dashboard stopped.\n";
  }

  const { assertValidEntityCatalog } = await import("./entities/index.js");
  assertValidEntityCatalog(process.cwd());

  if (!args.inputPath && !args.prompt && args.template !== "source-to-project") {
    throw new Error("Missing required --input <path> or --prompt <text> argument.");
  }
  if (args.inputPath && args.prompt) {
    throw new Error("Use either --input <path> or --prompt <text>, not both.");
  }

  const promptWasUserProvided = Boolean(args.prompt || args.inputPath);
  const rawPrompt = args.prompt ?? (args.inputPath ? await readFile(args.inputPath, "utf8") : `Source: ${args.source ?? ""}\nProject: ${args.project ?? args.projectPath ?? ""}`);
  const xPostUrlsToResolve = extractXPostUrls([rawPrompt, args.source].filter((part): part is string => Boolean(part)).join("\n"));
  if (xPostUrlsToResolve.length > 0) {
    process.stderr.write(`[weavekit] Resolving ${xPostUrlsToResolve.length} X post source${xPostUrlsToResolve.length === 1 ? "" : "s"} with grok...\n`);
  }
  const preprocessedPrompt = await preprocessWorkflowPrompt({ prompt: rawPrompt, source: args.source });
  if (xPostUrlsToResolve.length > 0) {
    process.stderr.write(`[weavekit] X post source${xPostUrlsToResolve.length === 1 ? "" : "s"} resolved.\n`);
  }
  const prompt = preprocessedPrompt.prompt;
  const fetchedXPosts = preprocessedPrompt.fetchedXPosts;
  const objective = prompt.trim() || "Macro workflow";
  const runDescriptor = createWorkflowRunDescriptor(args.outputDir, objective);
  const isSourceToProject = args.template === "source-to-project";
  const resolvedSource = isSourceToProject
    ? args.source ?? inferSourceReferenceFromPrompt(prompt) ?? (promptWasUserProvided ? prompt.trim() : undefined)
    : args.source;
  let sourceToProjectProject: ProjectCatalogEntry | undefined;
  let sourceToProjectMode: "advisory" | "autonomous-pr" | undefined;
  if (isSourceToProject) {
    if (!resolvedSource) {
      throw new Error("Missing source-to-project source. Provide --source <url-or-path>, include a URL/source:/blog: line in the prompt/input, or pass the source text directly as --prompt/--input.");
    }
    if (!args.project && !args.projectPath) {
      throw new Error("Missing required --project <id> or --project-path <path> argument.");
    }
    sourceToProjectProject = args.project
      ? resolveProjectCatalogEntry(typedConfig, args.project)
      : createProjectCatalogEntryFromPath(args.projectPath!);
    sourceToProjectMode = args.mode ?? typedConfig.sourceToProject.mode;
    if (sourceToProjectMode === "autonomous-pr" && !sourceToProjectProject.autonomousPrAllowed) {
      throw new Error(`Autonomous PR mode is disabled for project ${sourceToProjectProject.id}.`);
    }
  }
  const prefetchedSourceContent = isSourceToProject
    ? findPrefetchedXPostContent(fetchedXPosts, resolvedSource)
    : undefined;

  process.stderr.write(formatWorkflowRunStartedMessage(runDescriptor));

  const [
    workflowArtifactsModule,
    workflowBamlAdapterModule,
    workflowHarnessModule,
    workflowLoggerModule,
    workflowRunnerModule,
    workflowTemplatesModule,
    workflowDashboardModule,
    workflowSourceToProjectModule,
    workflowUsageModule,
  ] = await Promise.all([
    import("./macro-workflow/artifacts.js"),
    import("./macro-workflow/bamlAdapters.js"),
    import("./macro-workflow/harness.js"),
    import("./macro-workflow/logger.js"),
    import("./macro-workflow/runner.js"),
    import("./macro-workflow/templates.js"),
    import("./macro-workflow/dashboardServer.js"),
    import("./macro-workflow/sourceToProject/harnesses.js"),
    import("./macro-workflow/usage.js"),
  ]);
  const usageCollector = new workflowUsageModule.WorkflowUsageCollector();
  const planner = new workflowBamlAdapterModule.GeneratedWorkflowPlannerAdapter({ usageCollector });
  const templateId = resolveWorkflowTemplateId(args.template);
  const progress = createWorkflowProgressReporter();
  let plan;

  progress.start("Planning workflow DAG with the BAML planner...");
  try {
    plan = templateId
      ? workflowTemplatesModule.materializeWorkflowPlan(templateId, {
        objective,
        source: resolvedSource,
        project: args.project,
        projectPath: args.projectPath,
        mode: sourceToProjectMode ?? args.mode,
      })
      : await planner.planWorkflow({ objective, prompt, templateId: "implementation-review" });
    progress.stop("Workflow plan generated.");
  } catch (error) {
    progress.stop();
    throw error;
  }

  if (args.command === "plan" || args.dryRun) {
    await workflowArtifactsModule.writeMacroWorkflowArtifacts({ outputDir: runDescriptor.outputDir, state: {
      runId: runDescriptor.runId,
      runName: runDescriptor.runName,
      planId: plan.id,
      objective: plan.objective,
      templateId: plan.templateId,
      status: "passed",
      startedAt: new Date(),
      completedAt: new Date(),
      plan,
      currentPlan: plan,
      nodeResults: [],
      replans: [],
      activeNodeId: undefined,
      usage: usageCollector.summarize(),
    }});
    return formatWorkflowCliSuccessMessage({ outputDir: runDescriptor.outputDir });
  }

  let dashboardServer: Awaited<ReturnType<typeof workflowDashboardModule.createWorkflowDashboardServer>> | undefined;
  let dashboardPublisher: Awaited<ReturnType<typeof workflowDashboardModule.createWorkflowDashboardPublisher>> | undefined;
  const replayEvents: WorkflowReplayEvent[] = [];
  let replayEventWrite = Promise.resolve();
  let stateSnapshotWrite = Promise.resolve();
  const initialRunState = {
    runId: runDescriptor.runId,
    runName: runDescriptor.runName,
    planId: plan.id,
    objective: plan.objective,
    templateId: plan.templateId,
    status: "running" as const,
    startedAt: new Date(),
    plan,
    currentPlan: plan,
    nodeResults: [],
    replans: [],
    activeNodeId: undefined,
  };
  stateSnapshotWrite = stateSnapshotWrite.then(async () => {
    await workflowArtifactsModule.writeMacroWorkflowStateArtifact(runDescriptor.outputDir, initialRunState);
  });
  if (args.dashboard) {
    dashboardServer = await workflowDashboardModule.createWorkflowDashboardServer(initialRunState, { port: args.dashboardPort, watchDir: args.outputDir, configPath: args.configPath });
  } else if (args.dashboardUrl) {
    dashboardPublisher = await workflowDashboardModule.createWorkflowDashboardPublisher(args.dashboardUrl);
  }

  const sourceToProjectNotifier = isSourceToProject
    ? workflowSourceToProjectModule.createDefaultSourceToProjectNotifier()
    : undefined;

  const harnesses = isSourceToProject
    ? workflowSourceToProjectModule.createSourceToProjectHarnessRegistry({
      source: resolvedSource!,
      originalPrompt: prompt,
      prefetchedSourceContent,
      project: sourceToProjectProject!,
      mode: sourceToProjectMode!,
      maxOpportunities: sourceToProjectProject!.maxOpportunities ?? typedConfig.sourceToProject.maxOpportunities,
      thresholds: {
        ...typedConfig.sourceToProject.thresholds,
        ...sourceToProjectProject!.thresholds,
      },
      sourceToProject: typedConfig.sourceToProject,
      tooling: typedConfig.tooling,
      plugins: typedConfig.plugins,
      notifier: sourceToProjectNotifier,
      copilot: typedConfig.sourceToProject.offline
        ? workflowSourceToProjectModule.createOfflineSourceToProjectHarnessClient()
        : workflowSourceToProjectModule.createCopilotSdkHarnessClient({
          copilot: typedConfig.copilot,
          sourceToProject: typedConfig.sourceToProject,
          onUserInputRequest: workflowSourceToProjectModule.createSourceToProjectUserInputRequestHandler({
            project: sourceToProjectProject!,
            source: resolvedSource!,
            notifier: sourceToProjectNotifier!,
          }),
          onLog: (event) => {
            process.stderr.write(formatWorkflowCopilotLog(event));
          },
          onUsage: (event) => {
            usageCollector.record({
              executor: "copilot-sdk",
              operation: event.operation,
              mode: event.mode,
              model: event.model,
              cwd: event.cwd,
              nodeId: event.nodeId,
              label: event.label,
              ...event.usage,
            });
          },
        }),
      baml: typedConfig.sourceToProject.offline
        ? undefined
        : workflowSourceToProjectModule.createLiveSourceToProjectBamlClient({ usageCollector }),
    })
    : templateId === "x-article-summary"
      ? createXArticleSummaryHarnessRegistry(workflowHarnessModule)
      : workflowHarnessModule.createStaticHarnessRegistry();

  const state = await workflowRunnerModule.runMacroWorkflow(plan, {
    harnesses,
    outputDir: runDescriptor.outputDir,
    replanner: planner,
    expandAfterNode: isSourceToProject
      ? workflowSourceToProjectModule.createSourceToProjectDynamicExpander({
        source: resolvedSource!,
        originalPrompt: prompt,
        prefetchedSourceContent,
        project: sourceToProjectProject!,
        mode: sourceToProjectMode!,
        maxOpportunities: sourceToProjectProject!.maxOpportunities ?? typedConfig.sourceToProject.maxOpportunities,
        thresholds: {
          ...typedConfig.sourceToProject.thresholds,
          ...sourceToProjectProject!.thresholds,
        },
      })
      : undefined,
    logger: workflowLoggerModule.createInMemoryMacroWorkflowLogger(),
    onStateChange: (nextState, event) => {
      const stateWithRun = {
        ...nextState,
        runId: runDescriptor.runId,
        runName: runDescriptor.runName,
      };
      if (event.type === MacroWorkflowEventKind.NODE_FAILED && event.nodeId) {
        const failedResult = stateWithRun.nodeResults.find((result) => result.nodeId === event.nodeId);
        const failedNode = stateWithRun.currentPlan.nodes.find((node) => node.id === event.nodeId)
          ?? stateWithRun.plan.nodes.find((node) => node.id === event.nodeId);
        process.stderr.write(formatWorkflowNodeFailureMessage({
          nodeId: event.nodeId,
          title: failedNode?.title,
          status: failedResult?.status ?? event.status,
          error: failedResult?.error,
          output: failedResult?.output,
        }));
      }
      stateSnapshotWrite = stateSnapshotWrite.then(async () => {
        await workflowArtifactsModule.writeMacroWorkflowStateArtifact(runDescriptor.outputDir, stateWithRun);
      });
      if (dashboardServer) {
        dashboardServer.publishState(stateWithRun, event, replayEvents);
        return;
      }
      if (dashboardPublisher) {
        void dashboardPublisher.publishState(stateWithRun, event, replayEvents).catch((error) => {
          process.stderr.write(`[weavekit] Dashboard update failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      }
    },
    onReplayEvent: (event) => {
      replayEvents.push(event);
      replayEventWrite = replayEventWrite.then(async () => {
        await workflowArtifactsModule.appendWorkflowReplayEvent(runDescriptor.outputDir, event);
      });
    },
  });
  await stateSnapshotWrite;
  await replayEventWrite;
  state.runId = runDescriptor.runId;
  state.runName = runDescriptor.runName;
  state.usage = usageCollector.summarize();
  await workflowArtifactsModule.writeMacroWorkflowArtifacts({ outputDir: runDescriptor.outputDir, state, replayEvents });
  process.stderr.write(workflowUsageModule.renderWorkflowUsageSummary(state.usage));
  if (dashboardServer) {
    await dashboardServer.stop();
  }
  return [formatWorkflowCliSuccessMessage({ outputDir: runDescriptor.outputDir }), dashboardServer ? `Dashboard: ${dashboardServer.url}` : args.dashboardUrl ? `Dashboard: ${args.dashboardUrl}` : ""].filter(Boolean).join("\n");
}

function findPrefetchedXPostContent(fetchedXPosts: XPostFetchResult[], source: string | undefined): string | undefined {
  if (!source || fetchedXPosts.length === 0) {
    return undefined;
  }
  const sourceUrls = extractXPostUrls(source);
  const sourceKeys = new Set(sourceUrls.length > 0 ? sourceUrls : [source]);
  return fetchedXPosts.find((post) => sourceKeys.has(post.url))?.markdown;
}

function createXArticleSummaryHarnessRegistry(workflowHarnessModule: typeof import("./macro-workflow/harness.js")) {
  return workflowHarnessModule.createStaticHarnessRegistry({
    [WorkflowHarnessKind.COPILOT_SDK]: async (node) => {
      const articleMarkdown = extractResolvedXArticleMarkdown(node.prompt) ?? node.prompt;
      const summary = summarizeMarkdown(articleMarkdown);
      return {
        status: "passed" as const,
        output: [
          `Summary: ${summary}`,
          "",
          "Source content was supplied by workflow prompt preprocessing.",
        ].join("\n"),
        payload: {
          summary,
          articleMarkdown,
        },
        execution: {
          executor: "deterministic",
          operation: "SummarizeXArticle",
          mode: "report",
          prompt: node.prompt,
          model: "deterministic",
        },
      };
    },
  });
}

function extractResolvedXArticleMarkdown(prompt: string): string | undefined {
  const resolvedSectionIndex = prompt.indexOf("## Resolved X Post Sources");
  if (resolvedSectionIndex === -1) {
    return undefined;
  }
  const resolvedSection = prompt.slice(resolvedSectionIndex);
  const articleMatch = resolvedSection.match(/###\s+https?:\/\/[^\n]+\n+([\s\S]+)/u);
  return articleMatch?.[1]?.trim() || undefined;
}

function summarizeMarkdown(markdown: string): string {
  const articleBody = markdown.match(/(?:^|\n)---\s*\n([\s\S]+)/u)?.[1] ?? markdown;
  const lines = articleBody
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const title = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "))
    ?.replace(/^#+\s*/u, "");
  const body = lines
    .filter((line) => !line.startsWith("#"))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  const clippedBody = body.length > 240 ? `${body.slice(0, 237).trimEnd()}...` : body;
  return [title, clippedBody].filter(Boolean).join(": ") || "No resolved article content was available.";
}

export async function main(): Promise<void> {
  loadLocalEnvFiles();
  loadWeavekitConfig();

  let telemetry: TelemetryHandle = noopTelemetryHandle;
  try {
    const { startTelemetry } = await import("./telemetry/bootstrap.js");
    telemetry = await startTelemetry("weavekit");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Telemetry startup failed: ${message}\n`);
  }

  try {
    const argv = process.argv.slice(2);
    if (argv[0] === "workflow") {
      const workflowArgs = parseWorkflowCliArgs(argv);
      const message = await runWorkflowCli(workflowArgs);
      process.stdout.write(message);
    } else if (argv[0] === "entity") {
      const entityArgs = parseEntityCliArgs(argv);
      const message = await runEntityCli(entityArgs);
      process.stdout.write(message);
    } else {
      const { DecisionCouncilRunFailedError } = await import("./decision-council/errors.js");
      const { createSmokeModelRouter } = await import("./decision-council/modelRouter.js");
      const { runDecisionCouncil } = await import("./decision-council/runner.js");
      const args = parseDecisionCouncilCliArgs(argv);
      const input = await readDecisionCouncilInputFile(args.inputPath);
      const report = await runDecisionCouncil(input, {
        outputDir: args.outputDir,
        inputPath: args.inputPath,
        maxRounds: args.maxRounds,
        smoke: args.smoke,
        router: args.smoke ? createSmokeModelRouter() : undefined,
        logger: await createDecisionCouncilLogger(args.logFormat),
      });

      process.stdout.write(formatDecisionCouncilSuccessMessage({ recommendation: report.recommendation, outputDir: args.outputDir }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof DecisionCouncilRunFailedError ? error.exitCode : 1;
  } finally {
    try {
      await telemetry.shutdown();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Telemetry shutdown failed: ${message}\n`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof DecisionCouncilRunFailedError ? error.exitCode : 1;
  });
}
