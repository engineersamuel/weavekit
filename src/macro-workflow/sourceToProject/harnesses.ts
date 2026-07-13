import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ClientRegistry, type Collector } from "@boundaryml/baml";
import {
  resolveWeavekitPluginDirectory,
  SupportedPluginId,
  type CopilotDefaults,
  defaultBudgetGateConfig,
  defaultCouncilDeliberationConfig,
  type PluginConfigs,
  type ProjectCatalogEntry,
  type SourceToProjectDefaults,
  type SourceToProjectMode,
  type SourceToProjectThresholds,
  type ToolingDefaults,
} from "../../config.js";
import { buildCopilotClientOptions } from "../../telemetry/copilotSdk.js";
import { b } from "../../generated/baml_client/index.js";
import type {
  CorroborationReport,
  FinalRecommendationReview,
  ImplementationReviewVerdict,
  Opportunity,
  OpportunityBundle,
  OpportunityCouncilReview,
  PlanArtifactSummary,
  ProjectBrief,
  SourceAnalysis,
} from "../../generated/baml_client/index.js";
import { TelegramClient } from "../../telegram/client.js";
import type {
  HarnessAdapter,
  HarnessExecutionResult,
  HarnessRegistry,
  WorkflowExecutionContext,
} from "../harness.js";
import { createStaticHarnessRegistry } from "../harness.js";
import { loadNodeCostHistory } from "../nodeCostHistory.js";
import type { WorkflowDynamicExpander } from "../runner.js";
import {
  extractUsageFromCopilotEventData,
  projectWorkflowCostUsd,
  type WorkflowTokenUsage,
  type WorkflowUsageCollector,
} from "../usage.js";
import type {
  RuntimeWorkflowNode,
  WorkflowArtifactRef,
  WorkflowExecutionCall,
  WorkflowExecutionMetadata,
} from "../types.js";
import { WorkflowGateKind, WorkflowHarnessKind, WorkflowNodeKind } from "../types.js";
import {
  SourceToProjectModelOperation,
  sourceToProjectBamlFunctionRoute,
  sourceToProjectBamlRoute,
  sourceToProjectCopilotModelDecision,
  sourceToProjectNodeModelMetadata,
  type SourceToProjectBamlFunctionName,
} from "./modelPolicy.js";
import {
  buildCorroborationPrompt,
  buildPlanPrompt,
  buildProjectResearchPrompt,
  buildSourceReadingPrompt,
} from "./prompts.js";
import { averageOpportunityScoreVector, opportunityScoreToScalar } from "./opportunityGeometry.js";
import {
  buildCouncilDeliberationInput,
  runCouncilDeliberation,
  type CouncilDeliberationResult,
  type CouncilDeliberationRunner,
} from "./councilDeliberation.js";
import {
  buildImplementationReviewPrompt,
  parseImplementationReviewVerdict,
} from "./implementationReview.js";
import {
  launchSourceToProjectPrAgent,
  type SourceToProjectPrLaunchContext,
  type SourceToProjectPrLaunchResult,
  type SourceToProjectPrLauncher,
} from "./prLauncher.js";
import { prepareAutonomousWorktree, type WorktreePreparationResult } from "./worktree.js";

const execFileAsync = promisify(execFile);

const DEFAULT_SOURCE_TO_PROJECT_THRESHOLDS: SourceToProjectThresholds = {
  minApplicability: 0.7,
  minConfidence: 0.65,
  minImpact: 0.5,
  minAcceptanceAverage: 0.85,
  maxRisk: 0.8,
};

const DEFAULT_AGENT_NATIVE_SKILLS_PACKAGE = "@agent-native/skills@latest";
const DEFAULT_VISUAL_PLAN_BRIDGE_TTL_MS = 4 * 60 * 60 * 1000;
const MIN_PLAN_QUALITY_SCORE = 0.45;

type PlanCandidate = {
  kind: "opportunity" | "bundle";
  id: string;
  title: string;
  opportunityIds: string[];
  projectChange: string;
  sourceLesson: string;
  userValue: string;
  evidenceCount: number;
  speculative: boolean;
  score: {
    applicability: number;
    impact: number;
    confidence: number;
    implementationCost: number;
    risk: number;
  };
  sourceCoreFit: number;
  metaInfrastructurePenalty: number;
  qualityScore: number;
  raw: Opportunity | OpportunityBundle;
};

type PlanSelection = {
  status: "selected" | "rejected";
  reason: string;
  candidatesConsidered: Array<{
    kind: PlanCandidate["kind"];
    id: string;
    title: string;
    qualityScore: number;
    sourceCoreFit: number;
    metaInfrastructurePenalty: number;
    opportunityIds: string[];
  }>;
  selectedCandidate?: PlanCandidate;
};

export type OpportunityAcceptance = {
  id: string;
  title: string;
  accepted: boolean;
  reason: string;
  acceptanceAverage: number;
  scores: {
    applicability: number;
    applicabilityReasoning: string;
    impact: number;
    impactReasoning: string;
    confidence: number;
    confidenceReasoning: string;
    risk: number;
    riskReasoning: string;
  };
  opportunity: Opportunity;
};

type CopilotRuntimeClient = {
  start(): Promise<void>;
  createSession(config: unknown): Promise<CopilotRuntimeSession>;
  stop(): Promise<Error[] | undefined>;
};

type CopilotRuntimeSessionEvent = {
  type: string;
  data?: {
    content?: string;
    message?: string;
    stack?: string;
    toolName?: string;
    name?: string;
  } & Record<string, unknown>;
};

type CopilotRuntimeSkillListItem = {
  name: string;
  enabled?: boolean;
};

type CopilotRuntimeSkillLoadDiagnostics = {
  warnings?: string[];
  errors?: string[];
};

type CopilotRuntimeSession = {
  sessionId?: string;
  sendAndWait?(
    message: { prompt: string },
    timeout?: number,
  ): Promise<{ data?: { content?: string } & Record<string, unknown> } | undefined>;
  send?(message: {
    prompt: string;
    agentMode?: "plan" | "autopilot" | "interactive" | "shell";
  }): Promise<string>;
  on?(handler: (event: CopilotRuntimeSessionEvent) => void): () => void;
  rpc?: {
    skills?: {
      ensureLoaded?: () => Promise<unknown>;
      reload?: () => Promise<CopilotRuntimeSkillLoadDiagnostics>;
      list?: () => Promise<{ skills?: CopilotRuntimeSkillListItem[] }>;
      enable?: (args: { name: string }) => Promise<unknown>;
    };
  };
  disconnect(): Promise<void>;
};

const DEFAULT_SOURCE_READING_MAX_TOOL_CALLS = 40;
const DEFAULT_PROJECT_RESEARCH_MAX_TOOL_CALLS = 60;
const RAW_PLAN_ARTIFACT_DIR = "raw-plans";

export type CopilotUserInputRequest = {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
};

export type CopilotHarnessLogEvent = {
  phase:
    | "client-create"
    | "client-start"
    | "session-create"
    | "session-created"
    | "skills-load"
    | "skills-warning"
    | "prompt-send"
    | "session-event"
    | "assistant-message"
    | "session-idle"
    | "session-error"
    | "timeout-partial"
    | "timeout"
    | "tool-budget"
    | "disconnect"
    | "client-stop";
  mode?: "research" | "plan" | "implement" | "review";
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

export type CopilotHarnessUsageEvent = {
  mode: "research" | "plan" | "implement" | "review";
  model: string;
  cwd?: string;
  operation?: string;
  nodeId?: string;
  label?: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
};

export type CopilotCapabilityScope =
  | {
      kind: "plugin-command";
      pluginDirectory: string;
      command: string;
      promptInputName: string;
      commandArgs?: Record<string, string>;
    }
  | {
      kind: "skill";
      skillName: string;
      skillDirectories: string[];
      disabledSkills?: string[];
    };

export type CopilotHarnessClient = {
  model?: string;
  run(args: {
    cwd?: string;
    prompt: string;
    mode: "research" | "plan" | "implement" | "review";
    model?: string;
    maxToolCalls?: number;
    operation?: string;
    nodeId?: string;
    label?: string;
    capabilityScope?: CopilotCapabilityScope;
    onSessionId?: (sessionId: string) => void;
  }): Promise<string>;
};

function scopedPromptForCapability(
  prompt: string,
  capabilityScope?: CopilotCapabilityScope,
): string {
  if (!capabilityScope) return prompt;
  if (capabilityScope.kind === "plugin-command") {
    const commandArgs = formatPluginCommandArgs(capabilityScope.commandArgs);
    return [
      `/${capabilityScope.command}`,
      `${capabilityScope.promptInputName}=${JSON.stringify(prompt)}`,
      commandArgs,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" ");
  }
  if (capabilityScope.kind === "skill") {
    const trimmed = prompt.trimStart();
    return trimmed.startsWith(`/${capabilityScope.skillName}`)
      ? prompt
      : `/${capabilityScope.skillName} ${prompt}`;
  }
  return prompt;
}

function formatPluginCommandArgs(args?: Record<string, string>): string | undefined {
  if (!args) return undefined;
  const formatted = Object.entries(args).map(
    ([key, value]) => `${key}=${formatPluginCommandValue(value)}`,
  );
  return formatted.length > 0 ? formatted.join(" ") : undefined;
}

function formatPluginCommandValue(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : JSON.stringify(value);
}

function sessionConfigForCapability(
  capabilityScope?: CopilotCapabilityScope,
): Record<string, unknown> {
  if (!capabilityScope) return {};
  if (capabilityScope.kind === "plugin-command") {
    return { pluginDirectories: [capabilityScope.pluginDirectory] };
  }
  if (capabilityScope.kind === "skill") {
    return {
      skillDirectories: capabilityScope.skillDirectories,
      disabledSkills: capabilityScope.disabledSkills ?? [],
      enableSkills: true,
    };
  }
  return {};
}

function capabilityScopeLabel(capabilityScope?: CopilotCapabilityScope): string | undefined {
  if (!capabilityScope) return undefined;
  if (capabilityScope.kind === "plugin-command") {
    return `plugin-command:${capabilityScope.command}`;
  }
  if (capabilityScope.kind === "skill") {
    return `skill:${capabilityScope.skillName}`;
  }
  return undefined;
}

export type SourceToProjectBamlClient = {
  DistillSourceAnalysis(sourceArtifactJson: string, rawResearch: string): Promise<SourceAnalysis>;
  DistillCorroboration(
    sourceAnalysis: SourceAnalysis,
    rawResearch: string,
  ): Promise<CorroborationReport>;
  DistillProjectBrief(projectJson: string, rawResearch: string): Promise<ProjectBrief>;
  MapSourceToProject(
    sourceAnalysis: SourceAnalysis,
    corroboration: CorroborationReport,
    projectBrief: ProjectBrief,
  ): Promise<OpportunityCouncilReview>;
  DistillPlanArtifact(
    opportunityJson: string,
    rawPlan: string,
    rawPlanArtifactPath: string,
  ): Promise<PlanArtifactSummary>;
  ReviewFinalRecommendation(
    originalPrompt: string,
    source: string,
    sourceAnalysis: SourceAnalysis,
    corroboration: CorroborationReport,
    projectBrief: ProjectBrief,
    plans: PlanArtifactSummary[],
  ): Promise<FinalRecommendationReview>;
};

export type ShellClient = {
  run(command: string, args: string[], options: { cwd: string }): Promise<string>;
};

export type AgentNativeSkillInstallResult = {
  skill: "visual-plan";
  command: string;
  args: string[];
  output: string;
  skipped: boolean;
  usable?: boolean;
  warning?: string;
};

export type AgentNativeSkillPreflightResult = {
  skill: AgentNativeSkillInstallResult["skill"];
  skillInstall: AgentNativeSkillInstallResult;
};

export type VisualPlanBridgeCleanupResult = {
  status: "scheduled" | "disabled";
  bridgeUrl: string;
  port: number;
  cleanupAfterMs: number;
  cleanupCommand?: string;
};

export type VisualPlanBridgeCleanupScheduler = (args: {
  hostedArtifactUrl: string;
  cleanupAfterMs: number;
}) => VisualPlanBridgeCleanupResult | undefined;

export type SourceToProjectNotificationResult = {
  channel: "cli" | "telegram";
  status: "sent" | "skipped" | "failed";
  message: string;
  error?: string;
};

type NotifiableFinalRecommendationReview = FinalRecommendationReview & { telegramSummary: string };

type SourceToProjectBamlCallOptions = {
  client?: string;
  clientRegistry?: ClientRegistry;
  collector?: Collector;
};

export type SourceToProjectNotifier = {
  notifyRejection(args: {
    review: NotifiableFinalRecommendationReview;
    project: ProjectCatalogEntry;
    source: string;
  }): Promise<SourceToProjectNotificationResult>;
  notifyElicitation(args: {
    question: string;
    project: ProjectCatalogEntry;
    source: string;
  }): Promise<SourceToProjectNotificationResult>;
};

export type SourceToProjectHarnessOptions = {
  source: string;
  originalPrompt?: string;
  prefetchedSourceContent?: string;
  project: ProjectCatalogEntry;
  mode: SourceToProjectMode;
  /** Cap on accepted opportunities promoted per run. 0 or undefined means unlimited: every opportunity that clears the acceptance thresholds is promoted. */
  maxOpportunities?: number;
  thresholds?: SourceToProjectThresholds;
  copilot?: CopilotHarnessClient;
  baml?: Partial<SourceToProjectBamlClient>;
  notifier?: SourceToProjectNotifier;
  sourceToProject?: SourceToProjectDefaults;
  budgetOverrideReason?: string;
  tooling?: ToolingDefaults;
  plugins?: PluginConfigs;
  worktree?: {
    prepare(): Promise<WorktreePreparationResult>;
  };
  shell?: ShellClient;
  usageCollector?: WorkflowUsageCollector;
  visualPlanBridgeCleanup?: VisualPlanBridgeCleanupScheduler;
  visualPlanBridgeCleanupTtlMs?: number;
  /** Overridable for tests; defaults to the real Herdr-based launcher. */
  prLauncher?: SourceToProjectPrLauncher;
  /** Overridable for tests; defaults to the real persona-driven decision council. */
  councilDeliberation?: CouncilDeliberationRunner;
};

export function createOfflineSourceToProjectHarnessClient(): CopilotHarnessClient {
  return {
    model: "offline",
    async run(args) {
      return [`Mode: ${args.mode}`, args.cwd ? `Cwd: ${args.cwd}` : undefined, args.prompt]
        .filter(Boolean)
        .join("\n\n");
    },
  };
}

export function createLiveSourceToProjectBamlClient(
  options: {
    usageCollector?: WorkflowUsageCollector;
  } = {},
): SourceToProjectBamlClient {
  return {
    async DistillSourceAnalysis(sourceArtifactJson, rawResearch) {
      return runSourceToProjectBamlCall(
        options.usageCollector,
        "DistillSourceAnalysis",
        (callOptions) => b.DistillSourceAnalysis(sourceArtifactJson, rawResearch, callOptions),
      );
    },
    async DistillCorroboration(sourceAnalysis, rawResearch) {
      return runSourceToProjectBamlCall(
        options.usageCollector,
        "DistillCorroboration",
        (callOptions) => b.DistillCorroboration(sourceAnalysis, rawResearch, callOptions),
      );
    },
    async DistillProjectBrief(projectJson, rawResearch) {
      return runSourceToProjectBamlCall(
        options.usageCollector,
        "DistillProjectBrief",
        (callOptions) => b.DistillProjectBrief(projectJson, rawResearch, callOptions),
      );
    },
    async MapSourceToProject(sourceAnalysis, corroboration, projectBrief) {
      return runSourceToProjectBamlCall(
        options.usageCollector,
        "MapSourceToProject",
        (callOptions) =>
          b.MapSourceToProject(sourceAnalysis, corroboration, projectBrief, callOptions),
      );
    },
    async DistillPlanArtifact(opportunityJson, rawPlan, rawPlanArtifactPath) {
      return runSourceToProjectBamlCall(
        options.usageCollector,
        "DistillPlanArtifact",
        (callOptions) =>
          b.DistillPlanArtifact(opportunityJson, rawPlan, rawPlanArtifactPath, callOptions),
      );
    },
    async ReviewFinalRecommendation(
      originalPrompt,
      source,
      sourceAnalysis,
      corroboration,
      projectBrief,
      plans,
    ) {
      return runSourceToProjectBamlCall(
        options.usageCollector,
        "ReviewFinalRecommendation",
        (callOptions) =>
          b.ReviewFinalRecommendation(
            originalPrompt,
            source,
            sourceAnalysis,
            corroboration,
            projectBrief,
            plans,
            callOptions,
          ),
      );
    },
  };
}

async function runSourceToProjectBamlCall<T>(
  usageCollector: WorkflowUsageCollector | undefined,
  functionName: SourceToProjectBamlFunctionName,
  call: (options: SourceToProjectBamlCallOptions) => Promise<T>,
): Promise<T> {
  const route = sourceToProjectBamlFunctionRoute(functionName);
  const bamlOptions = bamlOptionsForRoute(route);
  const collector = usageCollector?.createBamlCollector(`source-to-project.${functionName}`);
  try {
    return await call({
      ...bamlOptions,
      ...(collector ? { collector } : {}),
    });
  } finally {
    if (collector) {
      usageCollector?.recordBamlCollector({
        operation: functionName,
        model: route.model,
        collector,
      });
    }
  }
}

export function createCopilotSdkHarnessClient(
  args: {
    model?: string;
    timeoutMs?: number;
    sourceToProject?: SourceToProjectDefaults;
    copilot?: CopilotDefaults;
    onUserInputRequest?: (request: CopilotUserInputRequest) => Promise<void> | void;
    onLog?: (event: CopilotHarnessLogEvent) => void;
    onUsage?: (event: CopilotHarnessUsageEvent) => void;
    verboseEvents?: boolean;
    maxToolCalls?: number;
    clientFactory?: () => Promise<CopilotRuntimeClient> | CopilotRuntimeClient;
  } = {},
): CopilotHarnessClient {
  const defaultModel =
    args.model ??
    sourceToProjectCopilotModelDecision(SourceToProjectModelOperation.SOURCE_READING, {
      copilotModel: args.sourceToProject?.copilotModel,
    }).model;
  const timeoutMs = args.timeoutMs ?? args.sourceToProject?.timeoutMs ?? 300_000;
  const defaultMaxToolCalls = args.maxToolCalls ?? args.sourceToProject?.maxToolCalls;
  const verboseEvents = args.verboseEvents ?? args.copilot?.verboseEvents ?? false;
  const clientFactory =
    args.clientFactory ??
    (async () => {
      const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
      const CopilotClientCtor = CopilotClient as unknown as new (
        options?: unknown,
      ) => CopilotRuntimeClient;
      const telemetryOptions = buildCopilotClientOptions();
      const runtimeUrl = args.copilot?.runtimeUrl ?? args.copilot?.cliUrl;
      const cliPath =
        args.copilot?.cliPath ??
        resolveCopilotCliPathFromSdkModuleUrl(import.meta.resolve("@github/copilot-sdk"));
      const clientOptions: Record<string, unknown> = { ...telemetryOptions };
      if (runtimeUrl) {
        clientOptions.connection = RuntimeConnection.forUri(runtimeUrl);
      } else if (cliPath) {
        clientOptions.connection = RuntimeConnection.forStdio({ path: cliPath });
      }
      return Object.keys(clientOptions).length > 0
        ? new CopilotClientCtor(clientOptions)
        : new CopilotClientCtor();
    });

  return {
    model: defaultModel,
    async run(runArgs) {
      const startedAt = Date.now();
      const model = runArgs.model ?? defaultModel;
      const prompt = scopedPromptForCapability(runArgs.prompt, runArgs.capabilityScope);
      logCopilotHarnessEvent(
        args.onLog,
        {
          phase: "client-create",
          mode: runArgs.mode,
          model,
          cwd: runArgs.cwd,
          timeoutMs,
          promptLength: prompt.length,
          elapsedMs: elapsedSince(startedAt),
        },
        verboseEvents,
      );
      let client: CopilotRuntimeClient;
      try {
        client = await clientFactory();
      } catch (error) {
        logCopilotHarnessEvent(
          args.onLog,
          {
            phase: "session-error",
            mode: runArgs.mode,
            model,
            cwd: runArgs.cwd,
            message: `Copilot SDK client creation failed: ${errorMessage(error)}`,
            elapsedMs: elapsedSince(startedAt),
          },
          verboseEvents,
        );
        throw error;
      }
      logCopilotHarnessEvent(
        args.onLog,
        {
          phase: "client-start",
          mode: runArgs.mode,
          model,
          cwd: runArgs.cwd,
          elapsedMs: elapsedSince(startedAt),
        },
        verboseEvents,
      );
      let session: Awaited<ReturnType<CopilotRuntimeClient["createSession"]>> | undefined;
      try {
        await client.start();
        const { approveAll } = await import("@github/copilot-sdk");
        const maxToolCalls = runArgs.maxToolCalls ?? defaultMaxToolCalls;
        let attemptedToolCallCount = 0;
        logCopilotHarnessEvent(
          args.onLog,
          {
            phase: "session-create",
            mode: runArgs.mode,
            model,
            cwd: runArgs.cwd,
            elapsedMs: elapsedSince(startedAt),
          },
          verboseEvents,
        );
        session = await client.createSession({
          model,
          onPermissionRequest: approveAll,
          onUserInputRequest: async (request: CopilotUserInputRequest) => {
            await args.onUserInputRequest?.(request);
            throw new Error(formatCopilotUserInputRequiredError(request));
          },
          ...sessionConfigForCapability(runArgs.capabilityScope),
          ...(maxToolCalls
            ? {
                hooks: {
                  onPreToolUse: (input: { toolName?: string; toolArgs?: unknown }) => {
                    const visualPlanServeDecision = denyForegroundVisualPlanServe(
                      input,
                      runArgs.capabilityScope,
                    );
                    if (visualPlanServeDecision) {
                      return visualPlanServeDecision;
                    }
                    attemptedToolCallCount += 1;
                    if (attemptedToolCallCount <= maxToolCalls) {
                      return;
                    }
                    logCopilotHarnessEvent(
                      args.onLog,
                      {
                        phase: "tool-budget",
                        mode: runArgs.mode,
                        model,
                        cwd: runArgs.cwd,
                        toolName: input.toolName,
                        toolCallCount: attemptedToolCallCount,
                        maxToolCalls,
                        message:
                          "Tool-call budget exceeded; denying this tool call so the assistant should stop browsing and produce its final answer.",
                        elapsedMs: elapsedSince(startedAt),
                      },
                      verboseEvents,
                    );
                    return {
                      permissionDecision: "deny" as const,
                      permissionDecisionReason: `This workflow node has reached its ${maxToolCalls}-tool research budget. Stop using tools and produce the final source-grounded answer from the evidence already gathered.`,
                    };
                  },
                },
              }
            : runArgs.capabilityScope?.kind === "skill"
              ? {
                  hooks: {
                    onPreToolUse: (input: { toolName?: string; toolArgs?: unknown }) =>
                      denyForegroundVisualPlanServe(input, runArgs.capabilityScope),
                  },
                }
              : {}),
          ...(runArgs.cwd ? { cwd: runArgs.cwd } : {}),
        });
        logCopilotHarnessEvent(
          args.onLog,
          {
            phase: "session-created",
            mode: runArgs.mode,
            model,
            cwd: runArgs.cwd,
            elapsedMs: elapsedSince(startedAt),
          },
          verboseEvents,
        );
        if (runArgs.onSessionId && session.sessionId) {
          runArgs.onSessionId(session.sessionId);
        }
        await loadCopilotCapabilityScope(session, runArgs.capabilityScope, {
          timeoutMs,
          mode: runArgs.mode,
          model,
          cwd: runArgs.cwd,
          startedAt,
          onLog: args.onLog,
          verboseEvents,
        });
        const content = await sendCopilotPromptAndWait(session, { ...runArgs, prompt }, timeoutMs, {
          startedAt,
          model,
          cwd: runArgs.cwd,
          onLog: args.onLog,
          onUsage: args.onUsage,
          verboseEvents,
        });
        if (!content.trim()) {
          throw new Error(`Copilot SDK returned an empty ${runArgs.mode} response.`);
        }
        return content;
      } catch (error) {
        logCopilotHarnessEvent(
          args.onLog,
          {
            phase: "session-error",
            mode: runArgs.mode,
            model,
            cwd: runArgs.cwd,
            message: errorMessage(error),
            elapsedMs: elapsedSince(startedAt),
          },
          verboseEvents,
        );
        throw error;
      } finally {
        if (session) {
          logCopilotHarnessEvent(
            args.onLog,
            {
              phase: "disconnect",
              mode: runArgs.mode,
              model,
              cwd: runArgs.cwd,
              elapsedMs: elapsedSince(startedAt),
            },
            verboseEvents,
          );
          try {
            await session.disconnect();
          } catch (error) {
            logCopilotHarnessEvent(
              args.onLog,
              {
                phase: "session-error",
                mode: runArgs.mode,
                model,
                cwd: runArgs.cwd,
                message: `Copilot SDK session disconnect failed (suppressed in favor of primary error, if any): ${errorMessage(error)}`,
                elapsedMs: elapsedSince(startedAt),
              },
              verboseEvents,
            );
          }
        }
        logCopilotHarnessEvent(
          args.onLog,
          {
            phase: "client-stop",
            mode: runArgs.mode,
            model,
            cwd: runArgs.cwd,
            elapsedMs: elapsedSince(startedAt),
          },
          verboseEvents,
        );
        const stopErrors = await client.stop();
        if (stopErrors && stopErrors.length > 0) {
          logCopilotHarnessEvent(
            args.onLog,
            {
              phase: "session-error",
              mode: runArgs.mode,
              model,
              cwd: runArgs.cwd,
              message: `Copilot SDK client stop failed (suppressed in favor of primary error, if any): ${errorMessage(stopErrors[0])}`,
              elapsedMs: elapsedSince(startedAt),
            },
            verboseEvents,
          );
        }
      }
    },
  };
}

function copilotPlatformPackageNames(): string[] {
  const variants = process.platform === "linux" ? ["linux", "linuxmusl"] : [process.platform];
  return variants.map((variant) => `@github/copilot-${variant}-${process.arch}`);
}

function findPackageStoreDir(startPath: string, packageNamePrefix: string): string | undefined {
  let current = dirname(startPath);
  while (current !== dirname(current)) {
    if (basename(current).startsWith(packageNamePrefix)) {
      return current;
    }
    current = dirname(current);
  }
  return undefined;
}

function findPlatformCliPathInVirtualStore(virtualStoreDir: string): string | undefined {
  for (const packageName of copilotPlatformPackageNames()) {
    const storePrefix = `${packageName.replace("/", "+")}@`;
    const entries = existsSync(virtualStoreDir)
      ? readdirSync(virtualStoreDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith(storePrefix))
          .map((entry) => entry.name)
          .sort()
          .reverse()
      : [];
    for (const entry of entries) {
      const candidate = join(
        virtualStoreDir,
        entry,
        "node_modules",
        ...packageName.split("/"),
        "index.js",
      );
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function resolveCopilotCliPathFromSdkModuleUrl(sdkModuleUrl: string): string | undefined {
  const sdkModulePath = fileURLToPath(sdkModuleUrl);
  const sdkStoreDir = findPackageStoreDir(sdkModulePath, "@github+copilot-sdk@");
  if (sdkStoreDir) {
    const platformCliPath = findPlatformCliPathInVirtualStore(dirname(sdkStoreDir));
    if (platformCliPath) {
      return platformCliPath;
    }
  }

  const sdkPackageRoot = dirname(dirname(sdkModulePath));
  const packageNodeModules = dirname(dirname(sdkPackageRoot));
  const shimName = process.platform === "win32" ? "copilot.cmd" : "copilot";
  const copilotShim = join(packageNodeModules, ".bin", shimName);
  return existsSync(copilotShim) ? copilotShim : undefined;
}

function logCopilotHarnessEvent(
  onLog: ((event: CopilotHarnessLogEvent) => void) | undefined,
  event: CopilotHarnessLogEvent,
  verboseEvents = false,
): void {
  if (shouldSuppressCopilotHarnessEvent(event, verboseEvents)) {
    return;
  }
  onLog?.(event);
}

function shouldSuppressCopilotHarnessEvent(
  event: CopilotHarnessLogEvent,
  verboseEvents: boolean,
): boolean {
  if (verboseEvents) {
    return false;
  }
  return event.phase === "session-event" || event.phase === "assistant-message";
}

function elapsedSince(startedAt: number): number {
  return Date.now() - startedAt;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function denyForegroundVisualPlanServe(
  input: { toolName?: string; toolArgs?: unknown },
  capabilityScope?: CopilotCapabilityScope,
): { permissionDecision: "deny"; permissionDecisionReason: string } | undefined {
  if (capabilityScope?.kind !== "skill" || capabilityScope.skillName !== "visual-plan") {
    return undefined;
  }
  const toolArgs = stringifyToolArgs(input.toolArgs);
  if (!/\bplan\s+local\s+serve\b/.test(toolArgs)) {
    return undefined;
  }
  if (/\b(?:nohup|setsid|disown)\b|copilot-detached/i.test(toolArgs)) {
    return undefined;
  }
  return {
    permissionDecision: "deny",
    permissionDecisionReason: [
      "Do not run `plan local serve` as a foreground command in this SDK workflow; it keeps the tool call open and prevents the workflow process from returning.",
      "Start the bridge detached, poll the `.plan-url` file or serve output until the `https://plan.agent-native.com/local-plans/...` URL is available, then return that URL.",
      "Use a detached shape such as `nohup nubx @agent-native/core@latest plan local serve --dir <plan-dir> --kind plan --open > /tmp/<slug>-plan-serve.log 2>&1 &`.",
    ].join(" "),
  };
}

function stringifyToolArgs(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function loadCopilotCapabilityScope(
  session: CopilotRuntimeSession,
  capabilityScope: CopilotCapabilityScope | undefined,
  diagnostics: {
    timeoutMs: number;
    mode: "research" | "plan" | "implement" | "review";
    model: string;
    cwd?: string;
    startedAt: number;
    onLog?: (event: CopilotHarnessLogEvent) => void;
    verboseEvents?: boolean;
  },
): Promise<void> {
  if (!capabilityScope || capabilityScope.kind !== "skill") {
    return;
  }

  const skills = session.rpc?.skills;
  if (!skills?.ensureLoaded || !skills.reload || !skills.list || !skills.enable) {
    throw new Error(
      [
        `Copilot SDK session does not expose the skill RPCs required for ${capabilityScope.skillName}.`,
        "Expected rpc.skills.ensureLoaded/reload/list/enable before sending a skill-scoped prompt.",
      ].join(" "),
    );
  }

  logCopilotHarnessEvent(
    diagnostics.onLog,
    {
      phase: "skills-load",
      mode: diagnostics.mode,
      model: diagnostics.model,
      cwd: diagnostics.cwd,
      skillName: capabilityScope.skillName,
      message: "Loading Copilot SDK skills before sending scoped prompt.",
      elapsedMs: elapsedSince(diagnostics.startedAt),
    },
    diagnostics.verboseEvents,
  );

  await withCopilotTimeout(
    `${capabilityScope.skillName} skills.ensureLoaded`,
    diagnostics.timeoutMs,
    skills.ensureLoaded(),
  );
  const loadDiagnostics = await withCopilotTimeout(
    `${capabilityScope.skillName} skills.reload`,
    diagnostics.timeoutMs,
    skills.reload(),
  );
  for (const warning of loadDiagnostics.warnings ?? []) {
    logCopilotHarnessEvent(
      diagnostics.onLog,
      {
        phase: "skills-warning",
        mode: diagnostics.mode,
        model: diagnostics.model,
        cwd: diagnostics.cwd,
        skillName: capabilityScope.skillName,
        message: warning,
        elapsedMs: elapsedSince(diagnostics.startedAt),
      },
      diagnostics.verboseEvents,
    );
  }
  if (loadDiagnostics.errors?.length) {
    throw new Error(
      `Copilot SDK skill reload failed for ${capabilityScope.skillName}: ${loadDiagnostics.errors.join("; ")}`,
    );
  }
  await withCopilotTimeout(
    `${capabilityScope.skillName} skills.enable`,
    diagnostics.timeoutMs,
    skills.enable({ name: capabilityScope.skillName }),
  );
  const listed = await withCopilotTimeout(
    `${capabilityScope.skillName} skills.list`,
    diagnostics.timeoutMs,
    skills.list(),
  );
  assertCopilotSkillListedAndEnabled(capabilityScope.skillName, listed.skills ?? []);
}

function assertCopilotSkillListedAndEnabled(
  skillName: string,
  skills: CopilotRuntimeSkillListItem[],
): void {
  const skill = skills.find((candidate) => candidate.name === skillName);
  if (!skill) {
    const available = skills
      .map((candidate) => candidate.name)
      .sort()
      .join(", ");
    throw new Error(
      `Copilot SDK session did not list skill ${skillName}. Available skills: ${available || "<none>"}.`,
    );
  }
  if (skill.enabled === false) {
    throw new Error(`Copilot SDK session listed skill ${skillName}, but it is disabled.`);
  }
}

async function withCopilotTimeout<T>(
  label: string,
  timeoutMs: number,
  promise: Promise<T>,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms during ${label}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function addTokenUsage(left: WorkflowTokenUsage, right: WorkflowTokenUsage): WorkflowTokenUsage {
  return {
    inputTokens: addOptionalNumber(left.inputTokens, right.inputTokens),
    outputTokens: addOptionalNumber(left.outputTokens, right.outputTokens),
    cachedInputTokens: addOptionalNumber(left.cachedInputTokens, right.cachedInputTokens),
  };
}

function addOptionalNumber(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}

function hasTokenUsage(usage: WorkflowTokenUsage): boolean {
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.cachedInputTokens !== undefined
  );
}

function formatCopilotUserInputRequiredError(request: CopilotUserInputRequest): string {
  return [
    "Copilot SDK requested user input during an in-loop workflow node.",
    `Question: ${request.question}`,
    request.choices?.length ? `Choices: ${request.choices.join(", ")}` : undefined,
    "The run must resolve this through Telegram elicitation or by replanning with decision-council nodes; the harness will not answer ask_user locally.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function createSourceToProjectUserInputRequestHandler(args: {
  project: ProjectCatalogEntry;
  source: string;
  notifier: SourceToProjectNotifier;
}): (request: CopilotUserInputRequest) => Promise<void> {
  return async (request) => {
    await args.notifier.notifyElicitation({
      question: formatCopilotUserInputQuestion(request),
      project: args.project,
      source: args.source,
    });
  };
}

function formatCopilotUserInputQuestion(request: CopilotUserInputRequest): string {
  return [
    request.question,
    request.choices?.length ? `Choices: ${request.choices.join(", ")}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

async function sendCopilotPromptAndWait(
  session: CopilotRuntimeSession,
  runArgs: {
    prompt: string;
    mode: "research" | "plan" | "implement" | "review";
    operation?: string;
    nodeId?: string;
    label?: string;
  },
  timeoutMs: number,
  diagnostics: {
    startedAt: number;
    model: string;
    cwd?: string;
    onLog?: (event: CopilotHarnessLogEvent) => void;
    onUsage?: (event: CopilotHarnessUsageEvent) => void;
    verboseEvents?: boolean;
  },
): Promise<string> {
  if (hasSendAndOn(session)) {
    return sendWithPartialAssistantFallback(session, runArgs, timeoutMs, diagnostics);
  }

  if (!session.sendAndWait) {
    throw new Error("Copilot SDK session does not expose send/sendAndWait.");
  }

  logCopilotHarnessEvent(
    diagnostics.onLog,
    {
      phase: "prompt-send",
      mode: runArgs.mode,
      model: diagnostics.model,
      cwd: diagnostics.cwd,
      timeoutMs,
      promptLength: runArgs.prompt.length,
      message: "using sendAndWait fallback",
      elapsedMs: elapsedSince(diagnostics.startedAt),
    },
    diagnostics.verboseEvents,
  );
  const response = await session.sendAndWait({ prompt: runArgs.prompt }, timeoutMs);
  const usage = extractUsageFromCopilotEventData(response?.data);
  if (usage) {
    diagnostics.onUsage?.({
      mode: runArgs.mode,
      model: diagnostics.model,
      cwd: diagnostics.cwd,
      operation: runArgs.operation,
      nodeId: runArgs.nodeId,
      label: runArgs.label,
      usage,
    });
  }
  return response?.data?.content ?? "";
}

function hasSendAndOn(
  session: CopilotRuntimeSession,
): session is CopilotRuntimeSession & Required<Pick<CopilotRuntimeSession, "send" | "on">> {
  return Boolean(session.send && session.on);
}

async function sendWithPartialAssistantFallback(
  session: Required<Pick<CopilotRuntimeSession, "send" | "on">>,
  runArgs: {
    prompt: string;
    mode: "research" | "plan" | "implement" | "review";
    operation?: string;
    nodeId?: string;
    label?: string;
  },
  timeoutMs: number,
  diagnostics: {
    startedAt: number;
    model: string;
    cwd?: string;
    onLog?: (event: CopilotHarnessLogEvent) => void;
    onUsage?: (event: CopilotHarnessUsageEvent) => void;
    verboseEvents?: boolean;
  },
): Promise<string> {
  let lastAssistantContent = "";
  let toolCallCount = 0;
  let accumulatedUsage: WorkflowTokenUsage = {};
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;

  const idlePromise = new Promise<void>((resolve, reject) => {
    unsubscribe = session.on((event) => {
      if (event.type === "tool.execution_start") {
        toolCallCount += 1;
      }
      if (event.type === "assistant.usage") {
        const usage = extractUsageFromCopilotEventData(event.data);
        if (usage) {
          accumulatedUsage = addTokenUsage(accumulatedUsage, usage);
        }
      }
      logCopilotHarnessEvent(
        diagnostics.onLog,
        {
          phase: "session-event",
          mode: runArgs.mode,
          model: diagnostics.model,
          cwd: diagnostics.cwd,
          eventType: event.type,
          toolName: event.data?.toolName ?? event.data?.name,
          toolCallCount: toolCallCount > 0 ? toolCallCount : undefined,
          elapsedMs: elapsedSince(diagnostics.startedAt),
        },
        diagnostics.verboseEvents,
      );
      if (event.type === "assistant.message") {
        lastAssistantContent = event.data?.content ?? lastAssistantContent;
        logCopilotHarnessEvent(
          diagnostics.onLog,
          {
            phase: "assistant-message",
            mode: runArgs.mode,
            model: diagnostics.model,
            cwd: diagnostics.cwd,
            contentLength: lastAssistantContent.length,
            elapsedMs: elapsedSince(diagnostics.startedAt),
          },
          diagnostics.verboseEvents,
        );
        return;
      }
      if (event.type === "session.idle") {
        logCopilotHarnessEvent(
          diagnostics.onLog,
          {
            phase: "session-idle",
            mode: runArgs.mode,
            model: diagnostics.model,
            cwd: diagnostics.cwd,
            elapsedMs: elapsedSince(diagnostics.startedAt),
          },
          diagnostics.verboseEvents,
        );
        resolve();
        return;
      }
      if (event.type === "session.error") {
        const error = new Error(event.data?.message ?? "Copilot SDK session error.");
        if (event.data?.stack) {
          error.stack = event.data.stack;
        }
        logCopilotHarnessEvent(
          diagnostics.onLog,
          {
            phase: "session-error",
            mode: runArgs.mode,
            model: diagnostics.model,
            cwd: diagnostics.cwd,
            message: error.message,
            elapsedMs: elapsedSince(diagnostics.startedAt),
          },
          diagnostics.verboseEvents,
        );
        reject(error);
      }
    });
  });

  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    logCopilotHarnessEvent(
      diagnostics.onLog,
      {
        phase: "prompt-send",
        mode: runArgs.mode,
        model: diagnostics.model,
        cwd: diagnostics.cwd,
        timeoutMs,
        promptLength: runArgs.prompt.length,
        elapsedMs: elapsedSince(diagnostics.startedAt),
      },
      diagnostics.verboseEvents,
    );
    await session.send({
      prompt: runArgs.prompt,
      ...(runArgs.mode === "plan" ? { agentMode: "plan" as const } : {}),
    });
    const outcome = await Promise.race([idlePromise.then(() => "idle" as const), timeoutPromise]);
    if (outcome === "timeout" && lastAssistantContent.trim()) {
      logCopilotHarnessEvent(
        diagnostics.onLog,
        {
          phase: "timeout-partial",
          mode: runArgs.mode,
          model: diagnostics.model,
          cwd: diagnostics.cwd,
          timeoutMs,
          contentLength: lastAssistantContent.length,
          elapsedMs: elapsedSince(diagnostics.startedAt),
        },
        diagnostics.verboseEvents,
      );
      return lastAssistantContent;
    }
    if (outcome === "timeout") {
      logCopilotHarnessEvent(
        diagnostics.onLog,
        {
          phase: "timeout",
          mode: runArgs.mode,
          model: diagnostics.model,
          cwd: diagnostics.cwd,
          timeoutMs,
          elapsedMs: elapsedSince(diagnostics.startedAt),
        },
        diagnostics.verboseEvents,
      );
      throw new Error(`Timeout after ${timeoutMs}ms waiting for session.idle`);
    }
    return lastAssistantContent;
  } finally {
    if (hasTokenUsage(accumulatedUsage)) {
      diagnostics.onUsage?.({
        mode: runArgs.mode,
        model: diagnostics.model,
        cwd: diagnostics.cwd,
        operation: runArgs.operation,
        nodeId: runArgs.nodeId,
        label: runArgs.label,
        usage: accumulatedUsage,
      });
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    unsubscribe?.();
  }
}

export function createSourceToProjectHarnessRegistry(
  options: SourceToProjectHarnessOptions,
): HarnessRegistry {
  const copilot = options.copilot ?? createOfflineSourceToProjectHarnessClient();
  const bamlClient = resolveBamlClient(options);
  const notifier = options.notifier ?? createDefaultSourceToProjectNotifier();
  const registry = createStaticHarnessRegistry();
  const copilotModelFor = (operation: SourceToProjectModelOperation) =>
    resolveCopilotModel(operation, options.sourceToProject);

  const researchAdapter: HarnessAdapter = async (node, context) => {
    if (node.id === "source-corroboration") {
      const sourceAnalysis = getPayloadValue<SourceAnalysis>(
        context,
        "source-reading",
        "sourceAnalysis",
      );
      const prompt = buildCorroborationPrompt(JSON.stringify(sourceAnalysis));
      const copilotModel = copilotModelFor(SourceToProjectModelOperation.SOURCE_CORROBORATION);
      const bamlModel = resolveBamlModel(SourceToProjectModelOperation.SOURCE_CORROBORATION);
      const raw = await copilot.run({
        prompt,
        mode: "research",
        model: copilotModel,
        operation: node.id,
        nodeId: node.id,
        label: "Copilot source corroboration",
      });
      const corroboration = await bamlClient.DistillCorroboration(sourceAnalysis, raw);
      return {
        status: "passed",
        output: `Corroboration complete for ${corroboration.sourceId}.`,
        payload: { corroboration },
        execution: buildExecutionMetadata(WorkflowHarnessKind.RESEARCH, [
          copilotCall({ mode: "research", prompt, model: copilotModel }),
          bamlCall("DistillCorroboration", bamlModel),
        ]),
      };
    }

    if (node.id === "opportunity-mapping") {
      const sourceAnalysis = getPayloadValue<SourceAnalysis>(
        context,
        "source-reading",
        "sourceAnalysis",
      );
      const corroboration = getPayloadValue<CorroborationReport>(
        context,
        "source-corroboration",
        "corroboration",
      );
      const projectBrief = getPayloadValue<ProjectBrief>(
        context,
        "project-research",
        "projectBrief",
      );
      const bamlModel = resolveBamlModel(SourceToProjectModelOperation.OPPORTUNITY_MAPPING);
      const councilInputReview = await bamlClient.MapSourceToProject(
        sourceAnalysis,
        corroboration,
        projectBrief,
      );
      return {
        status: "passed",
        output: `Mapped ${councilInputReview.opportunities.length} opportunities.`,
        payload: { councilInputReview },
        execution: buildExecutionMetadata(WorkflowHarnessKind.RESEARCH, [
          bamlCall("MapSourceToProject", bamlModel),
        ]),
      };
    }

    if (node.id === "recommended-advisory-package") {
      const plans = collectPlansFromDependencies(context, node);
      return {
        status: "passed",
        output: `Recommended advisory package prepared with ${plans.length} plan${plans.length === 1 ? "" : "s"}.`,
        payload: {
          plans,
          recommendedAdvisoryPackage: {
            planCount: plans.length,
            titles: plans.map((plan) => plan.title),
          },
        },
        execution: buildExecutionMetadata(WorkflowHarnessKind.RESEARCH, [
          {
            executor: WorkflowHarnessKind.RESEARCH,
            operation: node.id,
            prompt: node.prompt,
            model: node.model ?? "deterministic",
          },
        ]),
      };
    }

    return { status: "passed", output: `Research harness skipped unsupported node ${node.id}.` };
  };

  const councilAdapter: HarnessAdapter = async (node, context) => {
    if (node.id === "fan-in-opportunity-selection") {
      const plans = collectPlansFromDependencies(context, node);
      return {
        status: "passed",
        output: `Fan-in selected ${plans.length} advisory plan${plans.length === 1 ? "" : "s"}.`,
        payload: {
          plans,
          planSelection: {
            status: plans.length > 0 ? "selected" : "rejected",
            reason:
              plans.length > 0
                ? `Selected ${plans.length} candidate advisory plan${plans.length === 1 ? "" : "s"} for final recommendation review.`
                : "No candidate advisory plans were available for final recommendation review.",
            candidatesConsidered: plans.map((plan) => ({
              kind: "opportunity",
              id: plan.opportunityIds.join("+") || plan.title,
              title: plan.title,
              qualityScore: 1,
              sourceCoreFit: 1,
              metaInfrastructurePenalty: 0,
              opportunityIds: plan.opportunityIds,
            })),
          },
        },
        execution: buildExecutionMetadata(WorkflowHarnessKind.DECISION_COUNCIL, [
          {
            executor: WorkflowHarnessKind.DECISION_COUNCIL,
            operation: node.id,
            prompt: node.prompt,
            model: node.model ?? "deterministic",
          },
        ]),
      };
    }

    if (node.id !== "council-review") {
      return { status: "passed", output: `Council harness skipped unsupported node ${node.id}.` };
    }
    const councilInputReview = getPayloadValue<OpportunityCouncilReview>(
      context,
      "opportunity-mapping",
      "councilInputReview",
    );
    const thresholds = mergeThresholds(
      DEFAULT_SOURCE_TO_PROJECT_THRESHOLDS,
      options.thresholds,
      options.project.thresholds,
    );
    const opportunityAcceptances = selectAcceptedOpportunities(councilInputReview, thresholds);
    const councilDeliberationConfig = {
      ...defaultCouncilDeliberationConfig(),
      ...options.sourceToProject?.councilDeliberation,
    };
    const calls: WorkflowExecutionCall[] = [
      {
        executor: "decision-council",
        operation: "RankAndBundleOpportunities",
        prompt: node.prompt,
      },
    ];
    // Additive: the deterministic gate above remains authoritative for accept/reject decisions.
    // This real, agent-backed deliberation only enriches the payload/dashboard with genuine
    // persona critique; a disabled config or a failed deliberation never changes node status.
    let councilDeliberation: CouncilDeliberationResult | undefined;
    if (councilDeliberationConfig.enabled) {
      const deliberationInput = buildCouncilDeliberationInput({
        objective: context.objective,
        review: councilInputReview,
        acceptances: opportunityAcceptances,
        thresholds,
      });
      const deliberate = options.councilDeliberation ?? runCouncilDeliberation;
      councilDeliberation = await deliberate(deliberationInput, {
        maxRounds: councilDeliberationConfig.maxRounds,
      });
      if (councilDeliberation.status === "completed") {
        calls.push({
          executor: "decision-council",
          operation: "CouncilDeliberation",
          prompt: deliberationInput.prompt,
          model: councilDeliberation.model,
        });
      }
    }
    return {
      status: "passed",
      output: `Council ranked ${councilInputReview.opportunities.length} opportunities.`,
      payload: {
        councilReview: councilInputReview,
        opportunityAcceptances,
        ...(councilDeliberation ? { councilDeliberation } : {}),
      },
      execution: buildExecutionMetadata(WorkflowHarnessKind.DECISION_COUNCIL, calls),
    };
  };

  const copilotAdapter: HarnessAdapter = Object.assign(
    async (
      node: RuntimeWorkflowNode,
      context: WorkflowExecutionContext,
    ): Promise<HarnessExecutionResult> => {
      if (node.id === "visual-plan-preflight") {
        // Use the workflow runner's CWD (not the target project) so npm config (.npmrc trust policy etc.)
        // from the weavekit repo is respected when installing the visual-plan skill.
        const install = await ensureAgentNativeSkillInstalledForAdvisoryWorkflow({
          skill: "visual-plan",
          cwd: process.cwd(),
          shell: options.shell,
          offline: options.sourceToProject?.offline,
          tooling: options.tooling,
        });
        return {
          status: "passed",
          output:
            install.usable === false
              ? `visual-plan preflight warning: ${install.warning ?? "visual-plan hosted capability is unavailable; local visual-plan mode will still be attempted."}`
              : "visual-plan preflight complete.",
          payload: {
            visualPlanPreflight: {
              skill: "visual-plan",
              skillInstall: install,
            } satisfies AgentNativeSkillPreflightResult,
          },
          execution: buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
            skillInstallCall(install, options.project.workingTree),
          ]),
        };
      }

      if (node.id === "source-reading") {
        const maxToolCalls = sourceReadingMaxToolCalls(options.sourceToProject);
        const prompt = buildSourceReadingPrompt(
          options.source,
          maxToolCalls,
          options.prefetchedSourceContent,
        );
        const copilotModel = copilotModelFor(SourceToProjectModelOperation.SOURCE_READING);
        const bamlModel = resolveBamlModel(SourceToProjectModelOperation.SOURCE_READING);
        const raw = await copilot.run({
          prompt,
          mode: "research",
          model: copilotModel,
          maxToolCalls,
          operation: node.id,
          nodeId: node.id,
          label: "Copilot source reading",
        });
        const sourceAnalysis = await bamlClient.DistillSourceAnalysis(
          JSON.stringify({ source: options.source }),
          raw,
        );
        return {
          status: "passed",
          output: `Source analysis complete: ${sourceAnalysis.title}`,
          payload: { sourceAnalysis, rawSourceReading: raw },
          execution: buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
            copilotCall({ mode: "research", prompt, model: copilotModel }),
            bamlCall("DistillSourceAnalysis", bamlModel),
          ]),
        };
      }

      if (node.id === "project-research") {
        const projectJson = JSON.stringify(options.project);
        const sourceAnalysis = getOptionalPayloadValue<SourceAnalysis>(
          context,
          "source-reading",
          "sourceAnalysis",
        );
        const corroboration = getOptionalPayloadValue<CorroborationReport>(
          context,
          "source-corroboration",
          "corroboration",
        );
        const maxToolCalls = projectResearchMaxToolCalls(options.sourceToProject);
        const copilotModel = copilotModelFor(SourceToProjectModelOperation.PROJECT_RESEARCH);
        const bamlModel = resolveBamlModel(SourceToProjectModelOperation.PROJECT_RESEARCH);
        const prompt = buildProjectResearchPrompt({
          objective:
            context.objective ?? `Apply ${options.source} to ${options.project.displayName}`,
          projectJson,
          maxToolCalls,
          sourceAnalysisJson: sourceAnalysis ? JSON.stringify(sourceAnalysis) : undefined,
          corroborationJson: corroboration ? JSON.stringify(corroboration) : undefined,
        });
        const capabilityScope = projectResearchCapabilityScope(node, options.plugins);
        const raw = await copilot.run({
          cwd: options.project.workingTree,
          prompt,
          mode: "research",
          model: copilotModel,
          maxToolCalls,
          operation: node.id,
          nodeId: node.id,
          label: "Copilot project research",
          capabilityScope,
        });
        const projectBrief = await bamlClient.DistillProjectBrief(projectJson, raw);
        return {
          status: "passed",
          output: `Project brief complete: ${projectBrief.displayName}`,
          payload: { projectBrief, rawProjectResearch: raw },
          execution: buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
            copilotCall({
              mode: "research",
              cwd: options.project.workingTree,
              prompt,
              model: copilotModel,
              capabilityScope,
            }),
            bamlCall("DistillProjectBrief", bamlModel),
          ]),
        };
      }

      if (isOpportunityPlanNode(node)) {
        const opportunity = readNodeInput<Opportunity>(node, "opportunity");
        const acceptance = readNodeInput<OpportunityAcceptance>(node, "opportunityAcceptance");
        const projectBrief = getPayloadValue<ProjectBrief>(
          context,
          "project-research",
          "projectBrief",
        );
        const rawSourceReading = getOptionalPayloadValue<string>(
          context,
          "source-reading",
          "rawSourceReading",
        );
        const rawProjectResearch = getOptionalPayloadValue<string>(
          context,
          "project-research",
          "rawProjectResearch",
        );
        const resolvedPlan = resolveOpportunityPlanExecution(
          node,
          context,
          options.project,
          options.sourceToProject,
          projectBrief,
          {
            rawSourceReading: rawSourceReading ?? undefined,
            rawProjectResearch: rawProjectResearch ?? undefined,
          },
        );
        const { prompt, selectedCandidateJson, copilotModel, rawPlanArtifactPath } = resolvedPlan;
        const bamlModel = resolveBamlModel(SourceToProjectModelOperation.PLAN_DISTILLATION);
        let capturedSessionId: string | undefined;
        const rawPlan = await copilot.run({
          cwd: options.project.workingTree,
          prompt,
          mode: "plan",
          model: copilotModel,
          operation: node.id,
          nodeId: node.id,
          label: `Copilot plan ${opportunity.id}`,
          onSessionId: (id) => {
            capturedSessionId = id;
          },
        });
        const fullPlanContent = capturedSessionId
          ? await readCopilotSessionPlan(capturedSessionId)
          : undefined;
        const persistedPlan = await persistRawPlanMarkdown({
          outputDir: context.outputDir,
          nodeId: node.id,
          rawPlan,
          rawPlanArtifactPath,
          fullPlanContent,
        });
        const planSummary = withRawPlanArtifactPath(
          await bamlClient.DistillPlanArtifact(
            selectedCandidateJson,
            fullPlanContent ?? rawPlan,
            rawPlanArtifactPath,
          ),
          rawPlanArtifactPath,
          persistedPlan.planFilePath,
        );
        return {
          status: "passed",
          output: `Plan artifact complete for ${opportunity.id}: ${planSummary.title}`,
          payload: { plan: planSummary, plans: [planSummary], opportunityAcceptance: acceptance },
          artifacts: persistedPlan.artifacts,
          execution: buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
            copilotCall({
              mode: "plan",
              cwd: options.project.workingTree,
              prompt,
              model: copilotModel,
            }),
            bamlCall("DistillPlanArtifact", bamlModel),
          ]),
        };
      }

      if (node.id === "plan-selected-opportunities") {
        const councilReview = readCouncilReview(context);
        const projectBrief = getPayloadValue<ProjectBrief>(
          context,
          "project-research",
          "projectBrief",
        );
        const selection = selectPlanCandidate(councilReview, projectBrief, {
          maxOpportunities: options.maxOpportunities ?? options.project.maxOpportunities ?? 1,
          thresholds: mergeThresholds(
            DEFAULT_SOURCE_TO_PROJECT_THRESHOLDS,
            options.thresholds,
            options.project.thresholds,
          ),
        });
        if (selection.status === "rejected" || !selection.selectedCandidate) {
          return {
            status: "passed",
            output: `No actionable source-to-project plan selected: ${selection.reason}`,
            payload: { plans: [], planSelection: selection },
            execution: buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, []),
          };
        }

        const selectedCandidateJson = JSON.stringify(selection.selectedCandidate);
        const rawPlanArtifactPath = rawPlanArtifactPathForNode(node.id);
        const rawSourceReadingSel = getOptionalPayloadValue<string>(
          context,
          "source-reading",
          "rawSourceReading",
        );
        const rawProjectResearchSel = getOptionalPayloadValue<string>(
          context,
          "project-research",
          "rawProjectResearch",
        );
        const prompt = buildPlanPrompt(
          selectedCandidateJson,
          JSON.stringify(projectBrief),
          rawPlanArtifactPath,
          {
            rawSourceReading: rawSourceReadingSel ?? undefined,
            rawProjectResearch: rawProjectResearchSel ?? undefined,
          },
        );
        const copilotModel = copilotModelFor(SourceToProjectModelOperation.PLAN_GENERATION);
        const bamlModel = resolveBamlModel(SourceToProjectModelOperation.PLAN_DISTILLATION);
        let capturedSessionIdSel: string | undefined;
        const rawPlan = await copilot.run({
          cwd: options.project.workingTree,
          prompt,
          mode: "plan",
          model: copilotModel,
          operation: node.id,
          nodeId: node.id,
          label: "Copilot selected-opportunity plan",
          onSessionId: (id) => {
            capturedSessionIdSel = id;
          },
        });
        const fullPlanContent = capturedSessionIdSel
          ? await readCopilotSessionPlan(capturedSessionIdSel)
          : undefined;
        const persistedPlan = await persistRawPlanMarkdown({
          outputDir: context.outputDir,
          nodeId: node.id,
          rawPlan,
          rawPlanArtifactPath,
          fullPlanContent,
        });
        const planSummary = withRawPlanArtifactPath(
          await bamlClient.DistillPlanArtifact(
            selectedCandidateJson,
            fullPlanContent ?? rawPlan,
            rawPlanArtifactPath,
          ),
          rawPlanArtifactPath,
          persistedPlan.planFilePath,
        );
        return {
          status: "passed",
          output: `Plan artifact complete: ${planSummary.title}`,
          payload: { plans: [planSummary], planSelection: selection },
          artifacts: persistedPlan.artifacts,
          execution: buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
            copilotCall({
              mode: "plan",
              cwd: options.project.workingTree,
              prompt,
              model: copilotModel,
            }),
            bamlCall("DistillPlanArtifact", bamlModel),
          ]),
        };
      }

      if (isOpportunityReviewNode(node)) {
        const opportunity = readNodeInput<Opportunity>(node, "opportunity");
        const acceptance = readNodeInput<OpportunityAcceptance>(node, "opportunityAcceptance");
        const planNodeId = node.dependsOn[0];
        if (!planNodeId) {
          throw new Error(`Opportunity review node ${node.id} is missing its plan dependency.`);
        }
        const plan = getPayloadValue<PlanArtifactSummary>(context, planNodeId, "plan");
        const sourceAnalysis = getPayloadValue<SourceAnalysis>(
          context,
          "source-reading",
          "sourceAnalysis",
        );
        const corroboration = getPayloadValue<CorroborationReport>(
          context,
          "source-corroboration",
          "corroboration",
        );
        const projectBrief = getPayloadValue<ProjectBrief>(
          context,
          "project-research",
          "projectBrief",
        );
        const originalPrompt = options.originalPrompt ?? context.objective ?? "";
        const bamlModel = resolveBamlModel(
          SourceToProjectModelOperation.FINAL_RECOMMENDATION_REVIEW,
        );
        const rawFinalRecommendationReview = await bamlClient.ReviewFinalRecommendation(
          originalPrompt,
          options.source,
          sourceAnalysis,
          corroboration,
          projectBrief,
          [plan],
        );
        let finalRecommendationReview: FinalRecommendationReview = rawFinalRecommendationReview;
        if (rawFinalRecommendationReview.status === "rejected") {
          const rejectedReview = withTelegramSummary(
            rawFinalRecommendationReview,
            `${options.source}#${opportunity.id}`,
          );
          finalRecommendationReview = rejectedReview;
        }
        return {
          status: "passed",
          output:
            finalRecommendationReview.status === "accepted"
              ? `Opportunity ${opportunity.id} review accepted the plan.`
              : `Opportunity ${opportunity.id} review rejected the plan: ${finalRecommendationReview.rejectionReason ?? finalRecommendationReview.rationale}`,
          payload: { finalRecommendationReview, opportunityAcceptance: acceptance, plan },
          execution: buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
            bamlCall("ReviewFinalRecommendation", bamlModel),
          ]),
        };
      }

      if (isOpportunityVisualDesignNode(node)) {
        const opportunity = readNodeInput<Opportunity>(node, "opportunity");
        const reportNodeId = node.dependsOn[0];
        if (!reportNodeId) {
          throw new Error(
            `Opportunity visual design node ${node.id} is missing its report dependency.`,
          );
        }
        const reportMarkdown = getPayloadValue<string>(
          context,
          reportNodeId,
          "sourceToProjectReportMarkdown",
        );
        const preflight = getOptionalPayloadValue<AgentNativeSkillPreflightResult>(
          context,
          "visual-plan-preflight",
          "visualPlanPreflight",
        );
        const install =
          preflight?.skillInstall ??
          (await ensureAgentNativeSkillInstalled({
            skill: "visual-plan",
            cwd: options.project.workingTree,
            shell: options.shell,
            offline: options.sourceToProject?.offline,
            tooling: options.tooling,
          }));
        const prompt = buildVisualPlanPrompt({
          opportunity,
          reportMarkdown,
        });
        const copilotModel = copilotModelFor(SourceToProjectModelOperation.VISUAL_DESIGN);
        const capabilityScope = visualPlanSkillCapabilityScope(
          options.project.workingTree,
          options.tooling,
        );
        const rawVisualPlan = await copilot.run({
          cwd: options.project.workingTree,
          prompt,
          mode: "plan",
          model: copilotModel,
          operation: node.id,
          nodeId: node.id,
          label: `Copilot visual design ${opportunity.id}`,
          capabilityScope,
        });
        const hostedArtifactUrl = validateHostedVisualPlanArtifact(rawVisualPlan);
        const bridgeCleanup = scheduleVisualPlanBridgeCleanup({
          hostedArtifactUrl,
          cleanupAfterMs: resolveVisualPlanBridgeCleanupTtlMs(options.visualPlanBridgeCleanupTtlMs),
          scheduler: options.visualPlanBridgeCleanup,
        });
        return {
          status: "passed",
          output: `Visual design complete for opportunity ${opportunity.id}.`,
          payload: {
            sourceToProjectVisualPlan: {
              opportunityId: opportunity.id,
              title: opportunity.title,
              sourceReportNodeId: reportNodeId,
              skill: "visual-plan",
              skillInstall: install,
              rawVisualPlan,
              hostedArtifactUrl,
              bridgeCleanup,
            },
          },
          execution: buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
            skillInstallCall(install, options.project.workingTree),
            copilotCall({
              mode: "plan",
              cwd: options.project.workingTree,
              prompt,
              model: copilotModel,
              capabilityScope,
            }),
          ]),
        };
      }

      if (isFinalRecommendationReviewNode(node)) {
        const upstreamNodeId = node.dependsOn[0];
        const plans =
          node.id === "final-recommendation-review"
            ? getPayloadValue<PlanArtifactSummary[]>(
                context,
                "plan-selected-opportunities",
                "plans",
              )
            : collectPlansFromDependencies(context, node);
        const planSelection =
          node.id === "final-recommendation-review"
            ? getOptionalPayloadValue<PlanSelection>(
                context,
                "plan-selected-opportunities",
                "planSelection",
              )
            : upstreamNodeId
              ? getOptionalPayloadValue<PlanSelection>(context, upstreamNodeId, "planSelection")
              : undefined;
        const sourceAnalysis = getPayloadValue<SourceAnalysis>(
          context,
          "source-reading",
          "sourceAnalysis",
        );
        const corroboration = getPayloadValue<CorroborationReport>(
          context,
          "source-corroboration",
          "corroboration",
        );
        const projectBrief = getPayloadValue<ProjectBrief>(
          context,
          "project-research",
          "projectBrief",
        );
        const originalPrompt = options.originalPrompt ?? context.objective ?? "";
        const bamlModel = resolveBamlModel(
          SourceToProjectModelOperation.FINAL_RECOMMENDATION_REVIEW,
        );
        const rawFinalRecommendationReview =
          plans.length === 0
            ? buildNoPlanReview(planSelection)
            : await bamlClient.ReviewFinalRecommendation(
                originalPrompt,
                options.source,
                sourceAnalysis,
                corroboration,
                projectBrief,
                plans,
              );
        let finalRecommendationReview: FinalRecommendationReview = rawFinalRecommendationReview;
        let notification: SourceToProjectNotificationResult | undefined;
        if (rawFinalRecommendationReview.status === "rejected") {
          const rejectedReview = withTelegramSummary(rawFinalRecommendationReview, options.source);
          finalRecommendationReview = rejectedReview;
          notification = await notifier.notifyRejection({
            review: rejectedReview,
            project: options.project,
            source: options.source,
          });
        }
        return {
          status: "passed",
          output:
            finalRecommendationReview.status === "accepted"
              ? "Final recommendation review accepted the plan."
              : `Final recommendation review rejected the plan: ${finalRecommendationReview.rejectionReason ?? finalRecommendationReview.rationale}`,
          payload: { finalRecommendationReview, notification, plans, planSelection },
          execution: buildExecutionMetadata(
            WorkflowHarnessKind.COPILOT_SDK,
            plans.length === 0 ? [] : [bamlCall("ReviewFinalRecommendation", bamlModel)],
          ),
        };
      }

      if (node.id === "implement-selected-bundles" || node.id === "fix-review-findings") {
        const worktreePath = getPayloadValue<WorktreePreparationResult>(
          context,
          "prepare-worktree",
          "worktreePreparation",
        ).worktreePath;
        const operation =
          node.id === "fix-review-findings"
            ? SourceToProjectModelOperation.IMPLEMENTATION_FIX
            : SourceToProjectModelOperation.IMPLEMENTATION;
        const copilotModel = copilotModelFor(operation);
        const prompt =
          node.id === "fix-review-findings"
            ? [
                node.prompt,
                "",
                "Blocking findings to fix:",
                ...getPayloadValue<ImplementationReviewVerdict>(
                  context,
                  "review-implementation",
                  "implementationReviewVerdict",
                ).blockingFindings.map((finding) => `- ${finding}`),
              ].join("\n")
            : node.prompt;
        const raw = await copilot.run({
          cwd: worktreePath,
          prompt,
          mode: "implement",
          model: copilotModel,
          operation: node.id,
          nodeId: node.id,
          label:
            node.id === "fix-review-findings"
              ? "Copilot fix review findings"
              : "Copilot implementation",
        });
        return {
          status: "passed",
          output: "Implementation complete.",
          payload: { implementationSummary: raw },
          execution: buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
            copilotCall({
              mode: "implement",
              cwd: worktreePath,
              prompt,
              model: copilotModel,
            }),
          ]),
        };
      }

      if (node.id === "review-implementation" || node.id === "re-review-implementation") {
        const isReReview = node.id === "re-review-implementation";
        const worktreePath = getPayloadValue<WorktreePreparationResult>(
          context,
          "prepare-worktree",
          "worktreePreparation",
        ).worktreePath;
        const implementationSummary = getPayloadValue<string>(
          context,
          isReReview ? "fix-review-findings" : "implement-selected-bundles",
          "implementationSummary",
        );
        const verificationSummary = getPayloadValue<string>(
          context,
          isReReview ? "verify-review-fixes" : "verify-implementation",
          "verificationSummary",
        );
        const priorVerdict = isReReview
          ? getPayloadValue<ImplementationReviewVerdict>(
              context,
              "review-implementation",
              "implementationReviewVerdict",
            )
          : undefined;
        const prompt = await buildImplementationReviewPrompt({
          implementationSummary,
          verificationSummary,
          priorVerdict,
        });
        const copilotModel = copilotModelFor(SourceToProjectModelOperation.IMPLEMENTATION_REVIEW);
        const raw = await copilot.run({
          cwd: worktreePath,
          prompt,
          mode: "review",
          model: copilotModel,
          operation: node.id,
          nodeId: node.id,
          label: isReReview ? "Copilot implementation re-review" : "Copilot implementation review",
        });
        const implementationReviewVerdict = parseImplementationReviewVerdict(raw);
        return {
          status: "passed",
          output:
            implementationReviewVerdict.status === "accepted"
              ? "Implementation review accepted."
              : "Implementation review requires changes.",
          payload: { implementationReviewVerdict, rawReviewSummary: raw },
          execution: buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
            copilotCall({
              mode: "review",
              cwd: worktreePath,
              prompt,
              model: copilotModel,
            }),
          ]),
        };
      }

      return {
        status: "passed",
        output: `Copilot SDK harness skipped unsupported node ${node.id}.`,
      };
    },
    {
      async prepareExecution(node: RuntimeWorkflowNode, context: WorkflowExecutionContext) {
        if (!isOpportunityPlanNode(node)) {
          return undefined;
        }
        return resolveOpportunityPlanExecution(
          node,
          context,
          options.project,
          options.sourceToProject,
        ).execution;
      },
    },
  );

  const verifierAdapter: HarnessAdapter = async (node, context) => {
    if (node.id === "prepare-worktree") {
      const worktreePreparation = await (options.worktree?.prepare() ??
        prepareAutonomousWorktree({
          sourceWorkingTree: options.project.workingTree,
          worktreeRoot: join(options.project.workingTree, ".."),
          branchName: `source-to-project/${Date.now()}`,
          mainline: options.project.mainline,
        }));
      return {
        status: "passed",
        output: `Prepared worktree ${worktreePreparation.worktreePath} at ${worktreePreparation.baselineCommit}`,
        payload: { worktreePreparation },
      };
    }

    if (node.id === "verify-implementation" || node.id === "verify-review-fixes") {
      const worktreePath = getPayloadValue<WorktreePreparationResult>(
        context,
        "prepare-worktree",
        "worktreePreparation",
      ).worktreePath;
      const validation = await runValidationCommands(
        options.project.validationCommands,
        worktreePath,
        options.shell,
      );
      return {
        status: "passed",
        output: "Verification complete.",
        payload: { verificationSummary: validation },
        execution: buildExecutionMetadata(
          WorkflowHarnessKind.VERIFIER,
          options.project.validationCommands.map((command) => ({
            executor: "shell",
            operation: command,
            cwd: worktreePath,
          })),
        ),
      };
    }

    return { status: "passed", output: "Verification complete." };
  };

  const reporterAdapter: HarnessAdapter = async (node, context) => {
    if (node.id === "open-pr") {
      const initialVerdict = getPayloadValue<ImplementationReviewVerdict>(
        context,
        "review-implementation",
        "implementationReviewVerdict",
      );
      const applicableVerdict =
        initialVerdict.status === "accepted"
          ? initialVerdict
          : getOptionalPayloadValue<ImplementationReviewVerdict>(
              context,
              "re-review-implementation",
              "implementationReviewVerdict",
            );
      if (!applicableVerdict || applicableVerdict.status !== "accepted") {
        const rejectedVerdict = applicableVerdict ?? initialVerdict;
        return {
          status: "failed",
          output: "Implementation review did not accept the autonomous pull request.",
          error: rejectedVerdict.blockingFindings.join("\n"),
          payload: { finalImplementationReviewVerdict: rejectedVerdict },
          execution: reporterExecution(node),
        };
      }
      const worktreePath = getPayloadValue<WorktreePreparationResult>(
        context,
        "prepare-worktree",
        "worktreePreparation",
      ).worktreePath;
      const prUrl = await openPullRequest(worktreePath, options.shell);
      return {
        status: "passed",
        output: "Pull request prepared.",
        payload: { prUrl, finalImplementationReviewVerdict: applicableVerdict },
        execution: reporterExecution(node),
      };
    }
    if (
      node.id === "visual-multiple-opportunity-map" ||
      node.id === "visual-nonapplicability-summary"
    ) {
      const reportNodeId = node.dependsOn[0];
      const reportMarkdown = reportNodeId
        ? getOptionalPayloadValue<string>(context, reportNodeId, "sourceToProjectReportMarkdown")
        : undefined;
      const rawVisualPlan = [
        `# ${node.title}`,
        "",
        "Deterministic source-to-project visualization summary.",
        "",
        reportMarkdown ?? "No source-to-project report markdown was available.",
      ].join("\n");
      return {
        status: "passed",
        output: rawVisualPlan,
        payload: {
          sourceToProjectVisualPlan: {
            title: node.title,
            sourceReportNodeId: reportNodeId,
            skill: "deterministic-reporter",
            rawVisualPlan,
          },
        },
        execution: reporterExecution(node),
      };
    }
    if (isOpportunityVisualizationNode(node)) {
      const opportunity = readNodeInput<Opportunity>(node, "opportunity");
      const acceptance = readNodeInput<OpportunityAcceptance>(node, "opportunityAcceptance");
      const reviewNodeId = node.dependsOn[0];
      const review = reviewNodeId
        ? getPayloadValue<FinalRecommendationReview>(
            context,
            reviewNodeId,
            "finalRecommendationReview",
          )
        : undefined;
      const plan = reviewNodeId
        ? getOptionalPayloadValue<PlanArtifactSummary>(context, reviewNodeId, "plan")
        : undefined;
      const status = review?.status ?? "rejected";
      return {
        status: "passed",
        output: [
          `Opportunity ${opportunity.id} visualization ${status}.`,
          `Acceptance average: ${acceptance.acceptanceAverage.toFixed(2)}.`,
          plan?.recommendation ? `Recommendation: ${plan.recommendation}` : undefined,
          review?.rationale ? `Review: ${review.rationale}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
        payload: {
          opportunityVisualization: {
            opportunityId: opportunity.id,
            title: opportunity.title,
            status,
            acceptanceAverage: acceptance.acceptanceAverage,
            recommendation: plan?.recommendation,
            rationale: review?.rationale,
          },
          opportunityAcceptance: acceptance,
          plan,
          finalRecommendationReview: review,
        },
        execution: reporterExecution(node),
      };
    }
    if (isOpportunityReportNode(node)) {
      const opportunity = readNodeInput<Opportunity>(node, "opportunity");
      const acceptance = readNodeInput<OpportunityAcceptance>(node, "opportunityAcceptance");
      const upstreamNodeId = node.dependsOn[0];
      const visualization = upstreamNodeId
        ? getOptionalPayloadValue<Record<string, unknown>>(
            context,
            upstreamNodeId,
            "opportunityVisualization",
          )
        : undefined;
      const finalRecommendationReview = upstreamNodeId
        ? getOptionalPayloadValue<FinalRecommendationReview>(
            context,
            upstreamNodeId,
            "finalRecommendationReview",
          )
        : undefined;
      const plan = upstreamNodeId
        ? getOptionalPayloadValue<PlanArtifactSummary>(context, upstreamNodeId, "plan")
        : undefined;
      const status =
        finalRecommendationReview?.status ??
        (typeof visualization?.status === "string" ? visualization.status : "rejected");
      const rawPlanMarkdown = await readRawPlanMarkdownForReport(
        context.outputDir,
        plan?.rawPlanArtifactPath,
        plan?.planFilePath,
      );
      const sourceToProjectReportMarkdown = buildOpportunityReportMarkdown({
        mode: options.mode,
        opportunity,
        acceptance,
        status,
        plan,
        finalRecommendationReview,
        rawPlanMarkdown,
      });
      const autoImplementLaunch = await maybeAutoImplementOpportunity({
        options,
        context,
        node,
        opportunity,
        plan,
        status,
        reportMarkdown: sourceToProjectReportMarkdown,
      });
      return {
        status: "passed",
        output: sourceToProjectReportMarkdown,
        payload: {
          sourceToProjectReport: {
            opportunityId: opportunity.id,
            title: opportunity.title,
            status,
            acceptanceAverage: acceptance.acceptanceAverage,
            recommendation: plan?.recommendation,
            rationale: finalRecommendationReview?.rationale,
          },
          sourceToProjectReportMarkdown,
          ...(autoImplementLaunch ? { autoImplementLaunch } : {}),
          ...(rawPlanMarkdown ? { rawPlanMarkdown } : {}),
          opportunityAcceptance: acceptance,
          opportunityVisualization: visualization,
          plan,
          finalRecommendationReview,
        },
        execution: reporterExecution(node),
      };
    }
    if (node.id === "report-no-accepted-opportunities") {
      const acceptedOpportunityCount = Number(node.input?.acceptedOpportunityCount ?? 0);
      const rejectedOpportunityCount = Number(node.input?.rejectedOpportunityCount ?? 0);
      const sourceToProjectReportMarkdown = [
        "# Source-to-Project Report",
        "",
        `- Mode: ${options.mode}`,
        `- Accepted opportunities: ${acceptedOpportunityCount}`,
        `- Rejected opportunities: ${rejectedOpportunityCount}`,
        "",
        "No accepted opportunities passed the source-to-project gates.",
      ].join("\n");
      return {
        status: "passed",
        output: sourceToProjectReportMarkdown,
        payload: {
          acceptedOpportunityCount,
          rejectedOpportunityCount,
          opportunityAcceptances: node.input?.opportunityAcceptances,
          sourceToProjectReportMarkdown,
        },
        execution: reporterExecution(node),
      };
    }
    if (node.id === "report-multiple-opportunities") {
      const upstreamNodeId = node.dependsOn[0];
      const finalRecommendationReview = upstreamNodeId
        ? getOptionalPayloadValue<FinalRecommendationReview>(
            context,
            upstreamNodeId,
            "finalRecommendationReview",
          )
        : undefined;
      const plans = collectPlansFromDependencies(context, node);
      const rawPlanMarkdownByPlanIndex = await Promise.all(
        plans.map((plan) =>
          readRawPlanMarkdownForReport(
            context.outputDir,
            plan.rawPlanArtifactPath,
            plan.planFilePath,
          ),
        ),
      );
      const sourceToProjectReportMarkdown = buildAggregateReportMarkdown({
        mode: options.mode,
        plans,
        finalRecommendationReview,
        rawPlanMarkdownByPlanIndex,
      });
      return {
        status: "passed",
        output: sourceToProjectReportMarkdown,
        payload: {
          sourceToProjectReportMarkdown,
          sourceToProjectReport: {
            planCount: plans.length,
            status: finalRecommendationReview?.status ?? "unknown",
            rationale: finalRecommendationReview?.rationale,
          },
          plans,
          ...(rawPlanMarkdownByPlanIndex.some(Boolean) ? { rawPlanMarkdownByPlanIndex } : {}),
          finalRecommendationReview,
        },
        execution: reporterExecution(node),
      };
    }
    return {
      status: "passed",
      output: `Source-to-project ${options.mode} report generated.`,
      payload: {
        acceptedOpportunityCount: node.input?.acceptedOpportunityCount,
        rejectedOpportunityCount: node.input?.rejectedOpportunityCount,
        opportunityAcceptances: node.input?.opportunityAcceptances,
      },
      execution: reporterExecution(node),
    };
  };

  registry.set(WorkflowHarnessKind.RESEARCH, researchAdapter);
  registry.set(WorkflowHarnessKind.DECISION_COUNCIL, councilAdapter);
  registry.set(WorkflowHarnessKind.COPILOT_SDK, copilotAdapter);
  registry.set(WorkflowHarnessKind.VERIFIER, verifierAdapter);
  registry.set(WorkflowHarnessKind.REPORTER, reporterAdapter);
  return registry;
}

export function createSourceToProjectDynamicExpander(
  options: SourceToProjectHarnessOptions,
): WorkflowDynamicExpander {
  return ({ node, result }) => {
    if (node.id !== "council-review" || result.status !== "passed") {
      return undefined;
    }

    const councilReview = result.payload?.councilReview as OpportunityCouncilReview | undefined;
    if (!councilReview) {
      return undefined;
    }

    const thresholds = mergeThresholds(
      DEFAULT_SOURCE_TO_PROJECT_THRESHOLDS,
      options.thresholds,
      options.project.thresholds,
    );
    const opportunityAcceptances = selectAcceptedOpportunities(councilReview, thresholds);
    const allAccepted = opportunityAcceptances.filter((acceptance) => acceptance.accepted);
    if (allAccepted.length === 0) {
      return [
        {
          id: "report-no-accepted-opportunities",
          kind: WorkflowNodeKind.REPORT,
          harness: WorkflowHarnessKind.REPORTER,
          title: "Report source-to-project result",
          description:
            "Publish a deterministic report explaining that no opportunities passed the acceptance gates.",
          ...nodeModelMetadata(SourceToProjectModelOperation.DETERMINISTIC),
          prompt: `Publish the final ${options.mode} report for 0 accepted opportunities.`,
          input: {
            acceptedOpportunityCount: 0,
            rejectedOpportunityCount: opportunityAcceptances.length,
            opportunityAcceptances,
          },
          dependsOn: ["council-review"],
          gates: [WorkflowGateKind.OUTPUT_CONTRACT],
          writeMode: "read-only",
          replanPolicy: "never",
        },
      ];
    }

    // 0 or undefined means unlimited: promote every candidate that clears the acceptance
    // thresholds instead of arbitrarily capping how many high-confidence candidates proceed.
    const maxOpportunities = options.maxOpportunities ?? options.project.maxOpportunities ?? 0;
    const promotedCandidates = selectPromotedAcceptedCandidates(
      councilReview,
      allAccepted,
      maxOpportunities,
    );

    const opportunityNodes = promotedCandidates.flatMap((candidate) =>
      buildOpportunityFanOutNodes(candidate.acceptance, candidate.selectedCandidate),
    );
    return options.mode === "autonomous-pr"
      ? [
          ...opportunityNodes,
          ...buildAutonomousPrNodes(promotedCandidates.map((candidate) => candidate.acceptance)),
        ]
      : opportunityNodes;
  };
}

export function selectAcceptedOpportunities(
  review: OpportunityCouncilReview,
  thresholds: SourceToProjectThresholds,
): OpportunityAcceptance[] {
  return review.opportunities.map((opportunity) => {
    const acceptanceAverage = opportunityAcceptanceAverage(opportunity);
    const scores = {
      applicability: opportunity.score.applicability,
      applicabilityReasoning: opportunity.score.applicabilityReasoning,
      impact: opportunity.score.impact,
      impactReasoning: opportunity.score.impactReasoning,
      confidence: opportunity.score.confidence,
      confidenceReasoning: opportunity.score.confidenceReasoning,
      risk: opportunity.score.risk,
      riskReasoning: opportunity.score.riskReasoning,
    };
    if (opportunity.evidence.length === 0) {
      return {
        id: opportunity.id,
        title: opportunity.title,
        accepted: false,
        reason: "Rejected because the opportunity has no supporting evidence.",
        acceptanceAverage,
        scores,
        opportunity,
      };
    }
    if (opportunity.speculative) {
      return {
        id: opportunity.id,
        title: opportunity.title,
        accepted: false,
        reason: "Rejected because the opportunity is marked speculative.",
        acceptanceAverage,
        scores,
        opportunity,
      };
    }
    if (opportunity.score.risk > thresholds.maxRisk) {
      return {
        id: opportunity.id,
        title: opportunity.title,
        accepted: false,
        reason: `Rejected because risk ${opportunity.score.risk.toFixed(2)} exceeds ${thresholds.maxRisk.toFixed(2)}.`,
        acceptanceAverage,
        scores,
        opportunity,
      };
    }
    if (acceptanceAverage < thresholds.minAcceptanceAverage) {
      return {
        id: opportunity.id,
        title: opportunity.title,
        accepted: false,
        reason: `Rejected because acceptance average ${acceptanceAverage.toFixed(2)} is below ${thresholds.minAcceptanceAverage.toFixed(2)}.`,
        acceptanceAverage,
        scores,
        opportunity,
      };
    }
    return {
      id: opportunity.id,
      title: opportunity.title,
      accepted: true,
      reason: `Accepted with ${acceptanceAverage.toFixed(2)} average applicability, impact, and confidence.`,
      acceptanceAverage,
      scores,
      opportunity,
    };
  });
}

function selectPromotedAcceptedCandidates(
  review: OpportunityCouncilReview,
  accepted: OpportunityAcceptance[],
  maxOpportunities: number,
): Array<{ acceptance: OpportunityAcceptance; selectedCandidate?: PlanCandidate }> {
  const sortedAccepted = [...accepted].sort((a, b) => b.acceptanceAverage - a.acceptanceAverage);
  const acceptedById = new Map(sortedAccepted.map((acceptance) => [acceptance.id, acceptance]));
  const opportunityById = new Map(
    review.opportunities.map((opportunity) => [opportunity.id, opportunity]),
  );
  const selected: Array<{ acceptance: OpportunityAcceptance; selectedCandidate?: PlanCandidate }> =
    [];
  const coveredOpportunityIds = new Set<string>();

  const bundleCandidates = review.bundles
    .map((bundle, index) => {
      const uniqueOpportunityIds = [...new Set(bundle.opportunityIds)];
      const acceptedMembers = uniqueOpportunityIds
        .map((id) => acceptedById.get(id))
        .filter((acceptance): acceptance is OpportunityAcceptance => Boolean(acceptance));
      if (
        !isValidPromotionBundle(bundle) ||
        uniqueOpportunityIds.length !== bundle.opportunityIds.length ||
        acceptedMembers.length !== uniqueOpportunityIds.length ||
        acceptedMembers.length < 2
      ) {
        return undefined;
      }
      const acceptanceAverage =
        acceptedMembers.reduce((sum, acceptance) => sum + acceptance.acceptanceAverage, 0) /
        acceptedMembers.length;
      return { bundle, acceptedMembers, acceptanceAverage, index };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort(
      (left, right) =>
        right.acceptedMembers.length - left.acceptedMembers.length ||
        right.acceptanceAverage - left.acceptanceAverage ||
        left.index - right.index,
    );

  for (const candidate of bundleCandidates) {
    const uncoveredAcceptedMembers = candidate.acceptedMembers.filter(
      (acceptance) => !coveredOpportunityIds.has(acceptance.id),
    );
    if (uncoveredAcceptedMembers.length < 2) {
      continue;
    }
    const memberOpportunities = candidate.bundle.opportunityIds
      .map((id) => opportunityById.get(id))
      .filter((opportunity): opportunity is Opportunity => Boolean(opportunity));
    const acceptedMemberOpportunities = uncoveredAcceptedMembers.map(
      (acceptance) => acceptance.opportunity,
    );
    const score = averageOpportunityScore(acceptedMemberOpportunities);
    const evidence = acceptedMemberOpportunities.flatMap((opportunity) => opportunity.evidence);
    const syntheticOpportunity: Opportunity = {
      id: candidate.bundle.id,
      title: candidate.bundle.id,
      lesson: acceptedMemberOpportunities.map((opportunity) => opportunity.lesson).join("\n"),
      projectChange: candidate.bundle.maxPrScope,
      changeSurface: candidate.bundle.sharedChangeSurface,
      score: {
        ...score,
        applicabilityReasoning: summarizeBundleMemberReasoning(
          acceptedMemberOpportunities,
          (opportunity) => opportunity.score.applicabilityReasoning,
        ),
        impactReasoning: summarizeBundleMemberReasoning(
          acceptedMemberOpportunities,
          (opportunity) => opportunity.score.impactReasoning,
        ),
        confidenceReasoning: summarizeBundleMemberReasoning(
          acceptedMemberOpportunities,
          (opportunity) => opportunity.score.confidenceReasoning,
        ),
        implementationCostReasoning: summarizeBundleMemberReasoning(
          acceptedMemberOpportunities,
          (opportunity) => opportunity.score.implementationCostReasoning,
        ),
        riskReasoning: summarizeBundleMemberReasoning(
          acceptedMemberOpportunities,
          (opportunity) => opportunity.score.riskReasoning,
        ),
      },
      evidence,
      speculative: acceptedMemberOpportunities.every((opportunity) => opportunity.speculative),
    };
    const acceptance = bundleOpportunityAcceptance(
      candidate.bundle,
      syntheticOpportunity,
      uncoveredAcceptedMembers,
    );
    selected.push({
      acceptance,
      selectedCandidate: {
        kind: "bundle",
        id: candidate.bundle.id,
        title: candidate.bundle.id,
        opportunityIds: candidate.bundle.opportunityIds,
        projectChange: candidate.bundle.maxPrScope,
        sourceLesson: memberOpportunities.map((opportunity) => opportunity.lesson).join("\n"),
        userValue: candidate.bundle.combinedUserValue,
        evidenceCount: memberOpportunities.reduce(
          (sum, opportunity) => sum + opportunity.evidence.length,
          0,
        ),
        speculative: memberOpportunities.every((opportunity) => opportunity.speculative),
        score,
        sourceCoreFit: 1,
        metaInfrastructurePenalty: 0,
        qualityScore: acceptance.acceptanceAverage,
        raw: candidate.bundle,
      },
    });
    for (const member of uncoveredAcceptedMembers) {
      coveredOpportunityIds.add(member.id);
    }
  }

  for (const acceptance of sortedAccepted) {
    if (coveredOpportunityIds.has(acceptance.id)) {
      continue;
    }
    selected.push({ acceptance });
  }

  return maxOpportunities > 0 ? selected.slice(0, maxOpportunities) : selected;
}

function isValidPromotionBundle(bundle: OpportunityBundle): boolean {
  return (
    bundle.opportunityIds.length > 1 &&
    Boolean(bundle.rationale.trim()) &&
    Boolean(bundle.sharedChangeSurface.trim()) &&
    Boolean(bundle.combinedUserValue.trim()) &&
    Boolean(bundle.separationRisk.trim()) &&
    Boolean(bundle.maxPrScope.trim())
  );
}

function bundleOpportunityAcceptance(
  bundle: OpportunityBundle,
  opportunity: Opportunity,
  acceptedMembers: OpportunityAcceptance[],
): OpportunityAcceptance {
  const acceptanceAverage =
    acceptedMembers.reduce((sum, acceptance) => sum + acceptance.acceptanceAverage, 0) /
    acceptedMembers.length;
  return {
    id: bundle.id,
    title: bundle.id,
    accepted: true,
    reason: `Accepted bundle ${bundle.id} because it covers ${acceptedMembers.length} accepted opportunities with one shared change surface.`,
    acceptanceAverage,
    scores: {
      applicability: opportunity.score.applicability,
      applicabilityReasoning: opportunity.score.applicabilityReasoning,
      impact: opportunity.score.impact,
      impactReasoning: opportunity.score.impactReasoning,
      confidence: opportunity.score.confidence,
      confidenceReasoning: opportunity.score.confidenceReasoning,
      risk: opportunity.score.risk,
      riskReasoning: opportunity.score.riskReasoning,
    },
    opportunity,
  };
}

function buildOpportunityFanOutNodes(
  acceptance: OpportunityAcceptance,
  selectedCandidate?: PlanCandidate,
): RuntimeWorkflowNode[] {
  const idPart = toNodeIdPart(acceptance.id);
  const sharedInput = {
    opportunity: acceptance.opportunity,
    opportunityAcceptance: acceptance,
    ...(selectedCandidate ? { selectedCandidate } : {}),
  };
  return [
    {
      id: `plan-opportunity-${idPart}`,
      kind: WorkflowNodeKind.PLANNING,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: `Plan ${acceptance.id}: ${acceptance.title}`,
      description: `Create an implementation plan artifact for accepted opportunity ${acceptance.id}.`,
      ...nodeModelMetadata(SourceToProjectModelOperation.PLAN_GENERATION),
      prompt: `Create a plan artifact for accepted opportunity ${acceptance.id}.`,
      input: sharedInput,
      dependsOn: ["council-review"],
      gates: [WorkflowGateKind.VERIFICATION],
      writeMode: "read-only",
      replanPolicy: "on-verification-failure",
    },
    {
      id: `review-opportunity-${idPart}`,
      kind: WorkflowNodeKind.DELIBERATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: `Review ${acceptance.id}: ${acceptance.title}`,
      description: `Review the plan for accepted opportunity ${acceptance.id} against source fit, actionability, and complexity.`,
      ...nodeModelMetadata(SourceToProjectModelOperation.FINAL_RECOMMENDATION_REVIEW),
      prompt: `Review the plan for accepted opportunity ${acceptance.id}.`,
      input: sharedInput,
      dependsOn: [`plan-opportunity-${idPart}`],
      gates: [WorkflowGateKind.REVIEW_ACCEPTED],
      writeMode: "read-only",
      replanPolicy: "never",
    },
    {
      id: `report-opportunity-${idPart}`,
      kind: WorkflowNodeKind.REPORT,
      harness: WorkflowHarnessKind.REPORTER,
      title: `Report ${acceptance.id}: ${acceptance.title}`,
      description: `Publish a deterministic markdown report for accepted opportunity ${acceptance.id}.`,
      ...nodeModelMetadata(SourceToProjectModelOperation.DETERMINISTIC),
      prompt: `Write the ${acceptance.id} ${acceptance.title} source-to-project report as markdown.`,
      input: sharedInput,
      dependsOn: [`review-opportunity-${idPart}`],
      gates: [WorkflowGateKind.OUTPUT_CONTRACT],
      writeMode: "read-only",
      replanPolicy: "never",
    },
    {
      id: `visual-design-opportunity-${idPart}`,
      kind: WorkflowNodeKind.VISUALIZATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: `Visual design ${acceptance.id}: ${acceptance.title}`,
      description: `Create a visual design plan from the accepted opportunity ${acceptance.id} report.`,
      ...nodeModelMetadata(SourceToProjectModelOperation.VISUAL_DESIGN),
      prompt: `Create a visual design plan from the ${acceptance.id} source-to-project report.`,
      input: sharedInput,
      dependsOn: [`report-opportunity-${idPart}`],
      gates: [WorkflowGateKind.OUTPUT_CONTRACT],
      writeMode: "read-only",
      replanPolicy: "never",
    },
  ];
}

function buildAutonomousPrNodes(accepted: OpportunityAcceptance[]): RuntimeWorkflowNode[] {
  const reviewNodeIds = accepted.map(
    (acceptance) => `review-opportunity-${toNodeIdPart(acceptance.id)}`,
  );
  const needsChanges = {
    nodeId: "review-implementation",
    key: "implementationReviewVerdict.status",
    equals: "needs_changes",
  };
  return [
    {
      id: "prepare-worktree",
      kind: WorkflowNodeKind.PLANNING,
      harness: WorkflowHarnessKind.VERIFIER,
      title: "Prepare autonomous worktree",
      description: "Prepare an isolated worktree for autonomous source-to-project implementation.",
      ...nodeModelMetadata(SourceToProjectModelOperation.DETERMINISTIC),
      prompt: "Prepare an isolated worktree before source-to-project implementation.",
      dependsOn: ["council-review"],
      gates: [WorkflowGateKind.OUTPUT_CONTRACT],
      writeMode: "read-only",
      replanPolicy: "never",
    },
    {
      id: "implement-selected-bundles",
      kind: WorkflowNodeKind.IMPLEMENTATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Implement selected source-to-project plan",
      description: "Implement the accepted source-to-project plan in the prepared worktree.",
      ...nodeModelMetadata(SourceToProjectModelOperation.IMPLEMENTATION),
      prompt:
        "Implement the accepted source-to-project opportunity or bundle in the prepared worktree.",
      dependsOn: ["prepare-worktree", ...reviewNodeIds],
      gates: [WorkflowGateKind.VERIFICATION],
      writeMode: "single-writer",
      replanPolicy: "on-verification-failure",
    },
    {
      id: "verify-implementation",
      kind: WorkflowNodeKind.VERIFICATION,
      harness: WorkflowHarnessKind.VERIFIER,
      title: "Verify source-to-project implementation",
      description:
        "Run configured validation commands against the source-to-project implementation.",
      ...nodeModelMetadata(SourceToProjectModelOperation.DETERMINISTIC),
      prompt: "Run the configured validation commands for the source-to-project implementation.",
      dependsOn: ["implement-selected-bundles"],
      gates: [WorkflowGateKind.VERIFICATION],
      writeMode: "read-only",
      replanPolicy: "on-verification-failure",
    },
    {
      id: "review-implementation",
      kind: WorkflowNodeKind.DELIBERATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Review source-to-project implementation",
      description: "Review the implementation for correctness, risk, and source-to-project fit.",
      ...nodeModelMetadata(SourceToProjectModelOperation.IMPLEMENTATION_REVIEW),
      prompt: "Review the implementation for correctness, risk, and source-to-project fit.",
      dependsOn: ["verify-implementation"],
      gates: [WorkflowGateKind.REVIEW_ACCEPTED],
      writeMode: "read-only",
      replanPolicy: "never",
    },
    {
      id: "fix-review-findings",
      kind: WorkflowNodeKind.IMPLEMENTATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Fix blocking implementation review findings",
      description: "Apply the blocking findings from the initial structured review once.",
      ...nodeModelMetadata(SourceToProjectModelOperation.IMPLEMENTATION_FIX),
      prompt: "Fix every blocking finding from the initial implementation review.",
      dependsOn: ["review-implementation"],
      runWhen: needsChanges,
      gates: [WorkflowGateKind.VERIFICATION],
      writeMode: "single-writer",
      replanPolicy: "never",
    },
    {
      id: "verify-review-fixes",
      kind: WorkflowNodeKind.VERIFICATION,
      harness: WorkflowHarnessKind.VERIFIER,
      title: "Verify implementation review fixes",
      description: "Run configured validation after the one allowed fix pass.",
      ...nodeModelMetadata(SourceToProjectModelOperation.DETERMINISTIC),
      prompt: "Run configured validation commands after fixing review findings.",
      dependsOn: ["fix-review-findings"],
      runWhen: needsChanges,
      gates: [WorkflowGateKind.VERIFICATION],
      writeMode: "read-only",
      replanPolicy: "never",
    },
    {
      id: "re-review-implementation",
      kind: WorkflowNodeKind.DELIBERATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Re-review source-to-project implementation",
      description: "Re-review the fixed implementation against the initial blocking findings once.",
      ...nodeModelMetadata(SourceToProjectModelOperation.IMPLEMENTATION_REVIEW),
      prompt: "Re-review the fixes against every initial blocking finding.",
      dependsOn: ["verify-review-fixes"],
      runWhen: needsChanges,
      gates: [WorkflowGateKind.REVIEW_ACCEPTED],
      writeMode: "read-only",
      replanPolicy: "never",
    },
    {
      id: "open-pr",
      kind: WorkflowNodeKind.REPORT,
      harness: WorkflowHarnessKind.REPORTER,
      title: "Open source-to-project pull request",
      description: "Open a pull request for the verified autonomous implementation.",
      ...nodeModelMetadata(SourceToProjectModelOperation.DETERMINISTIC),
      prompt: "Open a pull request for the verified source-to-project implementation.",
      dependsOn: ["review-implementation", "re-review-implementation"],
      gates: [WorkflowGateKind.OUTPUT_CONTRACT],
      writeMode: "read-only",
      replanPolicy: "never",
    },
  ];
}

function buildExecutionMetadata(
  executor: string,
  calls: WorkflowExecutionCall[],
): WorkflowExecutionMetadata {
  const firstCall = calls[0];
  return {
    executor,
    operation: firstCall?.operation,
    mode: firstCall?.mode,
    prompt: firstCall?.prompt,
    cwd: firstCall?.cwd,
    model: firstCall?.model,
    calls,
  };
}

function reporterExecution(node: RuntimeWorkflowNode): WorkflowExecutionMetadata {
  return buildExecutionMetadata(WorkflowHarnessKind.REPORTER, [
    {
      executor: WorkflowHarnessKind.REPORTER,
      operation: node.id,
      mode: "report",
      prompt: node.prompt,
      model: node.model ?? "deterministic",
    },
  ]);
}

function resolveOpportunityPlanExecution(
  node: RuntimeWorkflowNode,
  context: WorkflowExecutionContext,
  project: ProjectCatalogEntry,
  sourceToProject?: SourceToProjectDefaults,
  projectBrief?: ProjectBrief,
  rawTranscripts?: { rawSourceReading?: string; rawProjectResearch?: string },
): {
  selectedCandidateJson: string;
  prompt: string;
  copilotModel?: string;
  rawPlanArtifactPath: string;
  execution: WorkflowExecutionMetadata;
} {
  const opportunity = readNodeInput<Opportunity>(node, "opportunity");
  const acceptance = readNodeInput<OpportunityAcceptance>(node, "opportunityAcceptance");
  const councilReview = readCouncilReview(context);
  const relatedBundles = councilReview.bundles.filter((bundle) =>
    bundle.opportunityIds.includes(opportunity.id),
  );
  const selectedCandidate = node.input?.selectedCandidate as PlanCandidate | undefined;
  const selectedCandidateJson = JSON.stringify(
    selectedCandidate ?? {
      kind: "opportunity",
      id: opportunity.id,
      title: opportunity.title,
      opportunityIds: [opportunity.id],
      projectChange: opportunity.projectChange,
      sourceLesson: opportunity.lesson,
      userValue: opportunity.projectChange,
      score: opportunity.score,
      acceptance,
      relatedBundles,
      raw: opportunity,
    },
  );
  const rawPlanArtifactPath = rawPlanArtifactPathForNode(node.id);
  const projectJson = projectBrief ? JSON.stringify(projectBrief) : JSON.stringify(project);
  const prompt = buildPlanPrompt(
    selectedCandidateJson,
    projectJson,
    rawPlanArtifactPath,
    rawTranscripts,
  );
  const copilotModel = resolveCopilotModel(
    SourceToProjectModelOperation.PLAN_GENERATION,
    sourceToProject,
  );
  return {
    selectedCandidateJson,
    prompt,
    copilotModel,
    rawPlanArtifactPath,
    execution: buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
      copilotCall({ mode: "plan", cwd: project.workingTree, prompt, model: copilotModel }),
    ]),
  };
}

async function persistRawPlanMarkdown(args: {
  outputDir?: string;
  nodeId: string;
  rawPlan: string;
  rawPlanArtifactPath: string;
  fullPlanContent?: string;
}): Promise<{ artifacts: WorkflowArtifactRef[] | undefined; planFilePath?: string }> {
  if (!args.outputDir) {
    return { artifacts: undefined };
  }
  const artifactPath = join(args.outputDir, args.rawPlanArtifactPath);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, args.rawPlan, "utf8");
  const artifacts: WorkflowArtifactRef[] = [
    {
      kind: "markdown",
      path: args.rawPlanArtifactPath,
      description: `Raw Copilot plan markdown for ${args.nodeId}.`,
    },
  ];
  let planFilePath: string | undefined;
  if (args.fullPlanContent) {
    const fullArtifactRelPath = args.rawPlanArtifactPath.replace(/\.md$/, "-full.md");
    const fullArtifactPath = join(args.outputDir, fullArtifactRelPath);
    await writeFile(fullArtifactPath, args.fullPlanContent, "utf8");
    planFilePath = fullArtifactPath;
    artifacts.push({
      kind: "markdown",
      path: fullArtifactRelPath,
      description: `Full Copilot session plan.md for ${args.nodeId}.`,
    });
  }
  return { artifacts, planFilePath };
}

function withRawPlanArtifactPath(
  plan: PlanArtifactSummary,
  rawPlanArtifactPath: string,
  planFilePath?: string,
): PlanArtifactSummary {
  return {
    ...plan,
    rawPlanArtifactPath,
    ...(planFilePath ? { planFilePath } : {}),
  };
}

async function readRawPlanMarkdownForReport(
  outputDir: string | undefined,
  rawPlanArtifactPath: string | undefined | null,
  planFilePath?: string | undefined | null,
): Promise<string | undefined> {
  // Prefer the full Copilot session plan.md (planFilePath, already absolute) when it was
  // captured -- the short rawPlanArtifactPath is often just the plan-mode agent's brief
  // conversational acknowledgment (e.g. "Let me write the plan."), not the actual plan content.
  if (planFilePath) {
    try {
      const fullPlanMarkdown = await readFile(planFilePath, "utf8");
      return stripPlanningAgentPreamble(fullPlanMarkdown);
    } catch {
      // Fall through to the raw plan artifact below.
    }
  }
  if (!outputDir || !rawPlanArtifactPath) {
    return undefined;
  }
  try {
    const rawPlanMarkdown = await readFile(join(outputDir, rawPlanArtifactPath), "utf8");
    return stripPlanningAgentPreamble(rawPlanMarkdown);
  } catch {
    return undefined;
  }
}

/**
 * Planning agents (e.g. the task-plan skill) commonly prefix their final plan markdown with a
 * conversational status line like "Plan saved and todos tracked. Here is the final plan markdown
 * (the harness will persist it to `raw-plans/<file>.md`):" followed by a `---` separator. That
 * path is only meaningful in the run's `outputDir` and does not exist once this markdown is
 * embedded into a report/prompt handed to a fresh agent in a different worktree, so strip it
 * before the raw plan content is reused downstream.
 */
export function stripPlanningAgentPreamble(markdown: string): string {
  const lines = markdown.split("\n");
  if (!/^Plan saved and todos tracked\b/i.test(lines[0] ?? "")) {
    return markdown;
  }
  let index = 1;
  while (index < lines.length && lines[index].trim() === "") index++;
  if (lines[index]?.trim() === "---") {
    index++;
    while (index < lines.length && lines[index].trim() === "") index++;
  }
  return lines.slice(index).join("\n");
}

export type AutoImplementLaunchOutcome =
  | {
      status: "launched";
      worktreePath: string;
      branchName: string;
      agentName: string;
      startedCommand: string;
    }
  | { status: "failed"; error: string };

/**
 * Best-effort automation: when enabled, immediately hands an accepted opportunity's reviewed
 * report to a Herdr-managed worktree + agent for direct implementation, instead of requiring a
 * manual "Create PR" click. Never fails the report node -- launch errors are captured in the
 * returned outcome so they can be surfaced in the dashboard/report without blocking the run.
 */
async function maybeAutoImplementOpportunity(args: {
  options: SourceToProjectHarnessOptions;
  context: WorkflowExecutionContext;
  node: RuntimeWorkflowNode;
  opportunity: Opportunity;
  plan: PlanArtifactSummary | undefined;
  status: string;
  reportMarkdown: string;
}): Promise<AutoImplementLaunchOutcome | undefined> {
  const { options, context, node, opportunity, plan, status, reportMarkdown } = args;
  if (status !== "accepted") {
    return undefined;
  }
  if (!options.sourceToProject?.autoImplementOnReport) {
    return undefined;
  }
  if (!options.project.autonomousPrAllowed) {
    return undefined;
  }
  const runId = context.outputDir ? basename(context.outputDir) : node.id;
  const launcher = options.prLauncher ?? { launch: launchSourceToProjectPrAgent };
  const launchContext: SourceToProjectPrLaunchContext = {
    runId,
    nodeId: node.id,
    objective: context.objective ?? options.originalPrompt ?? "",
    source: options.source,
    project: options.project,
    opportunityId: opportunity.id,
    opportunityTitle: opportunity.title,
    reportMarkdown,
    planTitle: plan?.title,
    recommendation: plan?.recommendation,
    initialPromptMode: "implement",
  };
  try {
    const nodeCostHistory = await loadNodeCostHistory();
    const budgetGateConfig = {
      ...defaultBudgetGateConfig(),
      ...options.sourceToProject.budgetGate,
      ...options.project.budgetGate,
    };
    const launchPromptTokens = Math.ceil(
      [context.objective, options.source, opportunity.title, reportMarkdown, plan?.recommendation]
        .filter(Boolean)
        .join("\n\n").length / 4,
    );
    const budgetProjection = projectWorkflowCostUsd({
      nodeCostHistory,
      calls: [
        {
          nodeId: "source-to-project.autonomous-pr-agent",
          harness: "copilot-sdk",
          model: options.sourceToProject.copilotModel ?? "gpt-5.3-codex",
          inputTokens: Math.max(launchPromptTokens, 12000),
          outputTokens: 80000,
        },
      ],
    });
    const budgetOverrideReason =
      options.budgetOverrideReason ??
      (process.env.WEAVEKIT_BUDGET_OVERRIDE === "1"
        ? process.env.WEAVEKIT_BUDGET_OVERRIDE_REASON
        : undefined);
    const launch: SourceToProjectPrLaunchResult = await launcher.launch({
      config: options.sourceToProject.prLauncher,
      context: launchContext,
      budgetGate: {
        config: budgetGateConfig,
        projection: budgetProjection,
        override: { reason: budgetOverrideReason },
      },
    });
    return {
      status: "launched",
      worktreePath: launch.worktreePath,
      branchName: launch.branchName,
      agentName: launch.agentName,
      startedCommand: launch.startedCommand,
    };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

async function readCopilotSessionPlan(sessionId: string): Promise<string | undefined> {
  const copilotHome = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
  const planPath = join(copilotHome, "session-state", sessionId, "plan.md");
  try {
    return await readFile(planPath, "utf8");
  } catch {
    return undefined;
  }
}

function rawPlanArtifactPathForNode(nodeId: string): string {
  return `${RAW_PLAN_ARTIFACT_DIR}/${sanitizeArtifactFilename(nodeId)}.md`;
}

function sanitizeArtifactFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function copilotCall(args: {
  mode: "research" | "plan" | "implement" | "review";
  prompt: string;
  cwd?: string;
  model?: string;
  capabilityScope?: CopilotCapabilityScope;
}): WorkflowExecutionCall {
  return {
    executor: "copilot-sdk",
    mode: args.mode,
    prompt: scopedPromptForCapability(args.prompt, args.capabilityScope),
    cwd: args.cwd,
    model: args.model,
    capabilityScope: capabilityScopeLabel(args.capabilityScope),
  };
}

function bamlCall(operation: string, model?: string): WorkflowExecutionCall {
  return {
    executor: "baml",
    operation,
    model,
  };
}

function skillInstallCall(
  install: AgentNativeSkillInstallResult,
  cwd: string,
): WorkflowExecutionCall {
  return {
    executor: "shell",
    operation: [install.command, ...install.args].join(" "),
    cwd,
  };
}

export async function ensureAgentNativeSkillInstalled(args: {
  skill: AgentNativeSkillInstallResult["skill"];
  cwd: string;
  shell?: ShellClient;
  offline?: boolean;
  tooling?: Pick<
    ToolingDefaults,
    "agentNativeSkillsInstaller" | "agentNativeSkillsPackage" | "miseBin"
  >;
  dryRun?: boolean;
  noConnect?: boolean;
}): Promise<AgentNativeSkillInstallResult> {
  const configuredInstaller = args.tooling?.agentNativeSkillsInstaller;
  const installerPackage =
    args.tooling?.agentNativeSkillsPackage?.trim() || DEFAULT_AGENT_NATIVE_SKILLS_PACKAGE;
  const command = configuredInstaller ?? "nub";
  const commandArgs = [
    ...(configuredInstaller ? [] : ["x"]),
    installerPackage,
    "add",
    "--skill",
    args.skill,
    ...(args.dryRun ? ["--dry-run"] : []),
    ...(args.noConnect ? ["--no-connect"] : []),
  ];

  if (args.offline) {
    return {
      skill: args.skill,
      command,
      args: commandArgs,
      output: `Skipped ${args.skill} install in offline source-to-project mode.`,
      skipped: true,
    };
  }

  const run = args.shell?.run ?? defaultShellRun;
  const result = await runAgentNativeInstallerCommand(
    run,
    command,
    commandArgs,
    { cwd: args.cwd },
    args.tooling,
  );
  validateAgentNativeSkillInstallOutput(args.skill, result.output);
  return {
    skill: args.skill,
    command: result.command,
    args: result.args,
    output: result.output,
    skipped: false,
    usable: true,
  };
}

async function ensureAgentNativeSkillInstalledForAdvisoryWorkflow(
  args: Parameters<typeof ensureAgentNativeSkillInstalled>[0],
): Promise<AgentNativeSkillInstallResult> {
  try {
    const install = await ensureAgentNativeSkillInstalled(args);
    return { ...install, usable: install.usable ?? true };
  } catch (error) {
    if (!isAgentNativeHostedAuthPendingError(error) && !isNubTrustDowngradeError(error)) {
      throw error;
    }
    const warning = isNubTrustDowngradeError(error)
      ? "visual-plan skill install was blocked by a dependency trust-downgrade (ERR_NUB_TRUST_DOWNGRADE); visual-plan is unavailable for this run. To fix, add the flagged package to trustPolicyExclude in your .npmrc."
      : "Agent-Native Plan authentication is pending or was skipped; local visual-plan mode will still be attempted for this advisory run.";
    return {
      skill: args.skill,
      command: args.tooling?.agentNativeSkillsInstaller ?? "nub",
      args: [
        ...(args.tooling?.agentNativeSkillsInstaller ? [] : ["x"]),
        args.tooling?.agentNativeSkillsPackage?.trim() || DEFAULT_AGENT_NATIVE_SKILLS_PACKAGE,
        "add",
        "--skill",
        args.skill,
      ],
      output: error instanceof Error ? error.message : String(error),
      skipped: true,
      usable: false,
      warning,
    };
  }
}

async function runAgentNativeInstallerCommand(
  run: ShellClient["run"],
  command: string,
  args: string[],
  options: { cwd: string },
  tooling?: Pick<ToolingDefaults, "miseBin">,
): Promise<{ command: string; args: string[]; output: string }> {
  try {
    return {
      command,
      args,
      output: await run(command, args, options),
    };
  } catch (error) {
    if (command !== "nub" || !isEnoentError(error)) {
      throw error;
    }
    const fallbackCommand = "mise";
    const fallbackArgs = ["exec", "--", "nub", ...args];
    try {
      return {
        command: fallbackCommand,
        args: fallbackArgs,
        output: await run(fallbackCommand, fallbackArgs, options),
      };
    } catch (fallbackError) {
      if (!isEnoentError(fallbackError)) {
        throw fallbackError;
      }
      let lastEnoentError: unknown = fallbackError;
      for (const absoluteMiseCommand of resolveAbsoluteMiseCommands(tooling)) {
        try {
          return {
            command: absoluteMiseCommand,
            args: fallbackArgs,
            output: await run(absoluteMiseCommand, fallbackArgs, options),
          };
        } catch (absoluteFallbackError) {
          if (!isEnoentError(absoluteFallbackError)) {
            throw absoluteFallbackError;
          }
          lastEnoentError = absoluteFallbackError;
        }
      }
      throw lastEnoentError;
    }
  }
}

function isAgentNativeHostedAuthPendingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Agent-Native Plan authentication is pending or was skipped/i.test(message) ||
    /Authentication pending/i.test(message) ||
    /Authentication skipped/i.test(message) ||
    /Skipped URL-only hosted MCP config/i.test(message)
  );
}

function isNubTrustDowngradeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ERR_NUB_TRUST_DOWNGRADE/i.test(message) || /trust downgrade/i.test(message);
}

function validateAgentNativeSkillInstallOutput(
  skill: AgentNativeSkillInstallResult["skill"],
  output: string,
): void {
  const authSignals = [
    /authentication pending/i,
    /authentication skipped/i,
    /skipped url-only hosted mcp config/i,
    /run agent-native connect/i,
  ];
  if (!authSignals.some((signal) => signal.test(output))) {
    return;
  }
  throw new Error(
    [
      `${skill} hosted capability is not usable: Agent-Native Plan authentication is pending or was skipped.`,
      "Run `nub x @agent-native/core@latest connect https://plan.agent-native.com --client codex,cowork --scope user` in an interactive shell, then rerun `mise run doctor:sdk`.",
      "Installer output:",
      output,
    ].join("\n"),
  );
}

function validateHostedVisualPlanArtifact(rawVisualPlan: string): string {
  if (
    /\b(?:file:)?(?:~\/|\S*\/)\.copilot\/session-state\/\S+\.html\b/i.test(rawVisualPlan) ||
    /local html fallback/i.test(rawVisualPlan) ||
    /self-contained,\s*no dependencies/i.test(rawVisualPlan)
  ) {
    throw new Error(
      [
        "visual-plan did not produce a hosted Agent-Native Plan artifact; it produced a local HTML fallback instead.",
        rawVisualPlanExcerpt(rawVisualPlan),
      ].join("\n"),
    );
  }

  const hostedArtifactUrl = extractHostedVisualPlanArtifactUrl(rawVisualPlan);
  if (!hostedArtifactUrl) {
    throw new Error(
      [
        "visual-plan did not return a hosted Agent-Native Plan or Builder.io artifact URL.",
        rawVisualPlanExcerpt(rawVisualPlan),
      ].join("\n"),
    );
  }
  return hostedArtifactUrl;
}

function rawVisualPlanExcerpt(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "Raw visual-plan output was empty.";
  }
  return `Raw visual-plan output excerpt:\n${normalized.slice(0, 1200)}`;
}

function extractHostedVisualPlanArtifactUrl(value: string): string | undefined {
  const matches = value.matchAll(/https?:\/\/[^\s<>)\]`"']+/g);
  for (const match of matches) {
    const candidate = match[0]?.replace(/[.,;:!?]+$/, "");
    if (!candidate) {
      continue;
    }
    try {
      const url = new URL(candidate);
      const hostname = url.hostname.toLowerCase();
      if (hostname === "plan.agent-native.com" && !url.pathname.includes("/_agent-native/mcp")) {
        return url.toString();
      }
      if (hostname === "builder.io" || hostname.endsWith(".builder.io")) {
        return url.toString();
      }
    } catch {
      // Ignore non-URL matches.
    }
  }
  return undefined;
}

function resolveVisualPlanBridgeCleanupTtlMs(explicitTtlMs?: number): number {
  if (explicitTtlMs !== undefined) {
    return explicitTtlMs;
  }
  const envValue = process.env.WEAVEKIT_VISUAL_PLAN_BRIDGE_TTL_MS?.trim();
  if (!envValue) {
    return DEFAULT_VISUAL_PLAN_BRIDGE_TTL_MS;
  }
  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_VISUAL_PLAN_BRIDGE_TTL_MS;
}

function scheduleVisualPlanBridgeCleanup(args: {
  hostedArtifactUrl: string;
  cleanupAfterMs: number;
  scheduler?: VisualPlanBridgeCleanupScheduler;
}): VisualPlanBridgeCleanupResult | undefined {
  const bridge = localPlanBridgeFromHostedUrl(args.hostedArtifactUrl);
  if (!bridge) {
    return undefined;
  }
  if (args.cleanupAfterMs === 0) {
    return {
      status: "disabled",
      bridgeUrl: bridge.bridgeUrl,
      port: bridge.port,
      cleanupAfterMs: args.cleanupAfterMs,
    };
  }
  return (args.scheduler ?? defaultVisualPlanBridgeCleanupScheduler)({
    hostedArtifactUrl: args.hostedArtifactUrl,
    cleanupAfterMs: args.cleanupAfterMs,
  });
}

function localPlanBridgeFromHostedUrl(
  hostedArtifactUrl: string,
): { bridgeUrl: string; port: number } | undefined {
  try {
    const hosted = new URL(hostedArtifactUrl);
    if (
      hosted.hostname.toLowerCase() !== "plan.agent-native.com" ||
      !hosted.pathname.startsWith("/local-plans/")
    ) {
      return undefined;
    }
    const bridgeParam = hosted.searchParams.get("bridge");
    if (!bridgeParam) {
      return undefined;
    }
    const bridge = new URL(bridgeParam);
    if (
      bridge.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(bridge.hostname.toLowerCase())
    ) {
      return undefined;
    }
    const port = Number(bridge.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return undefined;
    }
    return { bridgeUrl: bridge.toString(), port };
  } catch {
    return undefined;
  }
}

function defaultVisualPlanBridgeCleanupScheduler(args: {
  hostedArtifactUrl: string;
  cleanupAfterMs: number;
}): VisualPlanBridgeCleanupResult | undefined {
  const bridge = localPlanBridgeFromHostedUrl(args.hostedArtifactUrl);
  if (!bridge) {
    return undefined;
  }
  const cleanupAfterSeconds = Math.max(1, Math.ceil(args.cleanupAfterMs / 1000));
  const cleanupCommand = [
    `sleep ${cleanupAfterSeconds}`,
    `pids=$(lsof -nP -tiTCP:${bridge.port} -sTCP:LISTEN 2>/dev/null || true)`,
    `if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi`,
  ].join("; ");
  const child = spawn("sh", ["-c", cleanupCommand], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return {
    status: "scheduled",
    bridgeUrl: bridge.bridgeUrl,
    port: bridge.port,
    cleanupAfterMs: args.cleanupAfterMs,
    cleanupCommand,
  };
}

function isEnoentError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function resolveAbsoluteMiseCommands(tooling?: Pick<ToolingDefaults, "miseBin">): string[] {
  const configured = tooling?.miseBin?.trim();
  const home = process.env.HOME?.trim();
  const candidates = [
    configured,
    ...resolvePathExecutables("mise"),
    "/opt/homebrew/bin/mise",
    "/opt/homebrew/opt/mise/bin/mise",
    "/usr/local/bin/mise",
    "/usr/bin/mise",
    ...(home
      ? [join(home, ".local/bin/mise"), join(home, ".mise/bin/mise"), join(home, ".cargo/bin/mise")]
      : []),
  ];
  const seen = new Set<string>();
  const commands: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate) || !isExecutableFile(candidate)) {
      continue;
    }
    seen.add(candidate);
    commands.push(candidate);
  }
  return commands;
}

function resolvePathExecutables(command: string): string[] {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, command));
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function buildOpportunityReportMarkdown(args: {
  mode: SourceToProjectMode;
  opportunity: Opportunity;
  acceptance: OpportunityAcceptance;
  status: string;
  plan?: PlanArtifactSummary;
  finalRecommendationReview?: FinalRecommendationReview;
  rawPlanMarkdown?: string;
}): string {
  return [
    `# Source-to-Project Report: ${args.opportunity.id} ${args.opportunity.title}`,
    "",
    `- Mode: ${args.mode}`,
    `- Review status: ${args.status}`,
    `- Acceptance average: ${args.acceptance.acceptanceAverage.toFixed(2)}`,
    `- Acceptance rationale: ${args.acceptance.reason}`,
    "",
    "## Score Rationale",
    "",
    `- Applicability ${args.acceptance.scores.applicability.toFixed(2)}: ${args.acceptance.scores.applicabilityReasoning}`,
    `- Impact ${args.acceptance.scores.impact.toFixed(2)}: ${args.acceptance.scores.impactReasoning}`,
    `- Confidence ${args.acceptance.scores.confidence.toFixed(2)}: ${args.acceptance.scores.confidenceReasoning}`,
    `- Risk ${args.acceptance.scores.risk.toFixed(2)}: ${args.acceptance.scores.riskReasoning}`,
    `- Implementation Cost ${args.opportunity.score.implementationCost.toFixed(2)}: ${args.opportunity.score.implementationCostReasoning}`,
    "",
    "## Opportunity",
    "",
    args.opportunity.projectChange,
    "",
    "## Recommendation",
    "",
    args.plan?.recommendation ?? "No recommendation was available.",
    "",
    ...(args.plan
      ? [
          "## Source Lesson Applied",
          "",
          args.plan.sourceLessonApplied,
          "",
          "## Target Change",
          "",
          args.plan.targetChange,
          "",
          "## Implementation Outline",
          "",
          ...args.plan.implementationOutline.map((step) => `- ${step}`),
          "",
          "## Validation",
          "",
          ...(args.plan.validationCommands.length > 0
            ? args.plan.validationCommands.map((command) => `- \`${command}\``)
            : ["No validation commands recorded."]),
          "",
          "## Risks",
          "",
          ...(args.plan.risks.length > 0
            ? args.plan.risks.map((risk) => `- ${risk}`)
            : ["No risks recorded."]),
          "",
        ]
      : []),
    "## Review",
    "",
    args.finalRecommendationReview?.rationale ??
      "No final recommendation review rationale was available.",
    ...(args.rawPlanMarkdown
      ? ["", "## Full Plan (as written by the planning agent)", "", args.rawPlanMarkdown]
      : []),
  ].join("\n");
}

function buildAggregateReportMarkdown(args: {
  mode: SourceToProjectMode;
  plans: PlanArtifactSummary[];
  finalRecommendationReview?: FinalRecommendationReview;
  rawPlanMarkdownByPlanIndex?: (string | undefined)[];
}): string {
  return [
    "# Source-to-Project Report",
    "",
    `- Mode: ${args.mode}`,
    `- Plan count: ${args.plans.length}`,
    `- Review status: ${args.finalRecommendationReview?.status ?? "unknown"}`,
    "",
    "## Recommended Advisory Package",
    "",
    ...(args.plans.length > 0
      ? args.plans.flatMap((plan, index) => [
          `### ${index + 1}. ${plan.title}`,
          "",
          plan.recommendation,
          "",
          "**Source lesson applied:**",
          "",
          plan.sourceLessonApplied,
          "",
          "**Target change:**",
          "",
          plan.targetChange,
          "",
          "**Implementation outline:**",
          "",
          ...plan.implementationOutline.map((step) => `- ${step}`),
          "",
          ...(args.rawPlanMarkdownByPlanIndex?.[index]
            ? [
                `**Full Plan ${index + 1} (as written by the planning agent):**`,
                "",
                args.rawPlanMarkdownByPlanIndex[index]!,
                "",
              ]
            : []),
        ])
      : ["No advisory plans were available.", ""]),
    "## Review",
    "",
    args.finalRecommendationReview?.rationale ??
      "No final recommendation review rationale was available.",
  ].join("\n");
}

function buildVisualPlanPrompt(args: { opportunity: Opportunity; reportMarkdown: string }): string {
  return [
    `/visual-plan Create an actual visual design artifact for source-to-project opportunity ${args.opportunity.id}: ${args.opportunity.title}.`,
    "",
    "Use Agent-Native Plans local-files privacy mode. Write a local `plan.mdx`, run the Agent-Native `plan local check`, `plan local verify`, and local bridge flow, and return the resulting `https://plan.agent-native.com/local-plans/...` URL. Do not create a standalone HTML fallback.",
    "",
    "Important SDK workflow constraint: do not run `plan local serve` as a foreground command because it keeps this workflow process open. If you start a local bridge, start it detached/backgrounded (for example with `nohup ... > /tmp/<slug>-plan-serve.log 2>&1 &`), poll `.plan-url` or the log until the URL is available, then return the URL and stop using tools.",
    "",
    "Use the markdown report below as the source material. The report is already the textual output, so focus this step on the visual review surface that helps a reader inspect the recommendation, flow, affected project areas, risks, and validation path.",
    "",
    "Source-to-project report:",
    "",
    args.reportMarkdown,
  ].join("\n");
}

function sourceReadingMaxToolCalls(config?: SourceToProjectDefaults): number {
  return (
    config?.sourceReadingMaxToolCalls ??
    config?.maxToolCalls ??
    DEFAULT_SOURCE_READING_MAX_TOOL_CALLS
  );
}

function projectResearchMaxToolCalls(config?: SourceToProjectDefaults): number {
  return (
    config?.projectResearchMaxToolCalls ??
    config?.maxToolCalls ??
    DEFAULT_PROJECT_RESEARCH_MAX_TOOL_CALLS
  );
}

function visualPlanSkillCapabilityScope(
  cwd: string,
  tooling?: ToolingDefaults,
): CopilotCapabilityScope {
  const skillName = "visual-plan";
  const skillDirectory = resolveSkillDiscoveryDirectory(skillName, cwd, tooling);
  return {
    kind: "skill",
    skillName,
    skillDirectories: [skillDirectory],
    disabledSkills: siblingSkillNames(skillDirectory).filter((name) => name !== skillName),
  };
}

function resolveSkillDiscoveryDirectory(
  skillName: string,
  cwd: string,
  tooling?: ToolingDefaults,
): string {
  const candidates = uniqueStrings(
    [
      tooling?.skillsDirectory,
      join(cwd, ".agents", "skills"),
      join(cwd, ".copilot", "skills"),
      join(homedir(), ".agents", "skills"),
      join(homedir(), ".copilot", "skills"),
      join(homedir(), ".codex", "skills"),
    ].filter((value): value is string => Boolean(value)),
  );

  return (
    candidates.find((directory) => existsSync(join(directory, skillName, "SKILL.md"))) ??
    candidates.find((directory) => existsSync(directory)) ??
    join(homedir(), ".agents", "skills")
  );
}

function siblingSkillNames(skillDirectory: string): string[] {
  if (!existsSync(skillDirectory)) {
    return [];
  }
  return readdirSync(skillDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function projectResearchCapabilityScope(
  node: RuntimeWorkflowNode,
  plugins?: PluginConfigs,
): CopilotCapabilityScope | undefined {
  const capability = node.capabilities?.pluginCommands?.[0];
  if (!capability) return undefined;
  if (capability.plugin !== SupportedPluginId.HVE_CORE) {
    throw new Error(
      `Unsupported project-research plugin command capability plugin "${capability.plugin}".`,
    );
  }
  if (capability.command !== "hve-core:task-research") {
    throw new Error(`Unsupported project-research plugin command "${capability.command}".`);
  }
  return {
    kind: "plugin-command",
    pluginDirectory: resolveWeavekitPluginDirectory(SupportedPluginId.HVE_CORE, plugins),
    command: capability.command,
    promptInputName: capability.promptInputName,
    commandArgs: capability.args,
  };
}

function resolveCopilotModel(
  operation: SourceToProjectModelOperation,
  config?: Pick<SourceToProjectDefaults, "copilotModel">,
): string {
  return sourceToProjectCopilotModelDecision(operation, { copilotModel: config?.copilotModel })
    .model;
}

function resolveBamlModel(operation: SourceToProjectModelOperation): string {
  return sourceToProjectBamlRoute(operation).model;
}

function bamlOptionsForRoute(
  route: ReturnType<typeof sourceToProjectBamlFunctionRoute>,
): SourceToProjectBamlCallOptions {
  if (route.client) {
    return { client: route.client };
  }
  if (process.env.BAML_MODEL?.trim()) {
    return { clientRegistry: createBamlModelOverrideRegistry(route.model) };
  }
  return {};
}

function createBamlModelOverrideRegistry(model: string): ClientRegistry {
  const registry = new ClientRegistry();
  registry.addLlmClient("SourceToProjectBamlModelOverride", "openai-generic", {
    base_url: process.env.COPILOT_PROXY_BASE_URL ?? "http://127.0.0.1:8080/v1",
    api_key: process.env.COPILOT_PROXY_API_KEY ?? "",
    model,
  });
  registry.setPrimary("SourceToProjectBamlModelOverride");
  return registry;
}

function nodeModelMetadata(operation: SourceToProjectModelOperation) {
  return sourceToProjectNodeModelMetadata(operation);
}

function resolveBamlClient(options: SourceToProjectHarnessOptions): SourceToProjectBamlClient {
  const deterministic = createDeterministicBamlClient(options);
  const injected = options.baml;
  return {
    DistillSourceAnalysis:
      injected?.DistillSourceAnalysis?.bind(injected) ?? deterministic.DistillSourceAnalysis,
    DistillCorroboration:
      injected?.DistillCorroboration?.bind(injected) ?? deterministic.DistillCorroboration,
    DistillProjectBrief:
      injected?.DistillProjectBrief?.bind(injected) ?? deterministic.DistillProjectBrief,
    MapSourceToProject:
      injected?.MapSourceToProject?.bind(injected) ?? deterministic.MapSourceToProject,
    DistillPlanArtifact:
      injected?.DistillPlanArtifact?.bind(injected) ?? deterministic.DistillPlanArtifact,
    ReviewFinalRecommendation:
      injected?.ReviewFinalRecommendation?.bind(injected) ??
      deterministic.ReviewFinalRecommendation,
  };
}

function getPayloadValue<T>(context: WorkflowExecutionContext, nodeId: string, key: string): T {
  const value = context.payloads.get(nodeId)?.[key];
  if (value === undefined) {
    throw new Error(`Missing payload ${nodeId}.${key}`);
  }
  return value as T;
}

function getOptionalPayloadValue<T>(
  context: WorkflowExecutionContext,
  nodeId: string,
  key: string,
): T | undefined {
  return context.payloads.get(nodeId)?.[key] as T | undefined;
}

function collectPlansFromDependencies(
  context: WorkflowExecutionContext,
  node: RuntimeWorkflowNode,
): PlanArtifactSummary[] {
  return node.dependsOn.flatMap((dependency) => {
    const payload = context.payloads.get(dependency);
    if (!payload) {
      return [];
    }
    const plans = payload.plans;
    if (Array.isArray(plans)) {
      return plans as PlanArtifactSummary[];
    }
    const plan = payload.plan;
    return plan ? [plan as PlanArtifactSummary] : [];
  });
}

function readNodeInput<T>(node: RuntimeWorkflowNode, key: string): T {
  const value = node.input?.[key];
  if (value === undefined) {
    throw new Error(`Missing node input ${node.id}.${key}`);
  }
  return value as T;
}

function isOpportunityPlanNode(node: RuntimeWorkflowNode): boolean {
  return node.id.startsWith("plan-opportunity-");
}

function isOpportunityReviewNode(node: RuntimeWorkflowNode): boolean {
  return node.id.startsWith("review-opportunity-");
}

function isOpportunityVisualizationNode(node: RuntimeWorkflowNode): boolean {
  return node.id.startsWith("visualize-opportunity-");
}

function isOpportunityReportNode(node: RuntimeWorkflowNode): boolean {
  return node.id.startsWith("report-opportunity-");
}

function isOpportunityVisualDesignNode(node: RuntimeWorkflowNode): boolean {
  return node.id.startsWith("visual-design-opportunity-");
}

function isFinalRecommendationReviewNode(node: RuntimeWorkflowNode): boolean {
  return (
    node.id === "final-recommendation-review" || node.id.startsWith("final-recommendation-review-")
  );
}

function opportunityAcceptanceAverage(opportunity: Opportunity): number {
  return (
    (opportunity.score.applicability + opportunity.score.impact + opportunity.score.confidence) / 3
  );
}

function toNodeIdPart(id: string): string {
  return (
    id
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "opportunity"
  );
}

function readCouncilReview(context: WorkflowExecutionContext): OpportunityCouncilReview {
  return (context.payloads.get("council-review")?.councilReview ??
    context.payloads.get("opportunity-mapping")?.councilInputReview) as OpportunityCouncilReview;
}

function buildNoPlanReview(planSelection?: PlanSelection): FinalRecommendationReview {
  const reason =
    planSelection?.reason ?? "No selected source-to-project plan was available for final review.";
  return {
    status: "rejected",
    actionable: false,
    improvesProject: false,
    unnecessaryComplexity: false,
    benefitOutweighsCost: false,
    complexityAssessment:
      "No implementation complexity is justified because no actionable recommendation passed selection.",
    rationale: reason,
    rejectionReason: reason,
    telegramSummary: `Source-to-project review stopped before implementation: ${reason}`,
  };
}

function withTelegramSummary(
  review: FinalRecommendationReview,
  source: string,
): NotifiableFinalRecommendationReview {
  const telegramSummary =
    review.telegramSummary?.trim() ||
    review.rejectionReason?.trim() ||
    review.rationale.trim() ||
    `Source-to-project review rejected the recommendation for ${source}.`;
  return { ...review, telegramSummary };
}

export function createDefaultSourceToProjectNotifier(
  env: NodeJS.ProcessEnv = process.env,
): SourceToProjectNotifier {
  return {
    async notifyRejection(args) {
      if (args.project.notification !== "telegram") {
        return {
          channel: "cli",
          status: "skipped",
          message: args.review.telegramSummary,
        };
      }
      return sendTelegramRejectionNotification(args.review.telegramSummary, env);
    },
    async notifyElicitation(args) {
      const message = `Source-to-project workflow needs input for ${args.project.displayName} from ${args.source}:\n\n${args.question}`;
      if (args.project.notification !== "telegram") {
        return {
          channel: "cli",
          status: "skipped",
          message,
        };
      }
      return sendTelegramNotification(message, env);
    },
  };
}

async function sendTelegramRejectionNotification(
  message: string,
  env: NodeJS.ProcessEnv,
): Promise<SourceToProjectNotificationResult> {
  return sendTelegramNotification(message, env);
}

async function sendTelegramNotification(
  message: string,
  env: NodeJS.ProcessEnv,
): Promise<SourceToProjectNotificationResult> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = Number(env.TELEGRAM_OWNER_CHAT_ID);
  if (!token || !Number.isFinite(chatId)) {
    return {
      channel: "telegram",
      status: "failed",
      message,
      error: "Missing TELEGRAM_BOT_TOKEN or numeric TELEGRAM_OWNER_CHAT_ID.",
    };
  }

  try {
    await new TelegramClient(token).sendMessage(chatId, message);
    return { channel: "telegram", status: "sent", message };
  } catch (error) {
    return {
      channel: "telegram",
      status: "failed",
      message,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function mergeThresholds(
  defaults: SourceToProjectThresholds,
  ...overrides: Array<Partial<SourceToProjectThresholds> | undefined>
): SourceToProjectThresholds {
  const merged = { ...defaults };
  for (const override of overrides) {
    if (!override) {
      continue;
    }
    for (const key of Object.keys(merged) as Array<keyof SourceToProjectThresholds>) {
      if (override[key] !== undefined) {
        merged[key] = override[key];
      }
    }
  }
  return merged;
}

function selectPlanCandidate(
  review: OpportunityCouncilReview,
  projectBrief: ProjectBrief,
  options: { maxOpportunities: number; thresholds: SourceToProjectThresholds },
): PlanSelection {
  const candidates = buildPlanCandidates(review, projectBrief)
    .filter((candidate) => candidate.evidenceCount > 0)
    .filter((candidate) => !candidate.speculative)
    .filter(
      (candidate) =>
        (candidate.score.applicability + candidate.score.impact + candidate.score.confidence) / 3 >=
          options.thresholds.minAcceptanceAverage &&
        candidate.score.risk <= options.thresholds.maxRisk,
    )
    .sort((left, right) => right.qualityScore - left.qualityScore);
  const considered = candidates.map((candidate) => ({
    kind: candidate.kind,
    id: candidate.id,
    title: candidate.title,
    qualityScore: Number(candidate.qualityScore.toFixed(3)),
    sourceCoreFit: Number(candidate.sourceCoreFit.toFixed(3)),
    metaInfrastructurePenalty: Number(candidate.metaInfrastructurePenalty.toFixed(3)),
    opportunityIds: candidate.opportunityIds,
  }));
  const selectedCandidate = candidates[0];

  if (!selectedCandidate) {
    return {
      status: "rejected",
      reason: "No opportunity or bundle met evidence, threshold, and non-speculative gates.",
      candidatesConsidered: considered,
    };
  }

  if (selectedCandidate.qualityScore < MIN_PLAN_QUALITY_SCORE) {
    return {
      status: "rejected",
      reason: `Best candidate ${selectedCandidate.id} scored ${selectedCandidate.qualityScore.toFixed(2)}, below the actionable quality gate.`,
      candidatesConsidered: considered,
    };
  }

  return {
    status: "selected",
    reason: `Selected ${selectedCandidate.kind} ${selectedCandidate.id} because it best applies the source's core behavior to the target project.`,
    candidatesConsidered: considered,
    selectedCandidate,
  };
}

function buildPlanCandidates(
  review: OpportunityCouncilReview,
  projectBrief: ProjectBrief,
): PlanCandidate[] {
  const opportunities = new Map(
    review.opportunities.map((opportunity) => [opportunity.id, opportunity]),
  );
  return [
    ...review.bundles.map((bundle) => buildBundleCandidate(bundle, opportunities, projectBrief)),
    ...review.opportunities.map((opportunity) =>
      buildOpportunityCandidate(opportunity, projectBrief),
    ),
  ].filter((candidate): candidate is PlanCandidate => Boolean(candidate));
}

function buildOpportunityCandidate(
  opportunity: Opportunity,
  projectBrief: ProjectBrief,
): PlanCandidate {
  const text = [
    opportunity.title,
    opportunity.lesson,
    opportunity.projectChange,
    opportunity.changeSurface,
    projectBrief.architecture,
    projectBrief.goals.join(" "),
  ].join(" ");
  const sourceCoreFit = sourceCoreFitScore(text);
  const metaInfrastructurePenalty = metaInfrastructurePenaltyScore(text, sourceCoreFit);
  const qualityScore = candidateQualityScore(
    opportunity.score,
    sourceCoreFit,
    metaInfrastructurePenalty,
  );
  return {
    kind: "opportunity",
    id: opportunity.id,
    title: opportunity.title,
    opportunityIds: [opportunity.id],
    projectChange: opportunity.projectChange,
    sourceLesson: opportunity.lesson,
    userValue: opportunity.projectChange,
    evidenceCount: opportunity.evidence.length,
    speculative: opportunity.speculative,
    score: opportunity.score,
    sourceCoreFit,
    metaInfrastructurePenalty,
    qualityScore,
    raw: opportunity,
  };
}

function buildBundleCandidate(
  bundle: OpportunityBundle,
  opportunities: Map<string, Opportunity>,
  projectBrief: ProjectBrief,
): PlanCandidate | undefined {
  const included = bundle.opportunityIds
    .map((id) => opportunities.get(id))
    .filter((opportunity): opportunity is Opportunity => Boolean(opportunity));
  if (included.length === 0) {
    return undefined;
  }
  const score = averageOpportunityScore(included);
  const text = [
    bundle.rationale,
    bundle.sharedChangeSurface,
    bundle.combinedUserValue,
    bundle.maxPrScope,
    included
      .map(
        (opportunity) => `${opportunity.title} ${opportunity.lesson} ${opportunity.projectChange}`,
      )
      .join(" "),
    projectBrief.architecture,
    projectBrief.goals.join(" "),
  ].join(" ");
  const sourceCoreFit = sourceCoreFitScore(text);
  const metaInfrastructurePenalty = metaInfrastructurePenaltyScore(text, sourceCoreFit);
  const qualityScore = candidateQualityScore(score, sourceCoreFit, metaInfrastructurePenalty);
  return {
    kind: "bundle",
    id: bundle.id,
    title: bundle.id,
    opportunityIds: bundle.opportunityIds,
    projectChange: bundle.maxPrScope,
    sourceLesson: included.map((opportunity) => opportunity.lesson).join(" "),
    userValue: bundle.combinedUserValue,
    evidenceCount: included.reduce((sum, opportunity) => sum + opportunity.evidence.length, 0),
    speculative: included.every((opportunity) => opportunity.speculative),
    score,
    sourceCoreFit,
    metaInfrastructurePenalty,
    qualityScore,
    raw: bundle,
  };
}

function averageOpportunityScore(opportunities: Opportunity[]): PlanCandidate["score"] {
  return averageOpportunityScoreVector(opportunities.map((opportunity) => opportunity.score));
}

function summarizeBundleMemberReasoning(
  opportunities: Opportunity[],
  pickReasoning: (opportunity: Opportunity) => string,
): string {
  return opportunities
    .map((opportunity) => `${opportunity.id}: ${pickReasoning(opportunity)}`)
    .join(" | ");
}

function sourceCoreFitScore(text: string): number {
  const normalized = text.toLowerCase();
  const groups = [
    ["knowledge graph", "kg"],
    ["spo", "triple", "triplet"],
    ["entity", "standardiz", "canonical", "dedup"],
    ["relationship", "relation", "inference", "infer"],
    ["visualization", "visualize", "community", "louvain"],
    ["chunk", "extract", "ingest"],
    ["human review", "approval", "provenance", "audit"],
  ];
  const matches = groups.filter((terms) => terms.some((term) => normalized.includes(term))).length;
  return Math.min(1, matches / 5);
}

function metaInfrastructurePenaltyScore(text: string, sourceCoreFit: number): number {
  const normalized = text.toLowerCase();
  const metaTerms = [
    "llm adapter",
    "adapter layer",
    "endpoint",
    "response shape",
    "local-only",
    "raw llm",
    "openai-compatible",
    "provider response",
  ];
  const metaMatches = metaTerms.filter((term) => normalized.includes(term)).length;
  if (metaMatches === 0) {
    return 0;
  }
  const weakCorePenalty = sourceCoreFit < 0.25 ? 0.35 : 0.12;
  return Math.min(0.65, weakCorePenalty + metaMatches * 0.06);
}

function candidateQualityScore(
  score: PlanCandidate["score"],
  sourceCoreFit: number,
  metaInfrastructurePenalty: number,
): number {
  return opportunityScoreToScalar(score, sourceCoreFit, metaInfrastructurePenalty);
}

async function runValidationCommands(
  commands: string[],
  cwd: string,
  shell?: ShellClient,
): Promise<string> {
  if (commands.length === 0) {
    return "No validation commands configured.";
  }
  const run = shell?.run ?? defaultShellRun;
  const outputs: string[] = [];
  for (const command of commands) {
    outputs.push(await run("sh", ["-lc", command], { cwd }));
  }
  return outputs.join("\n");
}

async function openPullRequest(cwd: string, shell?: ShellClient): Promise<string> {
  if (!shell) {
    return "not-opened-by-test-harness";
  }
  const output = await shell.run("gh", ["pr", "create", "--fill"], { cwd });
  return output.trim() || "not-opened";
}

async function defaultShellRun(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<string> {
  const result = await execFileAsync(command, args, { cwd: options.cwd });
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function createDeterministicBamlClient(
  options: SourceToProjectHarnessOptions,
): SourceToProjectBamlClient {
  return {
    async DistillSourceAnalysis(sourceArtifactJson) {
      const source = readJsonRecord(sourceArtifactJson).source ?? options.source;
      return {
        sourceId: "source-1",
        title: String(source),
        accessLevel: "public",
        summary: `Source analysis for ${String(source)}`,
        claims: ["The source contains a transferable implementation lesson."],
        transferableLessons: [
          "Use the source lesson to improve a matching project change surface.",
        ],
        evidence: [
          { id: "source-e1", source: String(source), quote: "transferable implementation lesson" },
        ],
      };
    },
    async DistillCorroboration(sourceAnalysis) {
      return {
        sourceId: sourceAnalysis.sourceId,
        corroboratedClaims: sourceAnalysis.claims,
        disputedClaims: [],
        competingViews: [],
        citations: sourceAnalysis.evidence,
      };
    },
    async DistillProjectBrief(projectJson) {
      const project = readJsonRecord(projectJson);
      const displayName = String(project.displayName ?? options.project.displayName);
      return {
        projectId: String(project.id ?? options.project.id),
        displayName,
        architecture: "Repository architecture summarized by the harness.",
        constraints: options.project.contextDocs,
        goals: ["Apply source-grounded improvements."],
        changeSurfaces: ["src"],
        validationCommands: options.project.validationCommands,
        risks: ["Generated brief should be reviewed before implementation."],
        evidence: [{ id: "project-e1", source: options.project.workingTree, quote: displayName }],
      };
    },
    async MapSourceToProject(sourceAnalysis, _corroboration, projectBrief) {
      return {
        opportunities: [
          {
            id: "opp-1",
            title: `Apply ${sourceAnalysis.title} to ${projectBrief.displayName}`,
            lesson: sourceAnalysis.transferableLessons[0] ?? sourceAnalysis.summary,
            projectChange: "Create a bounded plan for the matching project surface.",
            changeSurface: projectBrief.changeSurfaces[0] ?? "src",
            score: {
              applicability: 0.9,
              applicabilityReasoning:
                "The source lesson maps directly onto an existing project change surface.",
              impact: 0.86,
              impactReasoning:
                "Applying the lesson is expected to meaningfully improve the target change surface.",
              confidence: 0.85,
              confidenceReasoning:
                "The deterministic offline harness has consistent source and project evidence.",
              implementationCost: 0.4,
              implementationCostReasoning:
                "The change is scoped to a single matching project change surface.",
              risk: 0.3,
              riskReasoning: "Low regression risk since the change surface is narrow and reviewed.",
            },
            evidence: [...sourceAnalysis.evidence, ...projectBrief.evidence],
            speculative: false,
          },
        ],
        nonApplicableLessons: [],
        bundles: [],
        rankingRationale: "Single deterministic opportunity produced by the offline harness.",
      };
    },
    async DistillPlanArtifact(_opportunityJson, _rawPlan, rawPlanArtifactPath) {
      return {
        opportunityIds: ["opp-1"],
        title: "Apply source-to-project opportunity",
        recommendation:
          "Implement the highest-ranked source-to-project opportunity as a bounded improvement plan.",
        problemSolved:
          "The target project has a relevant change surface but no concrete implementation plan yet.",
        sourceLessonApplied: "Use the source lesson to improve a matching project change surface.",
        targetChange:
          "Create a small, reviewable change on the matching project surface and keep validation explicit.",
        expectedUserValue:
          "Maintainers get a source-grounded plan that can be implemented and reviewed without rereading the full run.",
        implementationOutline: [
          "Confirm the target files and project constraints.",
          "Apply the source lesson to the smallest viable project surface.",
          "Run the configured validation commands and review residual risks.",
        ],
        scope: "Advisory plan generated by the offline harness.",
        filesLikelyTouched: ["src"],
        validationCommands: options.project.validationCommands,
        risks: ["Review plan before implementation."],
        rawPlanArtifactPath,
      };
    },
    async ReviewFinalRecommendation(
      _originalPrompt,
      _source,
      _sourceAnalysis,
      _corroboration,
      _projectBrief,
      plans,
    ) {
      if (plans.length === 0) {
        return buildNoPlanReview();
      }
      return {
        status: "accepted",
        actionable: true,
        improvesProject: true,
        unnecessaryComplexity: false,
        benefitOutweighsCost: true,
        complexityAssessment:
          "The offline harness treats the bounded plan as low enough complexity for the expected project value.",
        rationale:
          "The plan is concrete, source-grounded, and bounded to configured project validation.",
        rejectionReason: null,
        telegramSummary: "Final source-to-project review accepted the recommendation.",
      };
    },
  };
}

function readJsonRecord(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
