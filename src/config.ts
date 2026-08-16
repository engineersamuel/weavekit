import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  MastermindAction,
  type MastermindAction as MastermindActionValue,
} from "./mastermind/domain/events.js";
import { ExecutorKind, type ExecutorKind as ExecutorKindValue } from "./submind/contracts.js";
import { ExecutionPreflightKind, type ExecutionPreflightRequirement } from "./submind/preflight.js";

export type SourceToProjectMode = "advisory" | "autonomous-pr";
export type VerificationOptimizerMode = "advisory" | "autonomous-pr";
export type NotificationPolicy = "cli" | "telegram";
export type KnowledgeExportPolicy = "off" | "sanitized";

export const ProjectRepositoryMode = {
  EXISTING_REPOSITORY: "EXISTING_REPOSITORY",
  GREENFIELD: "GREENFIELD",
} as const;
export type ProjectRepositoryMode =
  (typeof ProjectRepositoryMode)[keyof typeof ProjectRepositoryMode];

export const RouterRoute = {
  DIRECT_ANSWER: "direct-answer",
  REFINE_PROMPT: "refine-prompt",
  GOAL_PROMPT: "goal-prompt",
  PLAN: "plan",
  GRILL_WITH_DOCS: "grill-with-docs",
  RESEARCH: "research",
  LOCAL_CODE_CHANGE: "local-code-change",
  FLEET_PARALLEL: "fleet-parallel",
  REMOTE_DELEGATE_PR: "remote-delegate-pr",
  DECISION_COUNCIL: "decision-council",
  SOURCE_TO_PROJECT: "source-to-project",
  MANUAL_HERDR_WORKTREE: "manual-herdr-worktree",
} as const;
export type RouterRoute = (typeof RouterRoute)[keyof typeof RouterRoute];

export type CapabilityCatalogEntry = {
  id: string;
  route: RouterRoute;
  harness: string;
  ability?: string;
  model?: string;
  taskFit: string[];
  strengths: string[];
  limitations: string[];
  source?: string;
};

export type RoutingPreferenceOverlay = {
  id: string;
  match: string[];
  prefer?: {
    route?: RouterRoute;
    harness?: string;
    ability?: string;
    model?: string;
  };
  weight?: number;
  force?: boolean;
  rationale: string;
};

export type RouterDefaults = {
  primaryModel: string;
  catalog: CapabilityCatalogEntry[];
  preferences: RoutingPreferenceOverlay[];
};

export type SourceToProjectThresholds = {
  minApplicability: number;
  minConfidence: number;
  minImpact: number;
  minAcceptanceAverage: number;
  maxRisk: number;
};

export type BudgetGateConfig = {
  enabled: boolean;
  mode: "warn" | "block";
  ceilingUsd: number;
  marginFactor: number;
  tokenCeiling?: number;
};

export type CouncilDeliberationConfig = {
  /** Whether the council-review node runs a real persona-driven deliberation (real Copilot SDK agent sessions per persona) in addition to the deterministic acceptance gate. */
  enabled: boolean;
  /** Cap on debate rounds for the deliberation. Kept small by default since each round runs a real agent session per selected persona. */
  maxRounds: number;
};

export type SourceToProjectPrLauncherAgentOption = {
  id: string;
  label: string;
  agentCommand: string;
  agentArgs: string[];
};

export type SourceToProjectPrLauncherConfig = {
  provider: "herdr";
  agentCommand: string;
  agentArgs: string[];
  split: "right" | "down";
  /** Selectable agents for the dashboard's Create PR agent dropdown. First entry is the default. */
  agentOptions: SourceToProjectPrLauncherAgentOption[];
};

export type SourceToProjectDefaults = {
  /** Cap on accepted opportunities promoted per run. 0 means unlimited: promote every opportunity that clears the acceptance thresholds. */
  maxOpportunities: number;
  thresholds: SourceToProjectThresholds;
  mode: SourceToProjectMode;
  offline: boolean;
  copilotModel?: string;
  timeoutMs?: number;
  maxToolCalls?: number;
  sourceReadingMaxToolCalls?: number;
  projectResearchMaxToolCalls?: number;
  budgetGate?: BudgetGateConfig;
  prLauncher: SourceToProjectPrLauncherConfig;
  /**
   * When true, automatically create a Herdr worktree and start the configured agent to
   * implement an accepted opportunity as soon as its report node passes, instead of waiting
   * for a manual "Create PR" click. Still gated per-project by `autonomousPrAllowed`.
   */
  autoImplementOnReport: boolean;
  councilDeliberation?: CouncilDeliberationConfig;
};

export const DeepResearchProvider = {
  EXA: "exa",
  GROK: "grok",
  TAVILY: "tavily",
  PERPLEXITY: "perplexity",
  COPILOT_LAST30DAYS: "copilot-last30days",
} as const;
export type DeepResearchProvider = (typeof DeepResearchProvider)[keyof typeof DeepResearchProvider];

export type DeepResearchDefaults = {
  providers: DeepResearchProvider[];
  maxIterations: number;
  questionsPerIteration: number;
  maxResultsPerQuestion: number;
  providerRetryAttempts: number;
  visualize: boolean;
};

export type VerificationOptimizerThresholds = {
  minConfidence: number;
  minImpact: number;
  maxRisk: number;
  maxImplementationCost: number;
  minEvidenceReferences: number;
  requireNonSpeculative: boolean;
  requireProofCommands: boolean;
};

export type VerificationOptimizerDefaults = {
  mode: VerificationOptimizerMode;
  externalResearch: boolean;
  thresholds: VerificationOptimizerThresholds;
};

export type CopilotDefaults = {
  verboseEvents: boolean;
  model?: string;
  runtimeUrl?: string;
  cliUrl?: string;
  cliPath?: string;
  sdkDoctorModel?: string;
};

export type FlueDefaults = {
  model: string;
};

export type MastermindProjectMapping = {
  teamId: string;
  linearProjectId?: string;
  projectId: string;
};

export type MastermindExecutionDefaults = {
  executorKind: ExecutorKindValue;
  harnessKind: string;
  harnessCommand?: string;
  harnessArgs?: string[];
  maxAutopilotContinues: number;
  allowTools: string[];
  denyTools: string[];
  allowUrls: string[];
  denyUrls: string[];
  pollIntervalMs: number;
  unknownStatusThreshold: number;
  cancellationGraceMs: number;
  promptAcceptanceTimeoutMs: number;
  maxAttempts: number;
};

/**
 * Sibling execution config for `MastermindAction.DELEGATE_SUBMIND`, executed via
 * {@link ExecutorKind.RLM_SUBMIND} (a detached `rlm-poc` process) instead of the Herdr-pane
 * `IMPLEMENT_DIRECTLY` path configured by {@link MastermindExecutionDefaults}.
 */
export type MastermindRlmExecutionDefaults = {
  executorKind: ExecutorKindValue;
  /** RLM profile used for the delegated implementation session. Fixed to "general". */
  profile: string;
  model?: string;
  maxDepth: number;
  maxTotalCalls: number;
  /** Enables `invoke_trellage` on the RLM run so it may itself delegate to a nested worktree. */
  enableTrellage: boolean;
  pollIntervalMs: number;
  unknownStatusThreshold: number;
  cancellationGraceMs: number;
  maxAttempts: number;
};

/**
 * Opt-in self-improvement feedback loop: after a RLM/Submind-delegated work item reaches a
 * terminal state, analyze its captured Langfuse trace against the ticket and mission-statement
 * text, and file triage tickets in a separate Linear team/project for concrete findings. Only
 * meaningful for {@link ExecutorKind.RLM_SUBMIND} attempts (only those carry a Submind trace).
 */
export type MastermindSelfImprovementDefaults = {
  enabled: boolean;
  targetTeamId: string;
  targetProjectId?: string;
  minSeverity: "BLOCKING" | "IMPORTANT" | "SUGGESTION";
  ticketLabelId?: string;
};

export const MastermindHarnessTransport = {
  COPILOT_SDK: "copilot-sdk",
  COMMAND: "command",
  HERDR: "herdr",
} as const;
export type MastermindHarnessTransport =
  (typeof MastermindHarnessTransport)[keyof typeof MastermindHarnessTransport];

export type MastermindHarnessProfile = {
  transport: MastermindHarnessTransport;
  command: string;
  args: string[];
  kind?: string;
  model?: string;
};

export type MastermindHarnessProfiles = {
  ticketReview: MastermindHarnessProfile;
  implementation: MastermindHarnessProfile;
  codeReview: MastermindHarnessProfile;
};

export type MastermindDefaults = {
  enabled: boolean;
  host: string;
  port: number;
  sqlitePath: string;
  instanceId: string;
  webhookPath: string;
  publicWebhookUrl?: string;
  cloudflareTunnel?: string;
  cloudflareTunnelConfig?: string;
  linearOrganizationId?: string;
  linearWebhookId?: string;
  synthesisModel: string;
  reviewedLabelId: string;
  reviewedLabelName: string;
  readyLabelId: string;
  readyLabelName: string;
  needsInputLabelId: string;
  needsInputLabelName: string;
  reviewFailedLabelId: string;
  reviewFailedLabelName: string;
  codeReviewLabelId?: string;
  codeReviewLabelName?: string;
  codeReviewPassedLabelId?: string;
  codeReviewPassedLabelName?: string;
  changesRequestedLabelId?: string;
  changesRequestedLabelName?: string;
  inProgressStateName?: string;
  inReviewStateName?: string;
  doneStateName?: string;
  leaseDurationMs: number;
  reconcileIntervalMs: number;
  maxDecisionIterations: number;
  allowedActions: MastermindActionValue[];
  projectMappings: MastermindProjectMapping[];
  harnesses?: MastermindHarnessProfiles;
  execution?: MastermindExecutionDefaults;
  rlmExecution?: MastermindRlmExecutionDefaults;
  selfImprovement?: MastermindSelfImprovementDefaults;
};

export type ProjectDirectExecutionPolicy = {
  enabled: boolean;
  allowedExecutorKinds: ExecutorKindValue[];
  allowedPullRequestHosts: string[];
};

export type ToolingDefaults = {
  skillsDirectory?: string;
  agentNativeSkillsInstaller?: string;
  agentNativeSkillsPackage?: string;
  miseBin?: string;
};

export type CacheConfig = {
  enabled: boolean;
  ttlHours: number;
  dir: string;
};

export const SupportedPluginId = {
  HVE_CORE: "hve-core",
} as const;
export type SupportedPluginId = (typeof SupportedPluginId)[keyof typeof SupportedPluginId];

export type PluginDirectoryConfig = {
  directory: string;
};

export type PluginConfigs = Partial<Record<SupportedPluginId, PluginDirectoryConfig>>;

export type ProjectCatalogEntry = {
  id: string;
  displayName: string;
  workingTree: string;
  repositoryMode?: ProjectRepositoryMode;
  provisioningRoot?: string;
  mainline: string;
  remote: string;
  contextDocs: string[];
  validationCommands: string[];
  executionPreflightRequirements?: ExecutionPreflightRequirement[];
  directExecution?: ProjectDirectExecutionPolicy;
  autonomousPrAllowed: boolean;
  /** Cap on accepted opportunities promoted per run. 0 or undefined means unlimited (falls back to the global default, which also defaults to unlimited). */
  maxOpportunities?: number;
  thresholds?: Partial<SourceToProjectThresholds>;
  budgetGate?: Partial<BudgetGateConfig>;
  notification: NotificationPolicy;
  knowledgeExport: KnowledgeExportPolicy;
};

export type WeavekitConfig = {
  env: Record<string, string>;
  copilot: CopilotDefaults;
  flue: FlueDefaults;
  mastermind: MastermindDefaults;
  tooling: ToolingDefaults;
  sourceToProject: SourceToProjectDefaults;
  router: RouterDefaults;
  deepResearch: DeepResearchDefaults;
  verificationOptimizer: VerificationOptimizerDefaults;
  plugins: PluginConfigs;
  projects: Record<string, ProjectCatalogEntry>;
  cache: CacheConfig;
};

const DEFAULT_URL_CACHE_TTL_HOURS = 24 * 30;

export function defaultCacheConfig(): CacheConfig {
  return {
    enabled: true,
    ttlHours: DEFAULT_URL_CACHE_TTL_HOURS,
    dir: join(homedir(), ".weavekit", "cache", "urls"),
  };
}

export function getDefaultWeavekitConfigPath(): string {
  return join(homedir(), ".weavekit", "config.toml");
}

export function expandHomePath(path: string, home = homedir()): string {
  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(home, path.slice(2));
  }
  return path;
}

export function defaultPluginDirectory(plugin: SupportedPluginId): string {
  if (plugin === SupportedPluginId.HVE_CORE) {
    return join(homedir(), ".copilot", "installed-plugins", "_direct", "hve-core");
  }
  return "";
}

export function resolveWeavekitPluginDirectory(
  plugin: SupportedPluginId,
  plugins: PluginConfigs | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = plugins?.[plugin]?.directory.trim();
  if (configured) {
    return expandHomePath(configured);
  }
  if (plugin === SupportedPluginId.HVE_CORE) {
    const envValue = env.WEAVEKIT_HVE_CORE_PLUGIN_DIR?.trim();
    if (envValue) {
      return expandHomePath(envValue);
    }
  }
  return defaultPluginDirectory(plugin);
}

export function loadLocalEnvFiles(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ...loadEnvFile(join(cwd, ".env"), env, parseDotEnvLine),
    ...loadEnvFile(join(cwd, ".env.fish"), env, parseFishEnvLine),
  };
}

export function loadWeavekitConfig(
  configPath = getDefaultWeavekitConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!existsSync(configPath)) {
    return {};
  }

  const parsed = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const loaded: Record<string, string> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) {
      continue;
    }

    const normalizedValue = typeof value === "string" ? value : String(value);
    loaded[key] = normalizedValue;
    if (env[key] === undefined) {
      env[key] = normalizedValue;
    }
  }

  return loaded;
}

function loadEnvFile(
  path: string,
  env: NodeJS.ProcessEnv,
  parseLine: (line: string) => [string, string] | undefined,
): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  const loaded: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) {
      continue;
    }
    const [key, value] = parsed;
    if (env[key] === undefined) {
      env[key] = value;
      loaded[key] = value;
    }
  }
  return loaded;
}

function parseDotEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) {
    return undefined;
  }
  return [match[1]!, unquoteEnvValue(match[2] ?? "")];
}

function parseFishEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }
  const tokens = tokenizeFishSet(trimmed);
  if (tokens[0] !== "set" || tokens.length < 4) {
    return undefined;
  }
  const flagIndex = tokens.findIndex(
    (token) => token === "-gx" || token === "-x" || token === "--global" || token === "--export",
  );
  if (flagIndex === -1) {
    return undefined;
  }
  const key = tokens[flagIndex + 1];
  if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return undefined;
  }
  return [key, tokens.slice(flagIndex + 2).join(" ")];
}

function tokenizeFishSet(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function unquoteEnvValue(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  if (
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
}

export function loadTypedWeavekitConfig(
  configPath = getDefaultWeavekitConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
): WeavekitConfig {
  const loadedEnv = loadWeavekitConfig(configPath, env);
  if (!existsSync(configPath)) {
    return {
      env: loadedEnv,
      copilot: readCopilotDefaults(undefined, env),
      flue: readFlueDefaults(undefined, env),
      mastermind: readMastermindDefaults(undefined, env),
      tooling: readToolingDefaults(undefined, env),
      sourceToProject: readSourceToProjectDefaults(undefined, env),
      router: readRouterDefaults(undefined),
      deepResearch: readDeepResearchDefaults(undefined, env),
      verificationOptimizer: readVerificationOptimizerDefaults(undefined),
      plugins: readPluginConfigs(undefined, env),
      projects: {},
      cache: readCacheConfig(undefined, env),
    };
  }

  const parsed = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const copilot = readCopilotDefaults(parsed.copilot, env);
  const flue = readFlueDefaults(parsed.flue, env);
  const mastermind = readMastermindDefaults(parsed.mastermind, env);
  const tooling = readToolingDefaults(parsed.tooling, env);
  const sourceToProject = readSourceToProjectDefaults(parsed.source_to_project, env);
  const router = readRouterDefaults(parsed.router);
  const deepResearch = readDeepResearchDefaults(parsed.deep_research, env);
  const verificationOptimizer = readVerificationOptimizerDefaults(parsed.verification_optimizer);
  const plugins = readPluginConfigs(parsed.plugins, env);
  const projects = readProjectCatalog(parsed.projects);
  const cache = readCacheConfig(parsed.cache, env);
  return {
    env: loadedEnv,
    copilot,
    flue,
    mastermind,
    tooling,
    sourceToProject,
    router,
    deepResearch,
    verificationOptimizer,
    plugins,
    projects,
    cache,
  };
}

export async function loadVarlockEnvironment(): Promise<void> {
  await import("varlock/auto-load");
}

export async function loadMastermindRuntimeConfig(
  configPath = getDefaultWeavekitConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
  options: {
    loadVarlock?: () => Promise<void>;
  } = {},
): Promise<WeavekitConfig> {
  loadWeavekitConfig(configPath, env);
  await (options.loadVarlock ?? loadVarlockEnvironment)();
  return loadTypedWeavekitConfig(configPath, env);
}

function readCacheConfig(value: unknown, env: NodeJS.ProcessEnv): CacheConfig {
  const defaults = defaultCacheConfig();
  const record = asRecord(value);
  const envDisabled = readEnvBoolean(env, "WEAVEKIT_NO_CACHE") === true;
  return {
    enabled: envDisabled ? false : readBoolean(record.enabled, defaults.enabled),
    ttlHours: readNumber(record.ttl_hours, defaults.ttlHours),
    dir: expandOptionalPath(readOptionalString(record.dir)) ?? defaults.dir,
  };
}

export function resolveProjectCatalogEntry(
  config: WeavekitConfig,
  projectId: string,
): ProjectCatalogEntry {
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project id: ${projectId}`);
  }
  return {
    ...project,
    budgetGate: {
      ...defaultBudgetGateConfig(),
      ...config.sourceToProject.budgetGate,
      ...project.budgetGate,
    },
  };
}

export function defaultBudgetGateConfig(): BudgetGateConfig {
  return {
    enabled: true,
    mode: "warn",
    ceilingUsd: 25,
    marginFactor: 1.5,
  };
}

export function defaultCouncilDeliberationConfig(): CouncilDeliberationConfig {
  return {
    enabled: false,
    maxRounds: 1,
  };
}

function defaultSourceToProjectDefaults(): SourceToProjectDefaults {
  return {
    maxOpportunities: 0,
    thresholds: {
      minApplicability: 0.7,
      minConfidence: 0.65,
      minImpact: 0.5,
      minAcceptanceAverage: 0.85,
      maxRisk: 0.8,
    },
    mode: "advisory",
    offline: false,
    budgetGate: defaultBudgetGateConfig(),
    prLauncher: {
      provider: "herdr",
      agentCommand: "codex",
      agentArgs: ["--dangerously-bypass-approvals-and-sandbox"],
      split: "right",
      agentOptions: [
        {
          id: "codex",
          label: "Codex",
          agentCommand: "codex",
          agentArgs: ["--dangerously-bypass-approvals-and-sandbox"],
        },
        { id: "copilot", label: "Copilot", agentCommand: "copilot", agentArgs: ["--allow-all"] },
      ],
    },
    autoImplementOnReport: false,
    councilDeliberation: defaultCouncilDeliberationConfig(),
  };
}

const DEFAULT_MASTERMIND_SYNTHESIS_MODEL = "gpt-5.5";

function defaultMastermindDefaults(env: NodeJS.ProcessEnv): MastermindDefaults {
  return {
    enabled: false,
    host: "127.0.0.1",
    port: 8787,
    sqlitePath: join(homedir(), ".weavekit", "mastermind.sqlite"),
    instanceId: env.MASTERMIND_INSTANCE_ID?.trim() || `mastermind-${process.pid}`,
    webhookPath: "/channels/linear/webhook",
    publicWebhookUrl: env.MASTERMIND_PUBLIC_WEBHOOK_URL?.trim() || undefined,
    cloudflareTunnel: env.MASTERMIND_CLOUDFLARE_TUNNEL?.trim() || undefined,
    cloudflareTunnelConfig:
      expandOptionalPath(env.MASTERMIND_CLOUDFLARE_TUNNEL_CONFIG?.trim()) ?? undefined,
    linearOrganizationId: env.LINEAR_ORGANIZATION_ID?.trim() || undefined,
    linearWebhookId: env.LINEAR_WEBHOOK_ID?.trim() || undefined,
    synthesisModel: env.BAML_MODEL?.trim() || DEFAULT_MASTERMIND_SYNTHESIS_MODEL,
    reviewedLabelId: env.MASTERMIND_REVIEWED_LABEL_ID?.trim() || "",
    reviewedLabelName: env.MASTERMIND_REVIEWED_LABEL_NAME?.trim() || "mastermind-reviewed",
    readyLabelId: env.MASTERMIND_READY_LABEL_ID?.trim() || "",
    readyLabelName: env.MASTERMIND_READY_LABEL_NAME?.trim() || "mastermind-ready",
    needsInputLabelId: env.MASTERMIND_NEEDS_INPUT_LABEL_ID?.trim() || "",
    needsInputLabelName: env.MASTERMIND_NEEDS_INPUT_LABEL_NAME?.trim() || "mastermind-needs-input",
    reviewFailedLabelId: env.MASTERMIND_REVIEW_FAILED_LABEL_ID?.trim() || "",
    reviewFailedLabelName:
      env.MASTERMIND_REVIEW_FAILED_LABEL_NAME?.trim() || "mastermind-review-failed",
    codeReviewLabelId: env.MASTERMIND_CODE_REVIEW_LABEL_ID?.trim() || "",
    codeReviewLabelName: env.MASTERMIND_CODE_REVIEW_LABEL_NAME?.trim() || "mastermind-code-review",
    codeReviewPassedLabelId: env.MASTERMIND_CODE_REVIEW_PASSED_LABEL_ID?.trim() || "",
    codeReviewPassedLabelName:
      env.MASTERMIND_CODE_REVIEW_PASSED_LABEL_NAME?.trim() || "mastermind-code-review-passed",
    changesRequestedLabelId: env.MASTERMIND_CHANGES_REQUESTED_LABEL_ID?.trim() || "",
    changesRequestedLabelName:
      env.MASTERMIND_CHANGES_REQUESTED_LABEL_NAME?.trim() || "mastermind-changes-requested",
    inProgressStateName: env.MASTERMIND_IN_PROGRESS_STATE_NAME?.trim() || "In Progress",
    inReviewStateName: env.MASTERMIND_IN_REVIEW_STATE_NAME?.trim() || "In Review",
    doneStateName: env.MASTERMIND_DONE_STATE_NAME?.trim() || "Done",
    leaseDurationMs: 60_000,
    reconcileIntervalMs: 30_000,
    maxDecisionIterations: 3,
    allowedActions: [
      MastermindAction.REVIEW_TICKET,
      MastermindAction.IMPLEMENT_DIRECTLY,
      MastermindAction.DELEGATE_SUBMIND,
      MastermindAction.WAIT,
      MastermindAction.NEEDS_HUMAN,
      MastermindAction.IGNORE,
    ],
    projectMappings: [],
    harnesses: {
      ticketReview: {
        transport: MastermindHarnessTransport.COPILOT_SDK,
        command: "copilot",
        args: [],
        model: "claude-opus-4.8",
      },
      implementation: {
        transport: MastermindHarnessTransport.HERDR,
        command: "copilot",
        args: [],
        kind: "copilot",
      },
      codeReview: {
        transport: MastermindHarnessTransport.COPILOT_SDK,
        command: "copilot",
        args: [],
        model: "claude-opus-4.8",
      },
    },
    execution: undefined,
    rlmExecution: undefined,
    selfImprovement: undefined,
  };
}

function defaultRouterDefaults(): RouterDefaults {
  return {
    primaryModel: "gpt-5.5",
    catalog: [
      {
        id: "copilot-direct-answer",
        route: RouterRoute.DIRECT_ANSWER,
        harness: "copilot-cli",
        ability: "direct-answer",
        model: "gpt-5.5",
        taskFit: ["narrow factual questions", "simple guidance", "low-mutation advice"],
        strengths: ["fast response", "uses current session context"],
        limitations: ["not suitable for broad implementation or multi-source research"],
        source: "default-config",
      },
      {
        id: "copilot-refine-prompt",
        route: RouterRoute.REFINE_PROMPT,
        harness: "copilot-cli",
        ability: "prompt-build",
        model: "gpt-5.5",
        taskFit: ["prompt cleanup", "instruction restructuring", "prompt quality improvement"],
        strengths: ["improves prompt clarity without starting execution"],
        limitations: ["does not persist execution state"],
        source: "default-config",
      },
      {
        id: "copilot-goal-mode",
        route: RouterRoute.GOAL_PROMPT,
        harness: "copilot-cli",
        ability: "goal",
        model: "gpt-5.5",
        taskFit: ["durable execution goals", "keep-working requests", "strict verification loops"],
        strengths: ["persists remaining work", "records completion proof"],
        limitations: ["requires explicit goal-mode intent"],
        source: "default-config",
      },
      {
        id: "copilot-plan",
        route: RouterRoute.PLAN,
        harness: "copilot-cli",
        ability: "task-plan",
        model: "claude-opus-4.8",
        taskFit: ["implementation planning", "requirements decomposition", "task breakdowns"],
        strengths: ["strong planning synthesis", "keeps workflow advisory"],
        limitations: ["does not modify code by itself"],
        source: "default-config",
      },
      {
        id: "mattpocock-grill-with-docs",
        route: RouterRoute.GRILL_WITH_DOCS,
        harness: "copilot-cli",
        ability: "grill-with-docs",
        model: "claude-opus-4.8",
        taskFit: ["ambiguous prompts", "missing requirements", "domain-model interrogation"],
        strengths: ["elicits missing fields before handoff"],
        limitations: ["requires user answers before execution"],
        source: "mattpocock/skills",
      },
      {
        id: "copilot-deep-research",
        route: RouterRoute.RESEARCH,
        harness: "weavekit",
        ability: "deep-research",
        model: "claude-sonnet-5",
        taskFit: ["current evidence", "multi-source synthesis", "recent ecosystem research"],
        strengths: ["cited research loop", "bounded provider strategy"],
        limitations: ["higher latency than direct answer"],
        source: "default-config",
      },
      {
        id: "codex-local-code-change",
        route: RouterRoute.LOCAL_CODE_CHANGE,
        harness: "codex-cli",
        ability: "local-code-change",
        model: "gpt-5.3-codex",
        taskFit: [
          "single-worktree implementation",
          "targeted bug fixes",
          "test-driven code changes",
        ],
        strengths: ["optimized for code editing", "runs local validation"],
        limitations: ["mutates the current worktree"],
        source: "default-config",
      },
      {
        id: "copilot-fleet-parallel",
        route: RouterRoute.FLEET_PARALLEL,
        harness: "copilot-cli",
        ability: "orchestration",
        model: "gpt-5.5",
        taskFit: ["decomposable work", "parallel subagent research", "multi-surface audits"],
        strengths: ["coordinates independent workers"],
        limitations: ["requires separable task boundaries"],
        source: "default-config",
      },
      {
        id: "copilot-remote-delegate-pr",
        route: RouterRoute.REMOTE_DELEGATE_PR,
        harness: "copilot-coding-agent",
        ability: "pull-request",
        model: "gpt-5.3-codex",
        taskFit: ["remote PR delegation", "cloud agent handoff", "non-local implementation"],
        strengths: ["produces PRs without occupying local worktree"],
        limitations: ["needs clear repository and PR scope"],
        source: "default-config",
      },
      {
        id: "weavekit-decision-council",
        route: RouterRoute.DECISION_COUNCIL,
        harness: "weavekit",
        ability: "decision-council",
        model: "gpt-5.5",
        taskFit: ["tradeoff-heavy decisions", "architecture choices", "multi-perspective review"],
        strengths: ["explicit objections and alternatives"],
        limitations: ["not an implementation engine"],
        source: "default-config",
      },
      {
        id: "weavekit-source-to-project",
        route: RouterRoute.SOURCE_TO_PROJECT,
        harness: "weavekit",
        ability: "source-to-project",
        model: "claude-opus-4.8",
        taskFit: ["map source artifact to target project", "opportunity discovery"],
        strengths: ["typed source/project contract", "ranked project opportunities"],
        limitations: ["requires source and target project"],
        source: "default-config",
      },
      {
        id: "herdr-manual-worktree",
        route: RouterRoute.MANUAL_HERDR_WORKTREE,
        harness: "herdr",
        ability: "manual-create-worktree",
        model: "gpt-5.3-codex",
        taskFit: ["manual worktree handoff", "branch-scoped agent launch"],
        strengths: ["keeps launch human-controlled", "supports chosen harness"],
        limitations: ["requires project, branch/worktree, harness, and rewritten prompt"],
        source: "default-config",
      },
      {
        id: "claude-ui-frontend-planning",
        route: RouterRoute.PLAN,
        harness: "claude-code",
        ability: "ui-frontend-plan",
        model: "claude-opus-4.8",
        taskFit: ["frontend architecture", "UI planning", "accessibility-sensitive design"],
        strengths: ["strong visual and interaction planning"],
        limitations: ["advisory unless explicitly handed off"],
        source: "default-config",
      },
    ],
    preferences: [
      {
        id: "ambiguous-prompts-require-grilling",
        match: ["unclear", "ambiguous", "not sure", "maybe", "figure out what I mean"],
        prefer: {
          route: RouterRoute.GRILL_WITH_DOCS,
          harness: "copilot-cli",
          ability: "grill-with-docs",
          model: "claude-opus-4.8",
        },
        weight: 1.5,
        force: true,
        rationale:
          "Ambiguous prompts should elicit requirements instead of inventing missing fields.",
      },
      {
        id: "frontend-ui-prefers-claude-opus",
        match: ["ui", "frontend", "react", "accessibility", "visual design"],
        prefer: {
          route: RouterRoute.PLAN,
          harness: "claude-code",
          ability: "ui-frontend-plan",
          model: "claude-opus-4.8",
        },
        weight: 1.2,
        rationale:
          "UI and frontend planning should prefer Claude Opus 4.8 when the run is advisory.",
      },
    ],
  };
}

function defaultDeepResearchDefaults(): DeepResearchDefaults {
  return {
    providers: [
      DeepResearchProvider.GROK,
      DeepResearchProvider.EXA,
      DeepResearchProvider.COPILOT_LAST30DAYS,
    ],
    maxIterations: 3,
    questionsPerIteration: 5,
    maxResultsPerQuestion: 5,
    providerRetryAttempts: 1,
    visualize: false,
  };
}

function defaultVerificationOptimizerDefaults(): VerificationOptimizerDefaults {
  return {
    mode: "autonomous-pr",
    externalResearch: false,
    thresholds: {
      minConfidence: 0.85,
      minImpact: 0.6,
      maxRisk: 0.35,
      maxImplementationCost: 0.45,
      minEvidenceReferences: 2,
      requireNonSpeculative: true,
      requireProofCommands: true,
    },
  };
}

function defaultCopilotDefaults(): CopilotDefaults {
  return {
    verboseEvents: false,
  };
}

function defaultFlueDefaults(): FlueDefaults {
  return {
    model: "anthropic/claude-haiku-4-5",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readEnvBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return true;
}

function readEnvPositiveInteger(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readEnvStringArray(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readNotificationPolicy(value: unknown): NotificationPolicy {
  return value === "telegram" ? "telegram" : "cli";
}

function readBudgetGateConfig(
  value: unknown,
  defaults: BudgetGateConfig,
  path: string,
): BudgetGateConfig {
  const record = asRecord(value);
  const mode = readBudgetGateMode(record.mode, defaults.mode, `${path}.mode`);
  const ceilingUsd = readPositiveNumber(
    record.ceiling_usd,
    defaults.ceilingUsd,
    `${path}.ceiling_usd`,
  );
  const marginFactor = readAtLeastOneNumber(
    record.margin_factor,
    defaults.marginFactor,
    `${path}.margin_factor`,
  );
  const tokenCeiling =
    record.token_ceiling === undefined
      ? defaults.tokenCeiling
      : readPositiveInteger(record.token_ceiling, `${path}.token_ceiling`);
  return {
    enabled: readBoolean(record.enabled, defaults.enabled),
    mode,
    ceilingUsd,
    marginFactor,
    ...(tokenCeiling === undefined ? {} : { tokenCeiling }),
  };
}

function readCouncilDeliberationConfig(
  value: unknown,
  defaults: CouncilDeliberationConfig,
  path: string,
  env: NodeJS.ProcessEnv,
): CouncilDeliberationConfig {
  const record = asRecord(value);
  const maxRounds =
    record.max_rounds === undefined
      ? (readEnvPositiveInteger(
          env,
          "WEAVEKIT_SOURCE_TO_PROJECT_COUNCIL_DELIBERATION_MAX_ROUNDS",
        ) ?? defaults.maxRounds)
      : readPositiveInteger(record.max_rounds, `${path}.max_rounds`);
  return {
    enabled: readBoolean(
      record.enabled,
      readEnvBoolean(env, "WEAVEKIT_SOURCE_TO_PROJECT_COUNCIL_DELIBERATION_ENABLED") ??
        defaults.enabled,
    ),
    maxRounds,
  };
}

function readBudgetGateOverride(
  value: unknown,
  path: string,
): Partial<BudgetGateConfig> | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return undefined;
  }
  const result: Partial<BudgetGateConfig> = {};
  if (record.enabled !== undefined) {
    result.enabled = readBoolean(record.enabled, true);
  }
  if (record.mode !== undefined) {
    result.mode = readBudgetGateMode(record.mode, "warn", `${path}.mode`);
  }
  if (record.ceiling_usd !== undefined) {
    result.ceilingUsd = readPositiveNumber(record.ceiling_usd, 25, `${path}.ceiling_usd`);
  }
  if (record.margin_factor !== undefined) {
    result.marginFactor = readAtLeastOneNumber(record.margin_factor, 1.5, `${path}.margin_factor`);
  }
  if (record.token_ceiling !== undefined) {
    result.tokenCeiling = readPositiveInteger(record.token_ceiling, `${path}.token_ceiling`);
  }
  return result;
}

function readBudgetGateMode(
  value: unknown,
  fallback: "warn" | "block",
  path: string,
): "warn" | "block" {
  if (value === undefined) {
    return fallback;
  }
  if (value === "warn" || value === "block") {
    return value;
  }
  throw new Error(`${path} must be warn or block.`);
}

function readPositiveNumber(value: unknown, fallback: number, path: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be greater than 0.`);
  }
  return value;
}

function readAtLeastOneNumber(value: unknown, fallback: number, path: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new Error(`${path} must be greater than or equal to 1.`);
  }
  return value;
}

function readPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer.`);
  }
  return value;
}

function readSourceToProjectDefaults(
  value: unknown,
  env: NodeJS.ProcessEnv,
): SourceToProjectDefaults {
  const defaults = defaultSourceToProjectDefaults();
  const record = asRecord(value);
  const mode = record.mode === "autonomous-pr" ? "autonomous-pr" : "advisory";
  return {
    maxOpportunities: Math.max(
      0,
      Math.floor(readNumber(record.max_opportunities, defaults.maxOpportunities)),
    ),
    mode,
    offline: readBoolean(
      record.offline,
      readEnvBoolean(env, "WEAVEKIT_SOURCE_TO_PROJECT_OFFLINE") ?? defaults.offline,
    ),
    copilotModel:
      (readOptionalString(record.copilot_model) ?? env.WEAVEKIT_SOURCE_TO_PROJECT_MODEL?.trim()) ||
      undefined,
    timeoutMs:
      readOptionalInteger(record.timeout_ms) ??
      readEnvPositiveInteger(env, "WEAVEKIT_SOURCE_TO_PROJECT_TIMEOUT_MS"),
    maxToolCalls:
      readOptionalInteger(record.max_tool_calls) ??
      readEnvPositiveInteger(env, "WEAVEKIT_SOURCE_TO_PROJECT_MAX_TOOL_CALLS"),
    sourceReadingMaxToolCalls:
      readOptionalInteger(record.source_reading_max_tool_calls) ??
      readEnvPositiveInteger(env, "WEAVEKIT_SOURCE_READING_MAX_TOOL_CALLS"),
    projectResearchMaxToolCalls:
      readOptionalInteger(record.project_research_max_tool_calls) ??
      readEnvPositiveInteger(env, "WEAVEKIT_PROJECT_RESEARCH_MAX_TOOL_CALLS"),
    budgetGate: readBudgetGateConfig(
      record.budget_gate,
      defaults.budgetGate ?? defaultBudgetGateConfig(),
      "source_to_project.budget_gate",
    ),
    prLauncher: readSourceToProjectPrLauncherConfig(record.pr_launcher, defaults.prLauncher),
    autoImplementOnReport: readBoolean(
      record.auto_implement_on_report,
      readEnvBoolean(env, "WEAVEKIT_SOURCE_TO_PROJECT_AUTO_IMPLEMENT_ON_REPORT") ??
        defaults.autoImplementOnReport,
    ),
    councilDeliberation: readCouncilDeliberationConfig(
      record.council_deliberation,
      defaults.councilDeliberation ?? defaultCouncilDeliberationConfig(),
      "source_to_project.council_deliberation",
      env,
    ),
    thresholds: {
      minApplicability: readNumber(record.min_applicability, defaults.thresholds.minApplicability),
      minConfidence: readNumber(record.min_confidence, defaults.thresholds.minConfidence),
      minImpact: readNumber(record.min_impact, defaults.thresholds.minImpact),
      minAcceptanceAverage: readNumber(
        record.min_acceptance_average,
        defaults.thresholds.minAcceptanceAverage,
      ),
      maxRisk: readNumber(record.max_risk, defaults.thresholds.maxRisk),
    },
  };
}

function readDeepResearchDefaults(value: unknown, env: NodeJS.ProcessEnv): DeepResearchDefaults {
  const defaults = defaultDeepResearchDefaults();
  const record = asRecord(value);
  const configuredProviders = readDeepResearchProviders(
    readStringArray(record.providers).length > 0
      ? readStringArray(record.providers)
      : readEnvStringArray(env, "WEAVEKIT_DEEP_RESEARCH_PROVIDERS"),
    defaults.providers,
  );
  return {
    providers: configuredProviders,
    maxIterations:
      readOptionalInteger(record.max_iterations) ??
      readEnvPositiveInteger(env, "WEAVEKIT_DEEP_RESEARCH_MAX_ITERATIONS") ??
      defaults.maxIterations,
    questionsPerIteration:
      readOptionalInteger(record.questions_per_iteration) ??
      readEnvPositiveInteger(env, "WEAVEKIT_DEEP_RESEARCH_QUESTIONS_PER_ITERATION") ??
      defaults.questionsPerIteration,
    maxResultsPerQuestion:
      readOptionalInteger(record.max_results_per_question) ??
      readEnvPositiveInteger(env, "WEAVEKIT_DEEP_RESEARCH_MAX_RESULTS_PER_QUESTION") ??
      defaults.maxResultsPerQuestion,
    providerRetryAttempts:
      readOptionalInteger(record.provider_retry_attempts) ??
      readEnvPositiveInteger(env, "WEAVEKIT_DEEP_RESEARCH_PROVIDER_RETRY_ATTEMPTS") ??
      defaults.providerRetryAttempts,
    visualize: readBoolean(
      record.visualize,
      readEnvBoolean(env, "WEAVEKIT_DEEP_RESEARCH_VISUALIZE") ?? defaults.visualize,
    ),
  };
}

function readRouterDefaults(value: unknown): RouterDefaults {
  const defaults = defaultRouterDefaults();
  const record = asRecord(value);
  const catalog = readRouterCatalog(record.catalog, defaults.catalog);
  const preferences = readRouterPreferences(record.preferences, defaults.preferences);
  return {
    primaryModel: readString(record.primary_model, defaults.primaryModel),
    catalog,
    preferences,
  };
}

function readRouterCatalog(
  value: unknown,
  defaults: CapabilityCatalogEntry[],
): CapabilityCatalogEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    return defaults;
  }
  const entries = value
    .map((entry): CapabilityCatalogEntry | undefined => {
      const record = asRecord(entry);
      const id = readOptionalString(record.id);
      const route = readRouterRoute(record.route);
      const harness = readOptionalString(record.harness);
      if (!id || !route || !harness) {
        return undefined;
      }
      return {
        id,
        route,
        harness,
        ability: readOptionalString(record.ability),
        model: readOptionalString(record.model),
        taskFit: readStringArray(record.task_fit),
        strengths: readStringArray(record.strengths),
        limitations: readStringArray(record.limitations),
        source: readOptionalString(record.source),
      };
    })
    .filter((entry): entry is CapabilityCatalogEntry => entry !== undefined);
  return entries.length > 0 ? entries : defaults;
}

function readRouterPreferences(
  value: unknown,
  defaults: RoutingPreferenceOverlay[],
): RoutingPreferenceOverlay[] {
  if (!Array.isArray(value) || value.length === 0) {
    return defaults;
  }
  const entries = value
    .map((entry): RoutingPreferenceOverlay | undefined => {
      const record = asRecord(entry);
      const id = readOptionalString(record.id);
      const match = readStringArray(record.match);
      const rationale = readOptionalString(record.rationale);
      if (!id || match.length === 0 || !rationale) {
        return undefined;
      }
      const prefer = readRouterPreference(record.prefer);
      return {
        id,
        match,
        ...(prefer ? { prefer } : {}),
        weight:
          typeof record.weight === "number" && Number.isFinite(record.weight)
            ? record.weight
            : undefined,
        force: readBoolean(record.force, false),
        rationale,
      };
    })
    .filter((entry): entry is RoutingPreferenceOverlay => entry !== undefined);
  return entries.length > 0 ? entries : defaults;
}

function readRouterPreference(value: unknown): RoutingPreferenceOverlay["prefer"] | undefined {
  const record = asRecord(value);
  const route = readRouterRoute(record.route);
  const harness = readOptionalString(record.harness);
  const ability = readOptionalString(record.ability);
  const model = readOptionalString(record.model);
  if (!route && !harness && !ability && !model) {
    return undefined;
  }
  return {
    ...(route ? { route } : {}),
    ...(harness ? { harness } : {}),
    ...(ability ? { ability } : {}),
    ...(model ? { model } : {}),
  };
}

function readRouterRoute(value: unknown): RouterRoute | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return Object.values(RouterRoute).includes(normalized as RouterRoute)
    ? (normalized as RouterRoute)
    : undefined;
}

function readDeepResearchProviders(
  value: string[] | undefined,
  fallback: DeepResearchProvider[],
): DeepResearchProvider[] {
  const providers = (value ?? []).flatMap(
    (provider) => normalizeDeepResearchProvider(provider) ?? [],
  );
  return providers.length > 0 ? uniqueDeepResearchProviders(providers) : fallback;
}

function normalizeDeepResearchProvider(provider: string): DeepResearchProvider | undefined {
  const normalized = provider.trim().toLowerCase();
  if (normalized === DeepResearchProvider.EXA) return DeepResearchProvider.EXA;
  if (normalized === DeepResearchProvider.GROK) return DeepResearchProvider.GROK;
  if (normalized === DeepResearchProvider.TAVILY) return DeepResearchProvider.TAVILY;
  if (normalized === DeepResearchProvider.PERPLEXITY) return DeepResearchProvider.PERPLEXITY;
  if (normalized === DeepResearchProvider.COPILOT_LAST30DAYS)
    return DeepResearchProvider.COPILOT_LAST30DAYS;
  return undefined;
}

function uniqueDeepResearchProviders(providers: DeepResearchProvider[]): DeepResearchProvider[] {
  return [...new Set(providers)];
}

function readVerificationOptimizerDefaults(value: unknown): VerificationOptimizerDefaults {
  const defaults = defaultVerificationOptimizerDefaults();
  const record = asRecord(value);
  const mode = record.mode === "advisory" ? "advisory" : "autonomous-pr";
  return {
    mode,
    externalResearch: readBoolean(record.external_research, defaults.externalResearch),
    thresholds: {
      minConfidence: readNumber(record.min_confidence, defaults.thresholds.minConfidence),
      minImpact: readNumber(record.min_impact, defaults.thresholds.minImpact),
      maxRisk: readNumber(record.max_risk, defaults.thresholds.maxRisk),
      maxImplementationCost: readNumber(
        record.max_implementation_cost,
        defaults.thresholds.maxImplementationCost,
      ),
      minEvidenceReferences: Math.max(
        0,
        Math.floor(
          readNumber(record.min_evidence_references, defaults.thresholds.minEvidenceReferences),
        ),
      ),
      requireNonSpeculative: readBoolean(
        record.require_non_speculative,
        defaults.thresholds.requireNonSpeculative,
      ),
      requireProofCommands: readBoolean(
        record.require_proof_commands,
        defaults.thresholds.requireProofCommands,
      ),
    },
  };
}

function readSourceToProjectPrLauncherConfig(
  value: unknown,
  defaults: SourceToProjectPrLauncherConfig,
): SourceToProjectPrLauncherConfig {
  const record = asRecord(value);
  return {
    provider: record.provider === "herdr" ? "herdr" : defaults.provider,
    agentCommand: readString(record.agent_command, defaults.agentCommand),
    agentArgs: Array.isArray(record.agent_args)
      ? readStringArray(record.agent_args)
      : defaults.agentArgs,
    split: record.split === "down" ? "down" : "right",
    agentOptions: readSourceToProjectPrLauncherAgentOptions(
      record.agent_options,
      defaults.agentOptions,
    ),
  };
}

function readSourceToProjectPrLauncherAgentOptions(
  value: unknown,
  defaults: SourceToProjectPrLauncherAgentOption[],
): SourceToProjectPrLauncherAgentOption[] {
  if (!Array.isArray(value) || value.length === 0) {
    return defaults;
  }
  const options = value
    .map((entry): SourceToProjectPrLauncherAgentOption | undefined => {
      const record = asRecord(entry);
      const id = readOptionalString(record.id);
      const agentCommand = readOptionalString(record.agent_command);
      if (!id || !agentCommand) {
        return undefined;
      }
      return {
        id,
        label: readString(record.label, id),
        agentCommand,
        agentArgs: readStringArray(record.agent_args),
      };
    })
    .filter((option): option is SourceToProjectPrLauncherAgentOption => option !== undefined);
  return options.length > 0 ? options : defaults;
}

function readCopilotDefaults(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): CopilotDefaults {
  const defaults = defaultCopilotDefaults();
  const record = asRecord(value);
  return {
    verboseEvents: readBoolean(
      record.verbose_events,
      readEnvBoolean(env, "WEAVEKIT_COPILOT_VERBOSE_EVENTS") ?? defaults.verboseEvents,
    ),
    model: (readOptionalString(record.model) ?? env.COPILOT_MODEL?.trim()) || undefined,
    runtimeUrl:
      (readOptionalString(record.runtime_url) ?? env.COPILOT_RUNTIME_URL?.trim()) || undefined,
    cliUrl: (readOptionalString(record.cli_url) ?? env.COPILOT_CLI_URL?.trim()) || undefined,
    cliPath: expandOptionalPath(
      readOptionalString(record.cli_path) ?? env.COPILOT_CLI_PATH?.trim(),
    ),
    sdkDoctorModel:
      (readOptionalString(record.sdk_doctor_model) ??
        env.WEAVEKIT_ENTITY_SDK_DOCTOR_MODEL?.trim()) ||
      undefined,
  };
}

function readFlueDefaults(value: unknown, env: NodeJS.ProcessEnv): FlueDefaults {
  const defaults = defaultFlueDefaults();
  const record = asRecord(value);
  return {
    model: readOptionalString(record.model) ?? env.WEAVEKIT_FLUE_MODEL?.trim() ?? defaults.model,
  };
}

function readMastermindDefaults(value: unknown, env: NodeJS.ProcessEnv): MastermindDefaults {
  const defaults = defaultMastermindDefaults(env);
  const record = asRecord(value);
  const allowedActions = readStringArray(record.allowed_actions).flatMap((action) =>
    Object.values(MastermindAction).includes(action as MastermindActionValue)
      ? [action as MastermindActionValue]
      : [],
  );
  return {
    enabled: readBoolean(
      record.enabled,
      readEnvBoolean(env, "WEAVEKIT_MASTERMIND_ENABLED") ?? defaults.enabled,
    ),
    host: readString(record.host, env.MASTERMIND_HOST?.trim() || defaults.host),
    port:
      readOptionalInteger(record.port) ??
      readEnvPositiveInteger(env, "MASTERMIND_PORT") ??
      defaults.port,
    sqlitePath:
      expandOptionalPath(
        readOptionalString(record.sqlite_path) ?? env.MASTERMIND_SQLITE_PATH?.trim(),
      ) ?? defaults.sqlitePath,
    instanceId:
      readOptionalString(record.instance_id) ??
      env.MASTERMIND_INSTANCE_ID?.trim() ??
      defaults.instanceId,
    webhookPath: readString(record.webhook_path, defaults.webhookPath),
    publicWebhookUrl:
      readOptionalString(record.public_webhook_url) ??
      env.MASTERMIND_PUBLIC_WEBHOOK_URL?.trim() ??
      defaults.publicWebhookUrl,
    cloudflareTunnel:
      readOptionalString(record.cloudflare_tunnel) ??
      env.MASTERMIND_CLOUDFLARE_TUNNEL?.trim() ??
      defaults.cloudflareTunnel,
    cloudflareTunnelConfig:
      expandOptionalPath(
        readOptionalString(record.cloudflare_tunnel_config) ??
          env.MASTERMIND_CLOUDFLARE_TUNNEL_CONFIG?.trim(),
      ) ?? defaults.cloudflareTunnelConfig,
    linearOrganizationId:
      readOptionalString(record.linear_organization_id) ??
      env.LINEAR_ORGANIZATION_ID?.trim() ??
      defaults.linearOrganizationId,
    linearWebhookId:
      readOptionalString(record.linear_webhook_id) ??
      env.LINEAR_WEBHOOK_ID?.trim() ??
      defaults.linearWebhookId,
    synthesisModel:
      readOptionalString(record.synthesis_model) ??
      env.MASTERMIND_SYNTHESIS_MODEL?.trim() ??
      defaults.synthesisModel,
    reviewedLabelId:
      readOptionalString(record.reviewed_label_id) ??
      env.MASTERMIND_REVIEWED_LABEL_ID?.trim() ??
      defaults.reviewedLabelId,
    reviewedLabelName: readString(record.reviewed_label_name, defaults.reviewedLabelName),
    readyLabelId:
      readOptionalString(record.ready_label_id) ??
      env.MASTERMIND_READY_LABEL_ID?.trim() ??
      defaults.readyLabelId,
    readyLabelName: readString(record.ready_label_name, defaults.readyLabelName),
    needsInputLabelId:
      readOptionalString(record.needs_input_label_id) ??
      env.MASTERMIND_NEEDS_INPUT_LABEL_ID?.trim() ??
      defaults.needsInputLabelId,
    needsInputLabelName: readString(record.needs_input_label_name, defaults.needsInputLabelName),
    reviewFailedLabelId:
      readOptionalString(record.review_failed_label_id) ??
      env.MASTERMIND_REVIEW_FAILED_LABEL_ID?.trim() ??
      defaults.reviewFailedLabelId,
    reviewFailedLabelName: readString(
      record.review_failed_label_name,
      defaults.reviewFailedLabelName,
    ),
    codeReviewLabelId:
      readOptionalString(record.code_review_label_id) ?? defaults.codeReviewLabelId,
    codeReviewLabelName: readString(record.code_review_label_name, defaults.codeReviewLabelName!),
    codeReviewPassedLabelId:
      readOptionalString(record.code_review_passed_label_id) ?? defaults.codeReviewPassedLabelId,
    codeReviewPassedLabelName: readString(
      record.code_review_passed_label_name,
      defaults.codeReviewPassedLabelName!,
    ),
    changesRequestedLabelId:
      readOptionalString(record.changes_requested_label_id) ?? defaults.changesRequestedLabelId,
    changesRequestedLabelName: readString(
      record.changes_requested_label_name,
      defaults.changesRequestedLabelName!,
    ),
    inProgressStateName: readString(record.in_progress_state_name, defaults.inProgressStateName!),
    inReviewStateName: readString(record.in_review_state_name, defaults.inReviewStateName!),
    doneStateName: readString(record.done_state_name, defaults.doneStateName!),
    leaseDurationMs: readOptionalInteger(record.lease_duration_ms) ?? defaults.leaseDurationMs,
    reconcileIntervalMs:
      readOptionalInteger(record.reconcile_interval_ms) ?? defaults.reconcileIntervalMs,
    maxDecisionIterations:
      readOptionalInteger(record.max_decision_iterations) ?? defaults.maxDecisionIterations,
    allowedActions: allowedActions.length > 0 ? allowedActions : defaults.allowedActions,
    projectMappings: readMastermindProjectMappings(record.project_mappings),
    harnesses: readMastermindHarnessProfiles(record.harnesses, defaults.harnesses!),
    execution: readMastermindExecutionDefaults(record.execution),
    rlmExecution: readMastermindRlmExecutionDefaults(record.rlm_execution),
    selfImprovement: readMastermindSelfImprovementDefaults(record.self_improvement),
  };
}

function readMastermindHarnessProfiles(
  value: unknown,
  defaults: MastermindHarnessProfiles,
): MastermindHarnessProfiles {
  const record = asRecord(value);
  return {
    ticketReview: readMastermindHarnessProfile(record.ticket_review, defaults.ticketReview),
    implementation: readMastermindHarnessProfile(record.implementation, defaults.implementation),
    codeReview: readMastermindHarnessProfile(record.code_review, defaults.codeReview),
  };
}

function readMastermindHarnessProfile(
  value: unknown,
  defaults: MastermindHarnessProfile,
): MastermindHarnessProfile {
  if (value === undefined) return { ...defaults, args: [...defaults.args] };
  const record = asRecord(value);
  const transport = readString(record.transport, defaults.transport);
  if (
    !Object.values(MastermindHarnessTransport).includes(transport as MastermindHarnessTransport)
  ) {
    throw new Error(`mastermind harness transport is invalid: ${transport}`);
  }
  const command = readString(record.command, defaults.command).trim();
  if (!command) throw new Error("mastermind harness command must not be empty");
  return {
    transport: transport as MastermindHarnessTransport,
    command,
    args: record.args === undefined ? [...defaults.args] : readStringArray(record.args),
    kind: readOptionalString(record.kind) ?? defaults.kind,
    model: readOptionalString(record.model) ?? defaults.model,
  };
}

function readMastermindExecutionDefaults(value: unknown): MastermindExecutionDefaults | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value);
  const executorKind = readString(record.executor_kind, "");
  if (executorKind !== ExecutorKind.HERDR_COPILOT) {
    throw new Error(`mastermind.execution.executor_kind must be ${ExecutorKind.HERDR_COPILOT}`);
  }
  const harnessKind = readString(record.harness_kind, "");
  if (!harnessKind.trim()) throw new Error("mastermind.execution.harness_kind must not be empty");
  const maxAttempts = readRequiredBoundedInteger(
    record.max_attempts,
    "mastermind.execution.max_attempts",
    1,
    20,
  );
  const maxAutopilotContinues = readRequiredBoundedInteger(
    record.max_autopilot_continues,
    "mastermind.execution.max_autopilot_continues",
    1,
    100,
  );
  const allowTools = readStringArray(record.allow_tools);
  const denyTools = readStringArray(record.deny_tools);
  if (allowTools.length === 0 && denyTools.length === 0) {
    throw new Error(
      "mastermind.execution must configure explicit allow_tools or deny_tools for Copilot",
    );
  }
  const permissionValues = [
    ...allowTools,
    ...denyTools,
    ...readStringArray(record.allow_urls),
    ...readStringArray(record.deny_urls),
  ];
  const prohibited = [
    "--allow-all",
    "--yolo",
    "--allow-all-tools",
    "--allow-all-paths",
    "--allow-all-urls",
  ];
  if (permissionValues.some((value) => prohibited.some((flag) => value.includes(flag)))) {
    throw new Error("mastermind.execution contains a prohibited broad permission flag");
  }
  return {
    executorKind: ExecutorKind.HERDR_COPILOT,
    harnessKind: "copilot",
    harnessCommand: readString(record.harness_command, harnessKind),
    harnessArgs: readStringArray(record.harness_args),
    maxAutopilotContinues,
    allowTools,
    denyTools,
    allowUrls: readStringArray(record.allow_urls),
    denyUrls: readStringArray(record.deny_urls),
    pollIntervalMs: readRequiredBoundedInteger(
      record.poll_interval_ms,
      "mastermind.execution.poll_interval_ms",
      250,
      300_000,
    ),
    unknownStatusThreshold: readRequiredBoundedInteger(
      record.unknown_status_threshold,
      "mastermind.execution.unknown_status_threshold",
      1,
      100,
    ),
    cancellationGraceMs: readRequiredBoundedInteger(
      record.cancellation_grace_ms,
      "mastermind.execution.cancellation_grace_ms",
      100,
      300_000,
    ),
    promptAcceptanceTimeoutMs: readRequiredBoundedInteger(
      record.prompt_acceptance_timeout_ms,
      "mastermind.execution.prompt_acceptance_timeout_ms",
      1_000,
      600_000,
    ),
    maxAttempts,
  };
}

function readMastermindRlmExecutionDefaults(
  value: unknown,
): MastermindRlmExecutionDefaults | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value);
  const executorKind = readString(record.executor_kind, ExecutorKind.RLM_SUBMIND);
  if (executorKind !== ExecutorKind.RLM_SUBMIND) {
    throw new Error(`mastermind.rlm_execution.executor_kind must be ${ExecutorKind.RLM_SUBMIND}`);
  }
  const maxAttempts = readRequiredBoundedInteger(
    record.max_attempts,
    "mastermind.rlm_execution.max_attempts",
    1,
    20,
  );
  return {
    executorKind: ExecutorKind.RLM_SUBMIND,
    // The RLM implementation profile is fixed to "general" per design decision - it is not
    // operator-configurable, unlike the model/depth/budget knobs below.
    profile: "general",
    model: readOptionalString(record.model),
    // Depth has no ceiling: `max_total_calls` is the real bound on runaway recursion, and a deep
    // tree is naturally cut off by that budget long before the depth number matters.
    maxDepth: readRequiredMinimumInteger(record.max_depth, "mastermind.rlm_execution.max_depth", 1),
    maxTotalCalls: readRequiredBoundedInteger(
      record.max_total_calls,
      "mastermind.rlm_execution.max_total_calls",
      1,
      1_000,
    ),
    enableTrellage: readBoolean(record.enable_trellage, true),
    pollIntervalMs: readRequiredBoundedInteger(
      record.poll_interval_ms,
      "mastermind.rlm_execution.poll_interval_ms",
      250,
      300_000,
    ),
    unknownStatusThreshold: readRequiredBoundedInteger(
      record.unknown_status_threshold,
      "mastermind.rlm_execution.unknown_status_threshold",
      1,
      100,
    ),
    cancellationGraceMs: readRequiredBoundedInteger(
      record.cancellation_grace_ms,
      "mastermind.rlm_execution.cancellation_grace_ms",
      100,
      300_000,
    ),
    maxAttempts,
  };
}

function readMastermindSelfImprovementDefaults(
  value: unknown,
): MastermindSelfImprovementDefaults | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value);
  const targetTeamId = readOptionalString(record.target_team_id);
  if (!targetTeamId) {
    throw new Error("mastermind.self_improvement.target_team_id is required.");
  }
  const minSeverity = readOptionalString(record.min_severity) ?? "IMPORTANT";
  if (minSeverity !== "BLOCKING" && minSeverity !== "IMPORTANT" && minSeverity !== "SUGGESTION") {
    throw new Error(
      "mastermind.self_improvement.min_severity must be BLOCKING, IMPORTANT, or SUGGESTION.",
    );
  }
  return {
    enabled: readBoolean(record.enabled, true),
    targetTeamId,
    targetProjectId: readOptionalString(record.target_project_id),
    minSeverity,
    ticketLabelId: readOptionalString(record.ticket_label_id),
  };
}

function readMastermindProjectMappings(value: unknown): MastermindProjectMapping[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const teamId = readOptionalString(record.team_id);
    const projectId = readOptionalString(record.project_id);
    if (!teamId || !projectId) {
      return [];
    }
    return [
      {
        teamId,
        projectId,
        linearProjectId: readOptionalString(record.linear_project_id),
      },
    ];
  });
}

function readToolingDefaults(value: unknown, env: NodeJS.ProcessEnv): ToolingDefaults {
  const record = asRecord(value);
  return {
    skillsDirectory: expandOptionalPath(
      readOptionalString(record.skills_directory) ?? env.WEAVEKIT_SKILLS_DIR?.trim(),
    ),
    agentNativeSkillsInstaller: expandOptionalPath(
      readOptionalString(record.agent_native_skills_installer) ??
        env.WEAVEKIT_AGENT_NATIVE_SKILLS_INSTALLER?.trim(),
    ),
    agentNativeSkillsPackage:
      readOptionalString(record.agent_native_skills_package) ??
      env.WEAVEKIT_AGENT_NATIVE_SKILLS_PACKAGE?.trim(),
    miseBin: expandOptionalPath(
      readOptionalString(record.mise_bin) ?? env.WEAVEKIT_MISE_BIN?.trim(),
    ),
  };
}

function expandOptionalPath(path: string | undefined): string | undefined {
  return path ? expandHomePath(path) : undefined;
}

function readPluginConfigs(value: unknown, env: NodeJS.ProcessEnv): PluginConfigs {
  const plugins = asRecord(value);
  const hveCore = asRecord(plugins[SupportedPluginId.HVE_CORE]);
  const configuredDirectory =
    typeof hveCore.directory === "string" && hveCore.directory.trim()
      ? hveCore.directory
      : undefined;
  return {
    [SupportedPluginId.HVE_CORE]: {
      directory: expandHomePath(
        configuredDirectory ??
          env.WEAVEKIT_HVE_CORE_PLUGIN_DIR?.trim() ??
          defaultPluginDirectory(SupportedPluginId.HVE_CORE),
      ),
    },
  };
}

function readProjectCatalog(value: unknown): Record<string, ProjectCatalogEntry> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).map(([id, raw]) => {
      const record = asRecord(raw);
      const thresholds: Partial<SourceToProjectThresholds> = {};
      if (typeof record.min_applicability === "number")
        thresholds.minApplicability = record.min_applicability;
      if (typeof record.min_confidence === "number")
        thresholds.minConfidence = record.min_confidence;
      if (typeof record.min_impact === "number") thresholds.minImpact = record.min_impact;
      if (typeof record.min_acceptance_average === "number")
        thresholds.minAcceptanceAverage = record.min_acceptance_average;
      if (typeof record.max_risk === "number") thresholds.maxRisk = record.max_risk;
      const budgetGate = readBudgetGateOverride(record.budget_gate, `projects.${id}.budget_gate`);
      const executionPreflightRequirements = readExecutionPreflightRequirements(
        record.execution,
        id,
      );
      const directExecution = readProjectDirectExecutionPolicy(record.execution, id);
      const repositoryMode =
        record.repository_mode === "greenfield"
          ? ProjectRepositoryMode.GREENFIELD
          : ProjectRepositoryMode.EXISTING_REPOSITORY;
      const provisioningRoot = expandOptionalPath(readOptionalString(record.provisioning_root));
      if (repositoryMode === ProjectRepositoryMode.GREENFIELD && !provisioningRoot) {
        throw new Error(`projects.${id}.provisioning_root must be set for greenfield projects`);
      }
      return [
        id,
        {
          id,
          displayName: readString(record.display_name, id),
          workingTree: expandHomePath(readString(record.working_tree, "")),
          repositoryMode,
          ...(provisioningRoot === undefined ? {} : { provisioningRoot }),
          mainline: readString(record.mainline, "origin main"),
          remote: readString(record.remote, "origin"),
          contextDocs: readStringArray(record.context_docs),
          validationCommands: readStringArray(record.validation_commands),
          executionPreflightRequirements,
          ...(directExecution ? { directExecution } : {}),
          autonomousPrAllowed: readBoolean(record.autonomous_pr_allowed, false),
          maxOpportunities:
            typeof record.max_opportunities === "number"
              ? Math.max(0, Math.floor(record.max_opportunities))
              : undefined,
          thresholds,
          ...(budgetGate === undefined ? {} : { budgetGate }),
          notification: readNotificationPolicy(record.notification),
          knowledgeExport: record.knowledge_export === "sanitized" ? "sanitized" : "off",
        },
      ];
    }),
  );
}

function readProjectDirectExecutionPolicy(
  value: unknown,
  projectId: string,
): ProjectDirectExecutionPolicy | undefined {
  const execution = asRecord(value);
  if (!("direct" in execution)) {
    return undefined;
  }
  const direct = asRecord(execution.direct);
  const enabled = readBoolean(direct.enabled, false);
  const configuredExecutorKinds = readStringArray(direct.allowed_executors);
  const validExecutorKinds = new Set<string>(Object.values(ExecutorKind));
  const unknownExecutorKind = configuredExecutorKinds.find((kind) => !validExecutorKinds.has(kind));
  if (unknownExecutorKind) {
    throw new Error(
      `projects.${projectId}.execution.direct.allowed_executors contains unknown executor ${unknownExecutorKind}`,
    );
  }
  const allowedExecutorKinds = configuredExecutorKinds.filter((kind): kind is ExecutorKindValue =>
    validExecutorKinds.has(kind),
  );
  if (enabled && allowedExecutorKinds.length === 0) {
    throw new Error(
      `projects.${projectId}.execution.direct.allowed_executors must include at least one of: ${[
        ...validExecutorKinds,
      ].join(", ")}`,
    );
  }
  return {
    enabled,
    allowedExecutorKinds,
    allowedPullRequestHosts: readStringArray(direct.allowed_pr_hosts).map((host) =>
      host.toLowerCase(),
    ),
  };
}

function readRequiredBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const integer = readOptionalInteger(value);
  if (integer === undefined || integer < minimum || integer > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return integer;
}

function readRequiredMinimumInteger(value: unknown, field: string, minimum: number): number {
  const integer = readOptionalInteger(value);
  if (integer === undefined || integer < minimum) {
    throw new Error(`${field} must be an integer of at least ${minimum}`);
  }
  return integer;
}

function readExecutionPreflightRequirements(
  value: unknown,
  projectId: string,
): ExecutionPreflightRequirement[] {
  const execution = asRecord(value);
  if (!("azure" in execution)) {
    return [];
  }
  const azure = asRecord(execution.azure);
  const subscriptionId = readString(azure.subscription_id, "").trim();
  if (!subscriptionId) {
    throw new Error(
      `projects.${projectId}.execution.azure.subscription_id must be a non-empty string`,
    );
  }
  const tenantId = readString(azure.tenant_id, "").trim();
  return [
    {
      kind: ExecutionPreflightKind.AZURE_CLI,
      subscriptionId,
      ...(tenantId ? { tenantId } : {}),
    },
  ];
}
