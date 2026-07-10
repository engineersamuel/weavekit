#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  DeepResearchProvider,
  expandHomePath,
  loadLocalEnvFiles,
  loadTypedWeavekitConfig,
  loadWeavekitConfig,
  resolveProjectCatalogEntry,
  type DeepResearchDefaults,
  type ProjectCatalogEntry,
  type SourceToProjectDefaults,
  type WeavekitConfig,
} from "./config.js";
import { DecisionCouncilRunFailedError } from "./decision-council/errors.js";
import type { DecisionCouncilInput } from "./decision-council/types.js";
import type { DecisionCouncilLogger } from "./decision-council/logger.js";
import type { TelemetryHandle } from "./telemetry/bootstrap.js";
import {
  WorkflowHarnessKind,
  MacroWorkflowResumeContextVersion,
  WorkflowNodeStatus,
  type MacroWorkflowResumeContext,
  type MacroWorkflowRunState,
  type MacroWorkflowRunStateLike,
  type RuntimeWorkflowNode,
  type WorkflowArtifactRef,
  type WorkflowPlanTemplateId,
} from "./macro-workflow/types.js";
import { MacroWorkflowEventKind } from "./macro-workflow/logger.js";
import { MacroWorkflowStateStore } from "./macro-workflow/stateStore.js";
import {
  extractXPostUrls,
  preprocessWorkflowPrompt,
  type XPostFetchResult,
} from "./macro-workflow/promptPreprocessor.js";

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
  noCache?: boolean;
  dashboard?: boolean;
  dashboardPort?: number;
  dashboardUrl?: string;
  watchDir?: string;
  template?: string;
  source?: string;
  project?: string;
  projectPath?: string;
  mode?: "advisory" | "autonomous-pr";
  deepResearch?: Partial<DeepResearchDefaults>;
  configPath?: string;
  templateCandidateRunId?: string;
  templateCandidateId?: string;
  templateCandidateRunsRoot?: string;
  budgetOverrideReason?: string;
  resumeRunId?: string;
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
  const { formatEntityValidationErrors, validateEntityCatalog } =
    await import("./entities/index.js");
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
    throw new Error(
      [
        `Workflow metadata validation failed with ${workflowValidation.issues.length} error(s).`,
        "",
        ...workflowValidation.issues.map(
          (issue, index) =>
            `${index + 1}. ${issue.nodeId ?? "<plan>"} ${issue.code}: ${issue.message}`,
        ),
      ].join("\n"),
    );
  }
  const verificationOptimizerPlan = materializeWorkflowPlan("verification-optimizer", {
    objective: "Validate verification-optimizer workflow metadata",
    project: "weavekit",
    mode: "advisory",
  });
  const verificationOptimizerValidation = verifyWorkflowPlan(verificationOptimizerPlan);
  if (!verificationOptimizerValidation.valid) {
    throw new Error(
      [
        `Verification optimizer workflow metadata validation failed with ${verificationOptimizerValidation.issues.length} error(s).`,
        "",
        ...verificationOptimizerValidation.issues.map(
          (issue, index) =>
            `${index + 1}. ${issue.nodeId ?? "<plan>"} ${issue.code}: ${issue.message}`,
        ),
      ].join("\n"),
    );
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
    throw new Error(
      "Static persona sets are not supported. Usage: weavekit decision-council run --input <path> [--output <dir>] [--max-rounds <n>] [--smoke] [--log-format <pretty|json|silent>]",
    );
  }

  // --smoke is a runtime preset only: dynamic selection still chooses personas.
  if (smoke && maxRounds === undefined) {
    maxRounds = 1;
  }

  return {
    inputPath: argv[inputIndex + 1]!,
    outputDir: outputIndex === -1 ? "runs/latest" : (argv[outputIndex + 1] ?? "runs/latest"),
    logFormat,
    maxRounds,
    smoke,
  };
}

export function parseWorkflowCliArgs(argv: string[]): WorkflowCliArgs {
  if (argv[0] !== "workflow") {
    throw new Error(
      "Usage: weavekit workflow <plan|run|dashboard> [--input <path>|--prompt <text>] [--output <dir>] [--template <id>] [--dry-run] [--no-cache] [--dashboard] [--dashboard-port <port>] [--dashboard-url <url>] [--watch-dir <dir>]",
    );
  }

  const command = argv[1];
  if (command !== "plan" && command !== "run" && command !== "dashboard") {
    throw new Error(
      "Usage: weavekit workflow <plan|run|dashboard> [--input <path>|--prompt <text>] [--output <dir>] [--template <id>] [--dry-run] [--no-cache] [--dashboard] [--dashboard-port <port>] [--dashboard-url <url>] [--watch-dir <dir>]",
    );
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
  const providersIndex = argv.indexOf("--providers");
  const maxIterationsIndex = argv.indexOf("--max-iterations");
  const questionsPerIterationIndex = argv.indexOf("--questions-per-iteration");
  const maxResultsPerQuestionIndex = argv.indexOf("--max-results-per-question");
  const providerRetryAttemptsIndex = argv.indexOf("--provider-retry-attempts");
  const templateCandidateRunIndex = argv.indexOf("--template-candidate-run");
  const templateCandidateIndex = argv.indexOf("--template-candidate");
  const templateCandidateRunsRootIndex = argv.indexOf("--template-candidate-runs-root");
  const budgetOverrideIndex = argv.indexOf("--budget-override");
  const resumeIndex = argv.indexOf("--resume");

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
  if (providersIndex !== -1 && !argv[providersIndex + 1]) {
    throw new Error("Missing value for --providers <comma-separated-providers>.");
  }
  if (maxIterationsIndex !== -1 && !argv[maxIterationsIndex + 1]) {
    throw new Error("Missing value for --max-iterations <n>.");
  }
  if (questionsPerIterationIndex !== -1 && !argv[questionsPerIterationIndex + 1]) {
    throw new Error("Missing value for --questions-per-iteration <n>.");
  }
  if (maxResultsPerQuestionIndex !== -1 && !argv[maxResultsPerQuestionIndex + 1]) {
    throw new Error("Missing value for --max-results-per-question <n>.");
  }
  if (providerRetryAttemptsIndex !== -1 && !argv[providerRetryAttemptsIndex + 1]) {
    throw new Error("Missing value for --provider-retry-attempts <n>.");
  }
  if (argv.includes("--visualize") && argv.includes("--no-visualize")) {
    throw new Error("Use either --visualize or --no-visualize, not both.");
  }
  if (templateCandidateRunIndex !== -1 && !argv[templateCandidateRunIndex + 1]) {
    throw new Error("Missing value for --template-candidate-run <run-id>.");
  }
  if (templateCandidateIndex !== -1 && !argv[templateCandidateIndex + 1]) {
    throw new Error("Missing value for --template-candidate <candidate-id>.");
  }
  if (templateCandidateRunsRootIndex !== -1 && !argv[templateCandidateRunsRootIndex + 1]) {
    throw new Error("Missing value for --template-candidate-runs-root <path>.");
  }
  if (promptIndex !== -1 && !argv[promptIndex + 1]) {
    throw new Error("Missing value for --prompt <text>.");
  }
  if (budgetOverrideIndex !== -1 && !argv[budgetOverrideIndex + 1]) {
    throw new Error("Missing value for --budget-override <reason>.");
  }
  if (resumeIndex !== -1 && !argv[resumeIndex + 1]) {
    throw new Error("Missing value for --resume <run-id>.");
  }
  if (resumeIndex !== -1 && command !== "run") {
    throw new Error("--resume <run-id> is only supported by workflow run.");
  }

  const template = templateIndex === -1 ? undefined : argv[templateIndex + 1];
  const isSourceToProject = template === "source-to-project";
  const isVerificationOptimizer = template === "verification-optimizer";
  const isProjectScopedTemplate = isSourceToProject || isVerificationOptimizer;
  if (
    command !== "dashboard" &&
    inputIndex === -1 &&
    promptIndex === -1 &&
    resumeIndex === -1 &&
    !isProjectScopedTemplate
  ) {
    throw new Error("Missing required --input <path> or --prompt <text> argument.");
  }
  if (command !== "dashboard" && inputIndex !== -1 && !argv[inputIndex + 1]) {
    throw new Error("Missing value for --input <path>.");
  }
  if (command !== "dashboard" && inputIndex !== -1 && promptIndex !== -1) {
    throw new Error("Use either --input <path> or --prompt <text>, not both.");
  }
  if (resumeIndex !== -1 && (inputIndex !== -1 || promptIndex !== -1)) {
    throw new Error(
      "A resumed workflow reads its objective from state; omit --input and --prompt.",
    );
  }
  if (
    command !== "dashboard" &&
    resumeIndex === -1 &&
    isProjectScopedTemplate &&
    projectIndex === -1 &&
    projectPathIndex === -1
  ) {
    throw new Error("Missing required --project <id> or --project-path <path> argument.");
  }

  const dryRun = command === "plan" || argv.includes("--dry-run");
  const noCache = argv.includes("--no-cache");
  const portValue = portIndex === -1 ? undefined : Number(argv[portIndex + 1]);
  const dashboardPortValue =
    dashboardPortIndex === -1 ? portValue : Number(argv[dashboardPortIndex + 1]);
  const dashboard =
    command !== "dashboard" && (argv.includes("--dashboard") || dashboardPortValue !== undefined);
  const dashboardUrl = dashboardUrlIndex === -1 ? undefined : argv[dashboardUrlIndex + 1];
  const watchDir = watchDirIndex === -1 ? undefined : argv[watchDirIndex + 1];
  const mode = modeIndex === -1 ? undefined : argv[modeIndex + 1];

  if (
    dashboardPortValue !== undefined &&
    (!Number.isInteger(dashboardPortValue) || dashboardPortValue < 1 || dashboardPortValue > 65535)
  ) {
    throw new Error("Invalid --dashboard-port value. Expected an integer between 1 and 65535.");
  }
  if (mode !== undefined && mode !== "advisory" && mode !== "autonomous-pr") {
    throw new Error("Invalid --mode value. Expected advisory or autonomous-pr.");
  }

  const parsed: WorkflowCliArgs = {
    command,
    outputDir: outputIndex === -1 ? "runs" : (argv[outputIndex + 1] ?? "runs"),
    staticTemplate: template !== undefined,
    dryRun,
    noCache,
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
  const deepResearch = parseDeepResearchCliConfig({
    providers: providersIndex === -1 ? undefined : argv[providersIndex + 1],
    maxIterations: maxIterationsIndex === -1 ? undefined : argv[maxIterationsIndex + 1],
    questionsPerIteration:
      questionsPerIterationIndex === -1 ? undefined : argv[questionsPerIterationIndex + 1],
    maxResultsPerQuestion:
      maxResultsPerQuestionIndex === -1 ? undefined : argv[maxResultsPerQuestionIndex + 1],
    providerRetryAttempts:
      providerRetryAttemptsIndex === -1 ? undefined : argv[providerRetryAttemptsIndex + 1],
    visualize: argv.includes("--visualize")
      ? true
      : argv.includes("--no-visualize")
        ? false
        : undefined,
  });
  if (Object.keys(deepResearch).length > 0) {
    parsed.deepResearch = deepResearch;
  }
  if (templateCandidateRunIndex !== -1) {
    parsed.templateCandidateRunId = argv[templateCandidateRunIndex + 1];
  }
  if (templateCandidateIndex !== -1) {
    parsed.templateCandidateId = argv[templateCandidateIndex + 1];
  }
  if (templateCandidateRunsRootIndex !== -1) {
    parsed.templateCandidateRunsRoot = argv[templateCandidateRunsRootIndex + 1];
  }
  if (budgetOverrideIndex !== -1) {
    parsed.budgetOverrideReason = argv[budgetOverrideIndex + 1];
  }
  if (resumeIndex !== -1) {
    parsed.resumeRunId = argv[resumeIndex + 1];
  }
  return parsed;
}

export async function readDecisionCouncilInputFile(
  inputPath: string,
): Promise<DecisionCouncilInput> {
  const prompt = await readFile(inputPath, "utf8");
  return { prompt, context: [], constraints: [] };
}

export function formatDecisionCouncilSuccessMessage(args: {
  recommendation: string;
  outputDir: string;
}): string {
  return [
    args.recommendation,
    `Markdown report: ${join(args.outputDir, "DecisionCouncilReport.md")}`,
    `Artifacts written to ${args.outputDir}`,
    "",
  ].join("\n");
}

export async function createDecisionCouncilLogger(
  format: LogFormat,
): Promise<DecisionCouncilLogger> {
  const {
    createConsoleDecisionCouncilLogger,
    createJsonDecisionCouncilLogger,
    createSilentDecisionCouncilLogger,
  } = await import("./decision-council/logger.js");
  if (format === "json") return createJsonDecisionCouncilLogger();
  if (format === "silent") return createSilentDecisionCouncilLogger();
  return createConsoleDecisionCouncilLogger();
}

export function formatWorkflowCliSuccessMessage(args: { outputDir: string }): string {
  return [`Macro workflow plan: ${args.outputDir}`, ""].join("\n");
}

export function formatWorkflowRunStartedMessage(args: {
  runId: string;
  outputDir: string;
}): string {
  return (
    [
      `[weavekit] Workflow run id: ${args.runId}`,
      `[weavekit] Workflow output: ${args.outputDir}`,
    ].join("\n") + "\n"
  );
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

export function formatWorkflowNodeStartedMessage(args: {
  nodeId: string;
  title?: string;
  harness?: string;
  kind?: string;
}): string {
  return (
    [
      `[weavekit] Node started: ${formatWorkflowNodeLabel(args.nodeId, args.title)}`,
      args.harness ? `harness=${args.harness}` : undefined,
      args.kind ? `kind=${args.kind}` : undefined,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" ") + "\n"
  );
}

export function formatWorkflowNodeWarningMessage(args: {
  nodeId: string;
  title?: string;
  warning?: string;
}): string {
  return (
    [
      `[weavekit][warn] Workflow node warning: ${formatWorkflowNodeLabel(args.nodeId, args.title)}`,
      args.warning ? `[weavekit][warn] Warning: ${args.warning}` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n") + "\n"
  );
}

export function formatWorkflowNodeCompletedMessage(args: {
  nodeId: string;
  title?: string;
  status?: string;
  output?: string;
  artifacts?: WorkflowArtifactRef[];
}): string {
  const lines = [
    [
      `[weavekit] Node ${args.status ?? "completed"}: ${formatWorkflowNodeLabel(args.nodeId, args.title)}`,
      args.output ? `output=${truncateOneLine(args.output, 220)}` : undefined,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" "),
    ...(args.artifacts ?? []).map(
      (artifact) =>
        `[weavekit]   artifact ${artifact.kind}: ${artifact.path} - ${artifact.description}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

export function formatWorkflowRunCompletedMessage(args: {
  status?: string;
  outputDir: string;
}): string {
  return `[weavekit] Workflow completed with status=${args.status ?? "unknown"} output=${args.outputDir}\n`;
}

function formatWorkflowNodeLabel(nodeId: string, title: string | undefined): string {
  return title ? `${title} (${nodeId})` : nodeId;
}

function truncateOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trimEnd()}...`
    : normalized;
}

export function createWorkflowRunDescriptor(
  outputRoot: string,
  objective: string,
  existingRunId?: string,
): WorkflowRunDescriptor {
  if (existingRunId && !isValidWorkflowRunId(existingRunId)) {
    throw new Error(`Invalid workflow run id: ${existingRunId}`);
  }
  const runId = existingRunId ?? randomUUID();
  const normalizedRoot = basename(outputRoot) === "latest" ? dirname(outputRoot) : outputRoot;
  return {
    runId,
    runName: generateWorkflowRunName(objective),
    outputDir: join(normalizedRoot, runId),
  };
}

function isValidWorkflowRunId(runId: string): boolean {
  return runId !== "." && runId !== ".." && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(runId);
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
  return words
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

function resolveWorkflowTemplateId(
  template: string | undefined,
): WorkflowPlanTemplateId | undefined {
  if (template === undefined) {
    return undefined;
  }
  if (
    template !== "implementation-review" &&
    template !== "source-to-project" &&
    template !== "verification-optimizer" &&
    template !== "x-article-summary" &&
    template !== "deep-research"
  ) {
    throw new Error(`Unknown workflow template: ${template}`);
  }
  return template;
}

function resolveMacroWorkflowResumeContext(args: {
  state: MacroWorkflowRunState;
  cli: WorkflowCliArgs;
  templateId: WorkflowPlanTemplateId;
  config: WeavekitConfig;
}): MacroWorkflowResumeContext {
  const persisted = args.state.resumeContext;
  if (!persisted) {
    return createLegacyResumeContext(args.cli, args.templateId, args.config, args.state.runId);
  }
  if (persisted.version !== MacroWorkflowResumeContextVersion) {
    throw new Error(
      `Cannot resume workflow ${args.state.runId}: unsupported resumeContext version ${String(persisted.version)}.`,
    );
  }
  if (persisted.templateId !== args.templateId) {
    throw new Error(
      `Cannot resume workflow ${args.state.runId}: resumeContext template ${persisted.templateId} conflicts with persisted plan template ${args.templateId}.`,
    );
  }

  assertResumeFlagMatches("--source", args.cli.source, persisted.source);
  assertResumeFlagMatches("--project", args.cli.project, persisted.project);
  assertResumeFlagMatches("--project-path", args.cli.projectPath, persisted.projectPath);
  assertResumeFlagMatches("--mode", args.cli.mode, persisted.mode);
  assertDeepResearchResumeFlags(args.cli.deepResearch, persisted.deepResearch);
  assertCompleteResumeContext(persisted, args.state.runId);
  return persisted;
}

function createLegacyResumeContext(
  cli: WorkflowCliArgs,
  templateId: WorkflowPlanTemplateId,
  config: WeavekitConfig,
  runId: string | undefined,
): MacroWorkflowResumeContext {
  const base = {
    version: MacroWorkflowResumeContextVersion,
    templateId,
  } as const;
  if (templateId === "implementation-review") {
    return base;
  }
  if (templateId === "x-article-summary") {
    if (!cli.source) {
      throw new Error(
        `Cannot resume legacy workflow ${runId ?? "unknown"}: missing resumeContext. Required flag: --source <url-or-path>.`,
      );
    }
    return { ...base, source: cli.source };
  }
  if (templateId === "deep-research") {
    const deepResearch = readCompleteLegacyDeepResearchFlags(cli.deepResearch, runId);
    return { ...base, deepResearch };
  }

  const required: string[] = [];
  if (templateId === "source-to-project" && !cli.source) required.push("--source <url-or-path>");
  if (!cli.project && !cli.projectPath) required.push("--project <id> or --project-path <path>");
  if (!cli.mode) required.push("--mode <advisory|autonomous-pr>");
  if (required.length > 0) {
    throw new Error(
      `Cannot resume legacy workflow ${runId ?? "unknown"}: missing resumeContext. Required flags: ${required.join(", ")}.`,
    );
  }
  const resolvedProject = cli.project
    ? resolveProjectCatalogEntry(config, cli.project)
    : createProjectCatalogEntryFromPath(cli.projectPath!);
  if (templateId === "source-to-project") {
    return {
      ...base,
      source: cli.source,
      project: cli.project,
      projectPath: cli.projectPath,
      mode: cli.mode,
      resolvedProject,
      sourceToProject: selectSourceToProjectResumeSettings(config.sourceToProject),
    };
  }
  return {
    ...base,
    project: cli.project,
    projectPath: cli.projectPath,
    mode: cli.mode,
    resolvedProject,
    verificationOptimizer: { ...structuredClone(config.verificationOptimizer), mode: cli.mode! },
    ...(config.verificationOptimizer.externalResearch
      ? { deepResearch: structuredClone(config.deepResearch) }
      : {}),
  };
}

function createMacroWorkflowResumeContext(args: {
  templateId: WorkflowPlanTemplateId;
  source?: string;
  project?: string;
  projectPath?: string;
  mode?: "advisory" | "autonomous-pr";
  resolvedProject?: ProjectCatalogEntry;
  sourceToProject: SourceToProjectDefaults;
  verificationOptimizer: WeavekitConfig["verificationOptimizer"];
  deepResearch: DeepResearchDefaults;
}): MacroWorkflowResumeContext {
  const base = {
    version: MacroWorkflowResumeContextVersion,
    templateId: args.templateId,
  } as const;
  if (args.templateId === "source-to-project") {
    return {
      ...base,
      source: args.source,
      project: args.project,
      projectPath: args.projectPath,
      mode: args.mode,
      resolvedProject: args.resolvedProject,
      sourceToProject: selectSourceToProjectResumeSettings(args.sourceToProject),
    };
  }
  if (args.templateId === "verification-optimizer") {
    return {
      ...base,
      project: args.project,
      projectPath: args.projectPath,
      mode: args.mode,
      resolvedProject: args.resolvedProject,
      verificationOptimizer: structuredClone(args.verificationOptimizer),
      ...(args.verificationOptimizer.externalResearch
        ? { deepResearch: structuredClone(args.deepResearch) }
        : {}),
    };
  }
  if (args.templateId === "deep-research") {
    return { ...base, deepResearch: structuredClone(args.deepResearch) };
  }
  if (args.templateId === "x-article-summary") {
    return { ...base, source: args.source };
  }
  return base;
}

function selectSourceToProjectResumeSettings(
  config: SourceToProjectDefaults,
): NonNullable<MacroWorkflowResumeContext["sourceToProject"]> {
  return {
    maxOpportunities: config.maxOpportunities,
    thresholds: structuredClone(config.thresholds),
    offline: config.offline,
    copilotModel: config.copilotModel,
    timeoutMs: config.timeoutMs,
    maxToolCalls: config.maxToolCalls,
    sourceReadingMaxToolCalls: config.sourceReadingMaxToolCalls,
    projectResearchMaxToolCalls: config.projectResearchMaxToolCalls,
    budgetGate: config.budgetGate ? structuredClone(config.budgetGate) : undefined,
    autoImplementOnReport: config.autoImplementOnReport,
  };
}

function assertResumeFlagMatches(
  flag: string,
  provided: string | undefined,
  persisted: string | undefined,
): void {
  if (provided !== undefined && provided !== persisted) {
    throw new Error(
      `Resume flag ${flag} conflicts with persisted workflow context: expected ${persisted ?? "<unset>"}, received ${provided}.`,
    );
  }
}

function assertDeepResearchResumeFlags(
  provided: Partial<DeepResearchDefaults> | undefined,
  persisted: DeepResearchDefaults | undefined,
): void {
  if (!provided) return;
  for (const [key, value] of Object.entries(provided) as Array<
    [keyof DeepResearchDefaults, DeepResearchDefaults[keyof DeepResearchDefaults]]
  >) {
    const expected = persisted?.[key];
    if (JSON.stringify(value) !== JSON.stringify(expected)) {
      const flag = deepResearchFlagName(key);
      const renderedExpected = Array.isArray(expected) ? expected.join(",") : String(expected);
      throw new Error(
        `Resume flag ${flag} conflicts with persisted workflow context: expected ${renderedExpected}, received ${Array.isArray(value) ? value.join(",") : String(value)}.`,
      );
    }
  }
}

function deepResearchFlagName(key: keyof DeepResearchDefaults): string {
  return {
    providers: "--providers",
    maxIterations: "--max-iterations",
    questionsPerIteration: "--questions-per-iteration",
    maxResultsPerQuestion: "--max-results-per-question",
    providerRetryAttempts: "--provider-retry-attempts",
    visualize: "--visualize/--no-visualize",
  }[key];
}

function readCompleteLegacyDeepResearchFlags(
  provided: Partial<DeepResearchDefaults> | undefined,
  runId: string | undefined,
): DeepResearchDefaults {
  const required = [
    "providers",
    "maxIterations",
    "questionsPerIteration",
    "maxResultsPerQuestion",
    "providerRetryAttempts",
    "visualize",
  ] as const satisfies ReadonlyArray<keyof DeepResearchDefaults>;
  const missing = required.filter((key) => provided?.[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Cannot resume legacy workflow ${runId ?? "unknown"}: missing resumeContext. Required deep-research flags: ${missing.map(deepResearchFlagName).join(", ")}.`,
    );
  }
  return structuredClone(provided) as DeepResearchDefaults;
}

function assertCompleteResumeContext(
  context: MacroWorkflowResumeContext,
  runId: string | undefined,
): void {
  const missing: string[] = [];
  if (context.templateId === "source-to-project") {
    if (!context.source) missing.push("source");
    if (!context.resolvedProject) missing.push("resolvedProject");
    if (!context.mode) missing.push("mode");
    if (!context.sourceToProject) missing.push("sourceToProject");
  } else if (context.templateId === "verification-optimizer") {
    if (!context.resolvedProject) missing.push("resolvedProject");
    if (!context.mode) missing.push("mode");
    if (!context.verificationOptimizer) missing.push("verificationOptimizer");
    if (context.verificationOptimizer?.externalResearch && !context.deepResearch) {
      missing.push("deepResearch");
    }
  } else if (context.templateId === "deep-research" && !context.deepResearch) {
    missing.push("deepResearch");
  } else if (context.templateId === "x-article-summary" && !context.source) {
    missing.push("source");
  }
  if (missing.length > 0) {
    throw new Error(
      `Cannot resume workflow ${runId ?? "unknown"}: persisted resumeContext is incomplete; missing ${missing.join(", ")}.`,
    );
  }
}

function parseDeepResearchCliConfig(args: {
  providers?: string;
  maxIterations?: string;
  questionsPerIteration?: string;
  maxResultsPerQuestion?: string;
  providerRetryAttempts?: string;
  visualize?: boolean;
}): Partial<DeepResearchDefaults> {
  const config: Partial<DeepResearchDefaults> = {};
  if (args.providers !== undefined) {
    const providers = args.providers
      .split(",")
      .map((provider) => provider.trim())
      .filter(Boolean)
      .map((provider) => {
        const normalized = provider.toLowerCase();
        if (normalized === DeepResearchProvider.EXA) return DeepResearchProvider.EXA;
        if (normalized === DeepResearchProvider.GROK) return DeepResearchProvider.GROK;
        if (normalized === DeepResearchProvider.TAVILY) return DeepResearchProvider.TAVILY;
        if (normalized === DeepResearchProvider.PERPLEXITY) return DeepResearchProvider.PERPLEXITY;
        if (normalized === DeepResearchProvider.COPILOT_LAST30DAYS)
          return DeepResearchProvider.COPILOT_LAST30DAYS;
        throw new Error(
          `Invalid --providers value: ${provider}. Expected exa, grok, tavily, perplexity, or copilot-last30days.`,
        );
      });
    if (providers.length === 0) {
      throw new Error("Invalid --providers value. Expected at least one provider.");
    }
    config.providers = [...new Set(providers)];
  }
  if (args.maxIterations !== undefined) {
    config.maxIterations = parsePositiveIntegerFlag("--max-iterations", args.maxIterations);
  }
  if (args.questionsPerIteration !== undefined) {
    config.questionsPerIteration = parsePositiveIntegerFlag(
      "--questions-per-iteration",
      args.questionsPerIteration,
    );
  }
  if (args.maxResultsPerQuestion !== undefined) {
    config.maxResultsPerQuestion = parsePositiveIntegerFlag(
      "--max-results-per-question",
      args.maxResultsPerQuestion,
    );
  }
  if (args.providerRetryAttempts !== undefined) {
    config.providerRetryAttempts = parsePositiveIntegerFlag(
      "--provider-retry-attempts",
      args.providerRetryAttempts,
    );
  }
  if (args.visualize !== undefined) {
    config.visualize = args.visualize;
  }
  return config;
}

function parsePositiveIntegerFlag(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${flag} value. Expected a positive integer.`);
  }
  return parsed;
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

function findWorkflowNode(
  currentPlan: { nodes: RuntimeWorkflowNode[] },
  originalPlan: { nodes: RuntimeWorkflowNode[] },
  nodeId: string,
): RuntimeWorkflowNode | undefined {
  return (
    currentPlan.nodes.find((node) => node.id === nodeId) ??
    originalPlan.nodes.find((node) => node.id === nodeId)
  );
}

export function createWorkflowProgressReporter(
  stream: Pick<NodeJS.WritableStream, "write"> = process.stderr,
) {
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
  skillName?: string;
  toolName?: string;
  toolCallCount?: number;
  maxToolCalls?: number;
};

export function formatWorkflowCopilotLog(event: WorkflowCopilotLogEvent): string {
  const severityPrefix = copilotLogSeverityPrefix(event.phase);
  const details = [
    event.mode ? `mode=${event.mode}` : undefined,
    event.model ? `model=${event.model}` : undefined,
    event.cwd ? `cwd=${event.cwd}` : undefined,
    event.eventType ? `event=${event.eventType}` : undefined,
    event.skillName ? `skill=${event.skillName}` : undefined,
    event.toolName ? `tool=${event.toolName}` : undefined,
    event.toolCallCount !== undefined ? `toolCalls=${event.toolCallCount}` : undefined,
    event.maxToolCalls !== undefined ? `maxToolCalls=${event.maxToolCalls}` : undefined,
    event.timeoutMs !== undefined ? `timeoutMs=${event.timeoutMs}` : undefined,
    event.elapsedMs !== undefined ? `elapsedMs=${event.elapsedMs}` : undefined,
    event.promptLength !== undefined ? `promptChars=${event.promptLength}` : undefined,
    event.contentLength !== undefined ? `contentChars=${event.contentLength}` : undefined,
    event.message ? `message=${event.message.replace(/\s+/g, " ").slice(0, 160)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return `${severityPrefix} ${event.phase}${details.length ? ` ${details.join(" ")}` : ""}\n`;
}

function copilotLogSeverityPrefix(phase: string): string {
  if (phase.includes("error") || phase === "timeout") {
    return "[weavekit][error][copilot-sdk]";
  }
  if (phase.includes("warning") || phase === "timeout-partial" || phase === "tool-budget") {
    return "[weavekit][warn][copilot-sdk]";
  }
  return "[weavekit][copilot-sdk]";
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
        dashboardServer
          .stop()
          .then(() => resolve())
          .catch((error) => {
            process.stderr.write(
              `Dashboard shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
            );
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

  const resumeDescriptor = args.resumeRunId
    ? createWorkflowRunDescriptor(args.outputDir, "Macro workflow", args.resumeRunId)
    : undefined;
  const resumedState = resumeDescriptor
    ? await readWorkflowResumeState(resumeDescriptor.outputDir, args.resumeRunId!)
    : undefined;
  if (resumedState) {
    assertResumableWorkflowState(resumedState, args.resumeRunId!);
    if (args.template && args.template !== resumedState.templateId) {
      throw new Error(
        `Cannot resume workflow ${args.resumeRunId} as template ${args.template}; persisted template is ${resumedState.templateId}.`,
      );
    }
  }

  if (
    !args.inputPath &&
    !args.prompt &&
    !resumedState &&
    args.template !== "source-to-project" &&
    args.template !== "verification-optimizer"
  ) {
    throw new Error("Missing required --input <path> or --prompt <text> argument.");
  }
  if (args.inputPath && args.prompt) {
    throw new Error("Use either --input <path> or --prompt <text>, not both.");
  }

  const promptWasUserProvided = Boolean(args.prompt || args.inputPath);
  const rawPrompt =
    resumedState?.objective ??
    args.prompt ??
    (args.inputPath
      ? await readFile(args.inputPath, "utf8")
      : `Source: ${args.source ?? ""}\nProject: ${args.project ?? args.projectPath ?? ""}`);
  const xPostUrlsToResolve = extractXPostUrls(
    [rawPrompt, args.source].filter((part): part is string => Boolean(part)).join("\n"),
  );
  if (xPostUrlsToResolve.length > 0) {
    process.stderr.write(
      `[weavekit] Resolving ${xPostUrlsToResolve.length} X post source${xPostUrlsToResolve.length === 1 ? "" : "s"} with grok...\n`,
    );
  }
  const preprocessedPrompt = resumedState
    ? { prompt: resumedState.objective, fetchedXPosts: [] }
    : await preprocessWorkflowPrompt({
        prompt: rawPrompt,
        source: args.source,
        cache: { ...typedConfig.cache, enabled: typedConfig.cache.enabled && !args.noCache },
      });
  if (xPostUrlsToResolve.length > 0) {
    process.stderr.write(
      `[weavekit] X post source${xPostUrlsToResolve.length === 1 ? "" : "s"} resolved.\n`,
    );
  }
  const prompt = preprocessedPrompt.prompt;
  const fetchedXPosts = preprocessedPrompt.fetchedXPosts;
  const objective = resumedState?.objective ?? (prompt.trim() || "Macro workflow");
  const generatedDescriptor = createWorkflowRunDescriptor(
    args.outputDir,
    objective,
    args.resumeRunId,
  );
  const runDescriptor = {
    ...generatedDescriptor,
    runName: resumedState?.runName ?? generatedDescriptor.runName,
  };
  const templateId = resolveWorkflowTemplateId(resumedState?.templateId ?? args.template);
  const isSourceToProject = templateId === "source-to-project";
  const isVerificationOptimizer = templateId === "verification-optimizer";
  const isDeepResearch = templateId === "deep-research";
  const resumeContext =
    resumedState && templateId
      ? resolveMacroWorkflowResumeContext({
          state: resumedState,
          cli: args,
          templateId,
          config: typedConfig,
        })
      : undefined;
  const effectiveProject = resumeContext?.project ?? args.project;
  const effectiveProjectPath = resumeContext?.projectPath ?? args.projectPath;
  const effectiveMode = resumeContext?.mode ?? args.mode;
  const resolvedSource = isSourceToProject
    ? (resumeContext?.source ??
      args.source ??
      inferSourceReferenceFromPrompt(prompt) ??
      (promptWasUserProvided ? prompt.trim() : undefined))
    : (resumeContext?.source ?? args.source);
  const sourceToProjectConfig: SourceToProjectDefaults = resumeContext?.sourceToProject
    ? {
        ...typedConfig.sourceToProject,
        ...resumeContext.sourceToProject,
        mode: resumeContext.mode ?? typedConfig.sourceToProject.mode,
        thresholds: resumeContext.sourceToProject.thresholds,
      }
    : {
        ...typedConfig.sourceToProject,
        mode: isSourceToProject
          ? (effectiveMode ?? typedConfig.sourceToProject.mode)
          : typedConfig.sourceToProject.mode,
      };
  const verificationOptimizerConfig =
    resumeContext?.verificationOptimizer ??
    (isVerificationOptimizer
      ? {
          ...typedConfig.verificationOptimizer,
          mode: effectiveMode ?? typedConfig.verificationOptimizer.mode,
        }
      : typedConfig.verificationOptimizer);
  const deepResearchConfig: DeepResearchDefaults =
    resumeContext?.deepResearch ?? ({ ...typedConfig.deepResearch, ...args.deepResearch } as const);
  let sourceToProjectProject: ProjectCatalogEntry | undefined;
  let sourceToProjectMode: "advisory" | "autonomous-pr" | undefined;
  let verificationOptimizerProject: ProjectCatalogEntry | undefined;
  let verificationOptimizerMode: "advisory" | "autonomous-pr" | undefined;
  if (isSourceToProject) {
    if (!resolvedSource) {
      throw new Error(
        "Missing source-to-project source. Provide --source <url-or-path>, include a URL/source:/blog: line in the prompt/input, or pass the source text directly as --prompt/--input.",
      );
    }
    if (!effectiveProject && !effectiveProjectPath) {
      throw new Error("Missing required --project <id> or --project-path <path> argument.");
    }
    sourceToProjectProject =
      resumeContext?.resolvedProject ??
      (effectiveProject
        ? resolveProjectCatalogEntry(typedConfig, effectiveProject)
        : createProjectCatalogEntryFromPath(effectiveProjectPath!));
    sourceToProjectMode = effectiveMode ?? sourceToProjectConfig.mode;
    if (sourceToProjectMode === "autonomous-pr" && !sourceToProjectProject.autonomousPrAllowed) {
      throw new Error(`Autonomous PR mode is disabled for project ${sourceToProjectProject.id}.`);
    }
  }
  if (isVerificationOptimizer) {
    if (!effectiveProject && !effectiveProjectPath) {
      throw new Error("Missing required --project <id> or --project-path <path> argument.");
    }
    verificationOptimizerProject =
      resumeContext?.resolvedProject ??
      (effectiveProject
        ? resolveProjectCatalogEntry(typedConfig, effectiveProject)
        : createProjectCatalogEntryFromPath(effectiveProjectPath!));
    verificationOptimizerMode = effectiveMode ?? verificationOptimizerConfig.mode;
    if (
      verificationOptimizerMode === "autonomous-pr" &&
      (!effectiveProject || !verificationOptimizerProject.autonomousPrAllowed)
    ) {
      throw new Error(
        `Autonomous PR mode is disabled for project ${verificationOptimizerProject.id}.`,
      );
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
    workflowDeepResearchModule,
    workflowVerificationOptimizerModule,
    workflowUsageModule,
    workflowNodeCostHistoryModule,
    workflowTemplateCandidateModule,
  ] = await Promise.all([
    import("./macro-workflow/artifacts.js"),
    import("./macro-workflow/bamlAdapters.js"),
    import("./macro-workflow/harness.js"),
    import("./macro-workflow/logger.js"),
    import("./macro-workflow/runner.js"),
    import("./macro-workflow/templates.js"),
    import("./macro-workflow/dashboardServer.js"),
    import("./macro-workflow/sourceToProject/harnesses.js"),
    import("./macro-workflow/deepResearch/harnesses.js"),
    import("./macro-workflow/verificationOptimizer/harnesses.js"),
    import("./macro-workflow/usage.js"),
    import("./macro-workflow/nodeCostHistory.js"),
    import("./macro-workflow/templateOptimizer/candidatePlan.js"),
  ]);
  const usageCollector = new workflowUsageModule.WorkflowUsageCollector(resumedState?.usage);
  const replayEvents = resumedState
    ? await workflowArtifactsModule.readWorkflowReplayEvents(runDescriptor.outputDir)
    : [];
  const planner = new workflowBamlAdapterModule.GeneratedWorkflowPlannerAdapter({ usageCollector });
  const progress = createWorkflowProgressReporter();
  let plan;
  let templateCandidate:
    | Awaited<ReturnType<typeof workflowTemplateCandidateModule.loadTemplateOptimizerCandidatePlan>>
    | undefined;

  if (resumedState) {
    plan = resumedState.currentPlan;
  } else {
    progress.start("Planning workflow DAG with the BAML planner...");
    try {
      if (args.templateCandidateRunId) {
        templateCandidate =
          await workflowTemplateCandidateModule.loadTemplateOptimizerCandidatePlan({
            runsRoot: args.templateCandidateRunsRoot ?? join("evals", "template-optimizer", "runs"),
            runId: args.templateCandidateRunId,
            candidateId: args.templateCandidateId,
          });
      }
      plan = templateCandidate
        ? workflowTemplateCandidateModule.materializeTemplateOptimizerCandidatePlan({
            candidate: templateCandidate,
            objective,
            runId: args.templateCandidateRunId!,
          })
        : templateId
          ? workflowTemplatesModule.materializeWorkflowPlan(templateId, {
              objective,
              source: resolvedSource,
              project: effectiveProject,
              projectPath: effectiveProjectPath,
              mode: sourceToProjectMode ?? verificationOptimizerMode ?? effectiveMode,
              externalResearch: isVerificationOptimizer
                ? verificationOptimizerConfig.externalResearch
                : undefined,
              providers: isDeepResearch ? deepResearchConfig.providers : undefined,
              maxIterations: isDeepResearch ? deepResearchConfig.maxIterations : undefined,
              questionsPerIteration: isDeepResearch
                ? deepResearchConfig.questionsPerIteration
                : undefined,
              maxResultsPerQuestion: isDeepResearch
                ? deepResearchConfig.maxResultsPerQuestion
                : undefined,
              providerRetryAttempts: isDeepResearch
                ? deepResearchConfig.providerRetryAttempts
                : undefined,
              visualize: isDeepResearch ? deepResearchConfig.visualize : undefined,
            })
          : await planner.planWorkflow({ objective, prompt, templateId: "implementation-review" });
      progress.stop("Workflow plan generated.");
    } catch (error) {
      progress.stop();
      throw error;
    }
  }

  const effectiveTemplateId = resolveWorkflowTemplateId(plan.templateId)!;
  const effectiveResumeContext =
    resumeContext ??
    createMacroWorkflowResumeContext({
      templateId: effectiveTemplateId,
      source: resolvedSource ?? inferSourceReferenceFromPrompt(prompt),
      project: effectiveProject,
      projectPath: effectiveProjectPath,
      mode: sourceToProjectMode ?? verificationOptimizerMode ?? effectiveMode,
      resolvedProject: sourceToProjectProject ?? verificationOptimizerProject,
      sourceToProject: sourceToProjectConfig,
      verificationOptimizer: verificationOptimizerConfig,
      deepResearch: deepResearchConfig,
    });
  const resumedInitialState = resumedState
    ? { ...resumedState, resumeContext: effectiveResumeContext }
    : undefined;

  if (args.command === "plan" || args.dryRun) {
    await workflowArtifactsModule.writeMacroWorkflowArtifacts({
      outputDir: runDescriptor.outputDir,
      state: {
        runId: runDescriptor.runId,
        runName: runDescriptor.runName,
        resumeContext: effectiveResumeContext,
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
      },
    });
    process.stderr.write(
      workflowUsageModule.renderWorkflowUsageSummary(usageCollector.summarize()),
    );
    return formatWorkflowCliSuccessMessage({ outputDir: runDescriptor.outputDir });
  }

  let dashboardServer:
    | Awaited<ReturnType<typeof workflowDashboardModule.createWorkflowDashboardServer>>
    | undefined;
  let dashboardPublisher:
    | Awaited<ReturnType<typeof workflowDashboardModule.createWorkflowDashboardPublisher>>
    | undefined;
  let replayEventWrite = Promise.resolve();
  let stateSnapshotWrite = Promise.resolve();
  const initialRunState: MacroWorkflowRunState = resumedInitialState ?? {
    runId: runDescriptor.runId,
    runName: runDescriptor.runName,
    resumeContext: effectiveResumeContext,
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
    await workflowArtifactsModule.writeMacroWorkflowStateArtifact(
      runDescriptor.outputDir,
      initialRunState,
    );
  });
  if (args.dashboard) {
    dashboardServer = await workflowDashboardModule.createWorkflowDashboardServer(initialRunState, {
      port: args.dashboardPort,
      watchDir: args.outputDir,
      configPath: args.configPath,
    });
  } else if (args.dashboardUrl) {
    dashboardPublisher = await workflowDashboardModule.createWorkflowDashboardPublisher(
      args.dashboardUrl,
    );
  }

  const sourceToProjectNotifier = isSourceToProject
    ? workflowSourceToProjectModule.createDefaultSourceToProjectNotifier()
    : undefined;

  const needsDeepResearchRuntime =
    isDeepResearch || (isVerificationOptimizer && verificationOptimizerConfig.externalResearch);
  const deepResearchExaMcp = needsDeepResearchRuntime
    ? await workflowDeepResearchModule.createDefaultDeepResearchExaMcpConnection()
    : undefined;

  try {
    const harnesses = isSourceToProject
      ? workflowSourceToProjectModule.createSourceToProjectHarnessRegistry({
          source: resolvedSource!,
          originalPrompt: prompt,
          prefetchedSourceContent,
          project: sourceToProjectProject!,
          mode: sourceToProjectMode!,
          maxOpportunities:
            sourceToProjectProject!.maxOpportunities ?? sourceToProjectConfig.maxOpportunities,
          thresholds: {
            ...sourceToProjectConfig.thresholds,
            ...sourceToProjectProject!.thresholds,
          },
          sourceToProject: sourceToProjectConfig,
          budgetOverrideReason: args.budgetOverrideReason,
          tooling: typedConfig.tooling,
          plugins: typedConfig.plugins,
          notifier: sourceToProjectNotifier,
          copilot: sourceToProjectConfig.offline
            ? workflowSourceToProjectModule.createOfflineSourceToProjectHarnessClient()
            : workflowSourceToProjectModule.createCopilotSdkHarnessClient({
                copilot: typedConfig.copilot,
                sourceToProject: sourceToProjectConfig,
                onUserInputRequest:
                  workflowSourceToProjectModule.createSourceToProjectUserInputRequestHandler({
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
          baml: sourceToProjectConfig.offline
            ? undefined
            : workflowSourceToProjectModule.createLiveSourceToProjectBamlClient({ usageCollector }),
        })
      : isDeepResearch
        ? workflowDeepResearchModule.createDeepResearchHarnessRegistry({
            config: deepResearchConfig,
            exaMcp: deepResearchExaMcp?.client,
            tooling: typedConfig.tooling,
            copilot: workflowSourceToProjectModule.createCopilotSdkHarnessClient({
              model: typedConfig.copilot.model ?? "gpt-5.5",
              copilot: typedConfig.copilot,
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
            baml: workflowDeepResearchModule.createLiveDeepResearchBamlClient({ usageCollector }),
          })
        : isVerificationOptimizer
          ? workflowVerificationOptimizerModule.createVerificationOptimizerHarnessRegistry({
              project: verificationOptimizerProject!,
              mode: verificationOptimizerMode!,
              verificationOptimizer: verificationOptimizerConfig,
              copilot: sourceToProjectConfig.offline
                ? workflowVerificationOptimizerModule.createOfflineVerificationOptimizerHarnessClient()
                : workflowSourceToProjectModule.createCopilotSdkHarnessClient({
                    copilot: typedConfig.copilot,
                    sourceToProject: sourceToProjectConfig,
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
              baml: sourceToProjectConfig.offline
                ? undefined
                : workflowVerificationOptimizerModule.createLiveVerificationOptimizerBamlClient({
                    usageCollector,
                  }),
              deepResearch: verificationOptimizerConfig.externalResearch
                ? {
                    config: deepResearchConfig,
                    exaMcp: deepResearchExaMcp?.client,
                    tooling: typedConfig.tooling,
                    copilot: workflowSourceToProjectModule.createCopilotSdkHarnessClient({
                      model: typedConfig.copilot.model ?? "gpt-5.5",
                      copilot: typedConfig.copilot,
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
                    baml: workflowDeepResearchModule.createLiveDeepResearchBamlClient({
                      usageCollector,
                    }),
                  }
                : undefined,
            })
          : templateId === "x-article-summary"
            ? createXArticleSummaryHarnessRegistry(workflowHarnessModule)
            : workflowHarnessModule.createStaticHarnessRegistry();

    const state = await workflowRunnerModule.runMacroWorkflow(plan, {
      initialState: resumedInitialState,
      initialReplaySeq: replayEvents.at(-1)?.seq ?? 0,
      harnesses,
      outputDir: runDescriptor.outputDir,
      replanner: planner,
      expandAfterNode: isSourceToProject
        ? templateCandidate
          ? workflowTemplateCandidateModule.createTemplateOptimizerCandidateDynamicExpander({
              candidate: templateCandidate,
              mode: sourceToProjectMode!,
              thresholds: {
                ...sourceToProjectConfig.thresholds,
                ...sourceToProjectProject!.thresholds,
              },
            })
          : workflowSourceToProjectModule.createSourceToProjectDynamicExpander({
              source: resolvedSource!,
              originalPrompt: prompt,
              prefetchedSourceContent,
              project: sourceToProjectProject!,
              mode: sourceToProjectMode!,
              maxOpportunities:
                sourceToProjectProject!.maxOpportunities ?? sourceToProjectConfig.maxOpportunities,
              thresholds: {
                ...sourceToProjectConfig.thresholds,
                ...sourceToProjectProject!.thresholds,
              },
            })
        : isDeepResearch
          ? workflowDeepResearchModule.createDeepResearchDynamicExpander()
          : isVerificationOptimizer
            ? workflowVerificationOptimizerModule.createVerificationOptimizerDynamicExpander({
                project: verificationOptimizerProject!,
                mode: verificationOptimizerMode!,
                verificationOptimizer: verificationOptimizerConfig,
              })
            : undefined,
      logger: workflowLoggerModule.createInMemoryMacroWorkflowLogger(),
      onStateChange: (nextState, event) => {
        const stateWithRun = {
          ...nextState,
          runId: runDescriptor.runId,
          runName: runDescriptor.runName,
        };
        const eventType = event.type ?? event.kind;
        if (eventType === MacroWorkflowEventKind.NODE_STARTED && event.nodeId) {
          const startedNode = findWorkflowNode(
            stateWithRun.currentPlan,
            stateWithRun.plan,
            event.nodeId,
          );
          process.stderr.write(
            formatWorkflowNodeStartedMessage({
              nodeId: event.nodeId,
              title: startedNode?.title,
              harness: startedNode?.harness,
              kind: startedNode?.kind,
            }),
          );
        }
        if (eventType === MacroWorkflowEventKind.NODE_WARNING && event.nodeId) {
          const warningNode = findWorkflowNode(
            stateWithRun.currentPlan,
            stateWithRun.plan,
            event.nodeId,
          );
          process.stderr.write(
            formatWorkflowNodeWarningMessage({
              nodeId: event.nodeId,
              title: warningNode?.title,
              warning: event.reason,
            }),
          );
        }
        if (eventType === MacroWorkflowEventKind.NODE_COMPLETED && event.nodeId) {
          const completedResult = stateWithRun.nodeResults.find(
            (result) => result.nodeId === event.nodeId,
          );
          const completedNode = findWorkflowNode(
            stateWithRun.currentPlan,
            stateWithRun.plan,
            event.nodeId,
          );
          process.stderr.write(
            formatWorkflowNodeCompletedMessage({
              nodeId: event.nodeId,
              title: completedNode?.title,
              status: completedResult?.status ?? event.status,
              output: completedResult?.output,
              artifacts: completedResult?.artifacts,
            }),
          );
        }
        if (eventType === MacroWorkflowEventKind.NODE_FAILED && event.nodeId) {
          const failedResult = stateWithRun.nodeResults.find(
            (result) => result.nodeId === event.nodeId,
          );
          const failedNode = findWorkflowNode(
            stateWithRun.currentPlan,
            stateWithRun.plan,
            event.nodeId,
          );
          process.stderr.write(
            formatWorkflowNodeFailureMessage({
              nodeId: event.nodeId,
              title: failedNode?.title,
              status: failedResult?.status ?? event.status,
              error: failedResult?.error,
              output: failedResult?.output,
            }),
          );
        }
        if (eventType === MacroWorkflowEventKind.RUN_COMPLETED) {
          process.stderr.write(
            formatWorkflowRunCompletedMessage({
              status: event.status ?? stateWithRun.status,
              outputDir: runDescriptor.outputDir,
            }),
          );
        }
        stateSnapshotWrite = stateSnapshotWrite.then(async () => {
          await workflowArtifactsModule.writeMacroWorkflowStateArtifact(
            runDescriptor.outputDir,
            stateWithRun,
          );
        });
        if (dashboardServer) {
          dashboardServer.publishState(stateWithRun, event, replayEvents);
          return;
        }
        if (dashboardPublisher) {
          void dashboardPublisher.publishState(stateWithRun, event, replayEvents).catch((error) => {
            process.stderr.write(
              `[weavekit] Dashboard update failed: ${error instanceof Error ? error.message : String(error)}\n`,
            );
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
    await workflowNodeCostHistoryModule.recordNodeCostHistoryFromUsage({ summary: state.usage });
    await workflowArtifactsModule.writeMacroWorkflowArtifacts({
      outputDir: runDescriptor.outputDir,
      state,
      replayEvents,
    });
    process.stderr.write(workflowUsageModule.renderWorkflowUsageSummary(state.usage));
    assertWorkflowRunSucceeded(state);
    return [
      formatWorkflowCliSuccessMessage({ outputDir: runDescriptor.outputDir }),
      dashboardServer
        ? `Dashboard: ${dashboardServer.url}`
        : args.dashboardUrl
          ? `Dashboard: ${args.dashboardUrl}`
          : "",
    ]
      .filter(Boolean)
      .join("\n");
  } finally {
    await deepResearchExaMcp?.close();
    if (dashboardServer) {
      await dashboardServer.stop();
    }
  }
}

export function assertWorkflowRunSucceeded(
  state: Pick<MacroWorkflowRunStateLike, "status" | "nodeResults">,
): void {
  if (state.status === WorkflowNodeStatus.PASSED) {
    return;
  }
  const failedResult = state.nodeResults.find(
    (result) =>
      result.status !== WorkflowNodeStatus.PASSED && result.status !== WorkflowNodeStatus.SKIPPED,
  );
  const failureDetail = failedResult
    ? `${failedResult.nodeId}: ${failedResult.error ?? failedResult.output}`
    : `status ${state.status}`;
  throw new Error(`Workflow failed at ${failureDetail}`);
}

function assertResumableWorkflowState(
  state: MacroWorkflowRunStateLike,
  requestedRunId: string,
): asserts state is MacroWorkflowRunState {
  if (state.runId !== requestedRunId) {
    throw new Error(
      `Cannot resume workflow ${requestedRunId}: persisted state belongs to run ${state.runId ?? "unknown"}.`,
    );
  }
  if (!state.plan || !state.currentPlan) {
    throw new Error(
      `Cannot resume workflow ${requestedRunId}: workflow-state.json does not contain plan and currentPlan.`,
    );
  }
  if (
    state.planId !== state.currentPlan.id ||
    state.objective !== state.currentPlan.objective ||
    state.templateId !== state.currentPlan.templateId
  ) {
    throw new Error(
      `Cannot resume workflow ${requestedRunId}: persisted plan metadata is incompatible with currentPlan.`,
    );
  }
}

async function readWorkflowResumeState(
  outputDir: string,
  runId: string,
): Promise<MacroWorkflowRunStateLike> {
  try {
    return await new MacroWorkflowStateStore(outputDir).read();
  } catch (error) {
    throw new Error(
      `Cannot resume workflow ${runId}: failed to read workflow-state.json: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function findPrefetchedXPostContent(
  fetchedXPosts: XPostFetchResult[],
  source: string | undefined,
): string | undefined {
  if (!source || fetchedXPosts.length === 0) {
    return undefined;
  }
  const sourceUrls = extractXPostUrls(source);
  const sourceKeys = new Set(sourceUrls.length > 0 ? sourceUrls : [source]);
  return fetchedXPosts.find((post) => sourceKeys.has(post.url))?.markdown;
}

function createXArticleSummaryHarnessRegistry(
  workflowHarnessModule: typeof import("./macro-workflow/harness.js"),
) {
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
  return (
    [title, clippedBody].filter(Boolean).join(": ") || "No resolved article content was available."
  );
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

      process.stdout.write(
        formatDecisionCouncilSuccessMessage({
          recommendation: report.recommendation,
          outputDir: args.outputDir,
        }),
      );
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
