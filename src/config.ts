import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

export type SourceToProjectMode = "advisory" | "autonomous-pr";
export type NotificationPolicy = "cli" | "telegram";
export type KnowledgeExportPolicy = "off" | "sanitized";

export type SourceToProjectThresholds = {
  minApplicability: number;
  minConfidence: number;
  minImpact: number;
  minAcceptanceAverage: number;
  maxRisk: number;
};

export type SourceToProjectDefaults = {
  maxOpportunities: number;
  thresholds: SourceToProjectThresholds;
  mode: SourceToProjectMode;
};

export type CopilotDefaults = {
  verboseEvents: boolean;
};

export type ProjectCatalogEntry = {
  id: string;
  displayName: string;
  workingTree: string;
  mainline: string;
  remote: string;
  contextDocs: string[];
  validationCommands: string[];
  autonomousPrAllowed: boolean;
  maxOpportunities?: number;
  thresholds?: Partial<SourceToProjectThresholds>;
  notification: NotificationPolicy;
  knowledgeExport: KnowledgeExportPolicy;
};

export type WeavekitConfig = {
  env: Record<string, string>;
  copilot: CopilotDefaults;
  sourceToProject: SourceToProjectDefaults;
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
      copilot: defaultCopilotDefaults(),
      sourceToProject: defaultSourceToProjectDefaults(),
      projects: {},
    };
  }

  const parsed = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const copilot = readCopilotDefaults(parsed.copilot);
  const sourceToProject = readSourceToProjectDefaults(parsed.source_to_project);
  const projects = readProjectCatalog(parsed.projects);
  return { env: loadedEnv, copilot, sourceToProject, projects };
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
    maxOpportunities: 1,
    thresholds: { minApplicability: 0.7, minConfidence: 0.65, minImpact: 0.5, minAcceptanceAverage: 0.85, maxRisk: 0.8 },
    mode: "advisory",
  };
}

function defaultCopilotDefaults(): CopilotDefaults {
  return {
    verboseEvents: false,
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

function readNotificationPolicy(value: unknown): NotificationPolicy {
  return value === "telegram" ? "telegram" : "cli";
}

function readSourceToProjectDefaults(value: unknown): SourceToProjectDefaults {
  const defaults = defaultSourceToProjectDefaults();
  const record = asRecord(value);
  const mode = record.mode === "autonomous-pr" ? "autonomous-pr" : "advisory";
  return {
    maxOpportunities: Math.max(1, Math.floor(readNumber(record.max_opportunities, defaults.maxOpportunities))),
    mode,
    thresholds: {
      minApplicability: readNumber(record.min_applicability, defaults.thresholds.minApplicability),
      minConfidence: readNumber(record.min_confidence, defaults.thresholds.minConfidence),
      minImpact: readNumber(record.min_impact, defaults.thresholds.minImpact),
      minAcceptanceAverage: readNumber(record.min_acceptance_average, defaults.thresholds.minAcceptanceAverage),
      maxRisk: readNumber(record.max_risk, defaults.thresholds.maxRisk),
    },
  };
}

function readCopilotDefaults(value: unknown): CopilotDefaults {
  const defaults = defaultCopilotDefaults();
  const record = asRecord(value);
  return {
    verboseEvents: readBoolean(record.verbose_events, defaults.verboseEvents),
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
      maxOpportunities: typeof record.max_opportunities === "number" ? Math.max(1, Math.floor(record.max_opportunities)) : undefined,
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
