import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

export type SourceToProjectMode = "advisory" | "autonomous-pr";
export type VerificationOptimizerMode = "advisory" | "autonomous-pr";
export type NotificationPolicy = "cli" | "telegram";
export type KnowledgeExportPolicy = "off" | "sanitized";

export type SourceToProjectThresholds = {
  minApplicability: number;
  minConfidence: number;
  minImpact: number;
  minAcceptanceAverage: number;
  maxRisk: number;
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
  prLauncher: SourceToProjectPrLauncherConfig;
  /**
   * When true, automatically create a Herdr worktree and start the configured agent to
   * implement an accepted opportunity as soon as its report node passes, instead of waiting
   * for a manual "Create PR" click. Still gated per-project by `autonomousPrAllowed`.
   */
  autoImplementOnReport: boolean;
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

export type ToolingDefaults = {
  skillsDirectory?: string;
  agentNativeSkillsInstaller?: string;
  agentNativeSkillsPackage?: string;
  miseBin?: string;
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
  mainline: string;
  remote: string;
  contextDocs: string[];
  validationCommands: string[];
  autonomousPrAllowed: boolean;
  /** Cap on accepted opportunities promoted per run. 0 or undefined means unlimited (falls back to the global default, which also defaults to unlimited). */
  maxOpportunities?: number;
  thresholds?: Partial<SourceToProjectThresholds>;
  notification: NotificationPolicy;
  knowledgeExport: KnowledgeExportPolicy;
};

export type WeavekitConfig = {
  env: Record<string, string>;
  copilot: CopilotDefaults;
  flue: FlueDefaults;
  tooling: ToolingDefaults;
  sourceToProject: SourceToProjectDefaults;
  deepResearch: DeepResearchDefaults;
  verificationOptimizer: VerificationOptimizerDefaults;
  plugins: PluginConfigs;
  projects: Record<string, ProjectCatalogEntry>;
};

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

export function loadLocalEnvFiles(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    ...loadEnvFile(join(cwd, ".env"), env, parseDotEnvLine),
    ...loadEnvFile(join(cwd, ".env.fish"), env, parseFishEnvLine),
  };
}

export function loadWeavekitConfig(configPath = getDefaultWeavekitConfigPath(), env: NodeJS.ProcessEnv = process.env): Record<string, string> {
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
  const flagIndex = tokens.findIndex((token) => token === "-gx" || token === "-x" || token === "--global" || token === "--export");
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
  let quote: "'" | "\"" | undefined;
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
    if (char === "'" || char === "\"") {
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
    (withoutComment.startsWith("\"") && withoutComment.endsWith("\"")) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
}

export function loadTypedWeavekitConfig(configPath = getDefaultWeavekitConfigPath(), env: NodeJS.ProcessEnv = process.env): WeavekitConfig {
  const loadedEnv = loadWeavekitConfig(configPath, env);
  if (!existsSync(configPath)) {
    return {
      env: loadedEnv,
      copilot: readCopilotDefaults(undefined, env),
      flue: readFlueDefaults(undefined, env),
      tooling: readToolingDefaults(undefined, env),
      sourceToProject: readSourceToProjectDefaults(undefined, env),
      deepResearch: readDeepResearchDefaults(undefined, env),
      verificationOptimizer: readVerificationOptimizerDefaults(undefined),
      plugins: readPluginConfigs(undefined, env),
      projects: {},
    };
  }

  const parsed = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const copilot = readCopilotDefaults(parsed.copilot, env);
  const flue = readFlueDefaults(parsed.flue, env);
  const tooling = readToolingDefaults(parsed.tooling, env);
  const sourceToProject = readSourceToProjectDefaults(parsed.source_to_project, env);
  const deepResearch = readDeepResearchDefaults(parsed.deep_research, env);
  const verificationOptimizer = readVerificationOptimizerDefaults(parsed.verification_optimizer);
  const plugins = readPluginConfigs(parsed.plugins, env);
  const projects = readProjectCatalog(parsed.projects);
  return { env: loadedEnv, copilot, flue, tooling, sourceToProject, deepResearch, verificationOptimizer, plugins, projects };
}

export function resolveProjectCatalogEntry(config: WeavekitConfig, projectId: string): ProjectCatalogEntry {
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project id: ${projectId}`);
  }
  return project;
}

function defaultSourceToProjectDefaults(): SourceToProjectDefaults {
  return {
    maxOpportunities: 0,
    thresholds: { minApplicability: 0.7, minConfidence: 0.65, minImpact: 0.5, minAcceptanceAverage: 0.85, maxRisk: 0.8 },
    mode: "advisory",
    offline: false,
    prLauncher: {
      provider: "herdr",
      agentCommand: "codex",
      agentArgs: ["--dangerously-bypass-approvals-and-sandbox"],
      split: "right",
      agentOptions: [
        { id: "codex", label: "Codex", agentCommand: "codex", agentArgs: ["--dangerously-bypass-approvals-and-sandbox"] },
        { id: "copilot", label: "Copilot", agentCommand: "copilot", agentArgs: ["--allow-all"] },
      ],
    },
    autoImplementOnReport: false,
  };
}

function defaultDeepResearchDefaults(): DeepResearchDefaults {
  return {
    providers: [DeepResearchProvider.GROK, DeepResearchProvider.EXA, DeepResearchProvider.COPILOT_LAST30DAYS],
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
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
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
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function readNotificationPolicy(value: unknown): NotificationPolicy {
  return value === "telegram" ? "telegram" : "cli";
}

function readSourceToProjectDefaults(value: unknown, env: NodeJS.ProcessEnv): SourceToProjectDefaults {
  const defaults = defaultSourceToProjectDefaults();
  const record = asRecord(value);
  const mode = record.mode === "autonomous-pr" ? "autonomous-pr" : "advisory";
  return {
    maxOpportunities: Math.max(0, Math.floor(readNumber(record.max_opportunities, defaults.maxOpportunities))),
    mode,
    offline: readBoolean(record.offline, readEnvBoolean(env, "WEAVEKIT_SOURCE_TO_PROJECT_OFFLINE") ?? defaults.offline),
    copilotModel: (readOptionalString(record.copilot_model) ?? env.WEAVEKIT_SOURCE_TO_PROJECT_MODEL?.trim()) || undefined,
    timeoutMs: readOptionalInteger(record.timeout_ms) ?? readEnvPositiveInteger(env, "WEAVEKIT_SOURCE_TO_PROJECT_TIMEOUT_MS"),
    maxToolCalls: readOptionalInteger(record.max_tool_calls) ?? readEnvPositiveInteger(env, "WEAVEKIT_SOURCE_TO_PROJECT_MAX_TOOL_CALLS"),
    sourceReadingMaxToolCalls: readOptionalInteger(record.source_reading_max_tool_calls) ?? readEnvPositiveInteger(env, "WEAVEKIT_SOURCE_READING_MAX_TOOL_CALLS"),
    projectResearchMaxToolCalls: readOptionalInteger(record.project_research_max_tool_calls) ?? readEnvPositiveInteger(env, "WEAVEKIT_PROJECT_RESEARCH_MAX_TOOL_CALLS"),
    prLauncher: readSourceToProjectPrLauncherConfig(record.pr_launcher, defaults.prLauncher),
    autoImplementOnReport: readBoolean(
      record.auto_implement_on_report,
      readEnvBoolean(env, "WEAVEKIT_SOURCE_TO_PROJECT_AUTO_IMPLEMENT_ON_REPORT") ?? defaults.autoImplementOnReport,
    ),
    thresholds: {
      minApplicability: readNumber(record.min_applicability, defaults.thresholds.minApplicability),
      minConfidence: readNumber(record.min_confidence, defaults.thresholds.minConfidence),
      minImpact: readNumber(record.min_impact, defaults.thresholds.minImpact),
      minAcceptanceAverage: readNumber(record.min_acceptance_average, defaults.thresholds.minAcceptanceAverage),
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
    maxIterations: readOptionalInteger(record.max_iterations) ?? readEnvPositiveInteger(env, "WEAVEKIT_DEEP_RESEARCH_MAX_ITERATIONS") ?? defaults.maxIterations,
    questionsPerIteration: readOptionalInteger(record.questions_per_iteration) ?? readEnvPositiveInteger(env, "WEAVEKIT_DEEP_RESEARCH_QUESTIONS_PER_ITERATION") ?? defaults.questionsPerIteration,
    maxResultsPerQuestion: readOptionalInteger(record.max_results_per_question) ?? readEnvPositiveInteger(env, "WEAVEKIT_DEEP_RESEARCH_MAX_RESULTS_PER_QUESTION") ?? defaults.maxResultsPerQuestion,
    providerRetryAttempts: readOptionalInteger(record.provider_retry_attempts) ?? readEnvPositiveInteger(env, "WEAVEKIT_DEEP_RESEARCH_PROVIDER_RETRY_ATTEMPTS") ?? defaults.providerRetryAttempts,
    visualize: readBoolean(record.visualize, readEnvBoolean(env, "WEAVEKIT_DEEP_RESEARCH_VISUALIZE") ?? defaults.visualize),
  };
}

function readDeepResearchProviders(value: string[] | undefined, fallback: DeepResearchProvider[]): DeepResearchProvider[] {
  const providers = (value ?? []).flatMap((provider) => normalizeDeepResearchProvider(provider) ?? []);
  return providers.length > 0 ? uniqueDeepResearchProviders(providers) : fallback;
}

function normalizeDeepResearchProvider(provider: string): DeepResearchProvider | undefined {
  const normalized = provider.trim().toLowerCase();
  if (normalized === DeepResearchProvider.EXA) return DeepResearchProvider.EXA;
  if (normalized === DeepResearchProvider.GROK) return DeepResearchProvider.GROK;
  if (normalized === DeepResearchProvider.TAVILY) return DeepResearchProvider.TAVILY;
  if (normalized === DeepResearchProvider.PERPLEXITY) return DeepResearchProvider.PERPLEXITY;
  if (normalized === DeepResearchProvider.COPILOT_LAST30DAYS) return DeepResearchProvider.COPILOT_LAST30DAYS;
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
      maxImplementationCost: readNumber(record.max_implementation_cost, defaults.thresholds.maxImplementationCost),
      minEvidenceReferences: Math.max(0, Math.floor(readNumber(record.min_evidence_references, defaults.thresholds.minEvidenceReferences))),
      requireNonSpeculative: readBoolean(record.require_non_speculative, defaults.thresholds.requireNonSpeculative),
      requireProofCommands: readBoolean(record.require_proof_commands, defaults.thresholds.requireProofCommands),
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
    agentArgs: Array.isArray(record.agent_args) ? readStringArray(record.agent_args) : defaults.agentArgs,
    split: record.split === "down" ? "down" : "right",
    agentOptions: readSourceToProjectPrLauncherAgentOptions(record.agent_options, defaults.agentOptions),
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

function readCopilotDefaults(value: unknown, env: NodeJS.ProcessEnv = process.env): CopilotDefaults {
  const defaults = defaultCopilotDefaults();
  const record = asRecord(value);
  return {
    verboseEvents: readBoolean(record.verbose_events, readEnvBoolean(env, "WEAVEKIT_COPILOT_VERBOSE_EVENTS") ?? defaults.verboseEvents),
    model: (readOptionalString(record.model) ?? env.COPILOT_MODEL?.trim()) || undefined,
    runtimeUrl: (readOptionalString(record.runtime_url) ?? env.COPILOT_RUNTIME_URL?.trim()) || undefined,
    cliUrl: (readOptionalString(record.cli_url) ?? env.COPILOT_CLI_URL?.trim()) || undefined,
    cliPath: expandOptionalPath(readOptionalString(record.cli_path) ?? env.COPILOT_CLI_PATH?.trim()),
    sdkDoctorModel: (readOptionalString(record.sdk_doctor_model) ?? env.WEAVEKIT_ENTITY_SDK_DOCTOR_MODEL?.trim()) || undefined,
  };
}

function readFlueDefaults(value: unknown, env: NodeJS.ProcessEnv): FlueDefaults {
  const defaults = defaultFlueDefaults();
  const record = asRecord(value);
  return {
    model: readOptionalString(record.model) ?? env.WEAVEKIT_FLUE_MODEL?.trim() ?? defaults.model,
  };
}

function readToolingDefaults(value: unknown, env: NodeJS.ProcessEnv): ToolingDefaults {
  const record = asRecord(value);
  return {
    skillsDirectory: expandOptionalPath(readOptionalString(record.skills_directory) ?? env.WEAVEKIT_SKILLS_DIR?.trim()),
    agentNativeSkillsInstaller: expandOptionalPath(readOptionalString(record.agent_native_skills_installer) ?? env.WEAVEKIT_AGENT_NATIVE_SKILLS_INSTALLER?.trim()),
    agentNativeSkillsPackage: readOptionalString(record.agent_native_skills_package) ?? env.WEAVEKIT_AGENT_NATIVE_SKILLS_PACKAGE?.trim(),
    miseBin: expandOptionalPath(readOptionalString(record.mise_bin) ?? env.WEAVEKIT_MISE_BIN?.trim()),
  };
}

function expandOptionalPath(path: string | undefined): string | undefined {
  return path ? expandHomePath(path) : undefined;
}

function readPluginConfigs(value: unknown, env: NodeJS.ProcessEnv): PluginConfigs {
  const plugins = asRecord(value);
  const hveCore = asRecord(plugins[SupportedPluginId.HVE_CORE]);
  const configuredDirectory = typeof hveCore.directory === "string" && hveCore.directory.trim()
    ? hveCore.directory
    : undefined;
  return {
    [SupportedPluginId.HVE_CORE]: {
      directory: expandHomePath(
        configuredDirectory
          ?? env.WEAVEKIT_HVE_CORE_PLUGIN_DIR?.trim()
          ?? defaultPluginDirectory(SupportedPluginId.HVE_CORE),
      ),
    },
  };
}

function readProjectCatalog(value: unknown): Record<string, ProjectCatalogEntry> {
  return Object.fromEntries(Object.entries(asRecord(value)).map(([id, raw]) => {
    const record = asRecord(raw);
    return [id, {
      id,
      displayName: readString(record.display_name, id),
      workingTree: expandHomePath(readString(record.working_tree, "")),
      mainline: readString(record.mainline, "origin main"),
      remote: readString(record.remote, "origin"),
      contextDocs: readStringArray(record.context_docs),
      validationCommands: readStringArray(record.validation_commands),
      autonomousPrAllowed: readBoolean(record.autonomous_pr_allowed, false),
      maxOpportunities: typeof record.max_opportunities === "number" ? Math.max(0, Math.floor(record.max_opportunities)) : undefined,
      thresholds: {
        minApplicability: typeof record.min_applicability === "number" ? record.min_applicability : undefined,
        minConfidence: typeof record.min_confidence === "number" ? record.min_confidence : undefined,
        minImpact: typeof record.min_impact === "number" ? record.min_impact : undefined,
        minAcceptanceAverage: typeof record.min_acceptance_average === "number" ? record.min_acceptance_average : undefined,
        maxRisk: typeof record.max_risk === "number" ? record.max_risk : undefined,
      },
      notification: readNotificationPolicy(record.notification),
      knowledgeExport: record.knowledge_export === "sanitized" ? "sanitized" : "off",
    }];
  }));
}
