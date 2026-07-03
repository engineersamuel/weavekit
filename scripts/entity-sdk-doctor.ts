#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadTypedWeavekitConfig, SupportedPluginId, type CopilotDefaults, type PluginConfigs } from "../src/config.js";
import { formatEntityValidationErrors, loadEntityCatalog, validateEntityCatalog, validateSkillReference } from "../src/entities/index.js";
import { materializeWorkflowPlan } from "../src/macro-workflow/templates.js";
import type { WorkflowPluginCommandCapability } from "../src/macro-workflow/types.js";

type SkillListItem = {
  name: string;
  enabled?: boolean;
  path?: string;
};

type PluginListItem = {
  id?: string;
  name?: string;
  enabled?: boolean;
};

type CommandListItem = {
  id?: string;
  name?: string;
  command?: string;
};

type SkillLoadDiagnostics = {
  warnings?: string[];
  errors?: string[];
};

type EntitySdkDoctorSession = {
  rpc?: {
    skills?: {
      ensureLoaded?: () => Promise<unknown>;
      reload?: () => Promise<SkillLoadDiagnostics>;
      list?: () => Promise<{ skills?: SkillListItem[] }>;
      enable?: (args: { name: string }) => Promise<unknown>;
    };
    plugins?: {
      list?: () => Promise<{ plugins?: PluginListItem[] } | PluginListItem[]>;
    };
    commands?: {
      list?: () => Promise<{ commands?: Array<CommandListItem | string> } | Array<CommandListItem | string>>;
    };
  };
  disconnect(): Promise<void>;
};

type EntitySdkDoctorClient = {
  start(): Promise<void>;
  createSession(config: unknown): Promise<EntitySdkDoctorSession>;
  stop(): Promise<Error[] | undefined>;
};

type EntitySdkDoctorClientFactory = () => EntitySdkDoctorClient | Promise<EntitySdkDoctorClient>;

export type EntitySdkDoctorOptions = {
  repoRoot?: string;
  entityId?: string;
  configPath?: string;
  model?: string;
  clientFactory?: EntitySdkDoctorClientFactory;
};

type EntitySkillCheck = {
  entityId: string;
  skillNames: string[];
  skillDirectories: string[];
  disabledSkills: string[];
};

type WorkflowPluginCommandCheck = {
  nodeId: string;
  plugin: SupportedPluginId;
  command: string;
  pluginDirectory: string;
};

function parseArgs(argv: string[]): { entityId?: string; configPath?: string } {
  const entityIndex = argv.indexOf("--entity");
  const configIndex = argv.indexOf("--config");
  const parsed: { entityId?: string; configPath?: string } = {};
  if (entityIndex === -1) {
    // Continue parsing optional config below.
  } else {
    const entityId = argv[entityIndex + 1];
    if (!entityId) {
      throw new Error("Usage: nub scripts/entity-sdk-doctor.ts [--entity <id>] [--config <path>]");
    }
    parsed.entityId = entityId;
  }
  if (configIndex !== -1) {
    const configPath = argv[configIndex + 1];
    if (!configPath) {
      throw new Error("Usage: nub scripts/entity-sdk-doctor.ts [--entity <id>] [--config <path>]");
    }
    parsed.configPath = configPath;
  }
  return parsed;
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
    const entries = readdirSync(virtualStoreDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(storePrefix))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const entry of entries) {
      const candidate = join(virtualStoreDir, entry, "node_modules", ...packageName.split("/"), "index.js");
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

async function createLiveCopilotClient(copilot: CopilotDefaults): Promise<EntitySdkDoctorClient> {
  const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
  const CopilotClientCtor = CopilotClient as unknown as new (options?: unknown) => EntitySdkDoctorClient;
  const runtimeUrl = copilot.runtimeUrl ?? copilot.cliUrl;
  const cliPath = copilot.cliPath ?? resolveCopilotCliPathFromSdkModuleUrl(import.meta.resolve("@github/copilot-sdk"));
  const clientOptions: Record<string, unknown> = {};
  if (runtimeUrl) {
    clientOptions.connection = RuntimeConnection.forUri(runtimeUrl);
  } else if (cliPath) {
    clientOptions.connection = RuntimeConnection.forStdio({ path: cliPath });
  }
  return Object.keys(clientOptions).length > 0 ? new CopilotClientCtor(clientOptions) : new CopilotClientCtor();
}

function discoveryDirectoryForSkillPath(skillPath: string): string {
  return dirname(dirname(skillPath));
}

function siblingSkillDirectories(discoveryDir: string): string[] {
  if (!existsSync(discoveryDir)) {
    return [];
  }
  return readdirSync(discoveryDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function formatDoctorOutput(lines: string[]): string {
  return `${lines.map((line) => `✅ ${line}`).join("\n")}\n`;
}

function collectEntitySkillChecks(options: { repoRoot: string; entityId?: string }): EntitySkillCheck[] {
  const catalog = loadEntityCatalog(options.repoRoot);
  const checks = catalog.entities.flatMap((entity): EntitySkillCheck[] => {
    if (options.entityId && entity.id !== options.entityId) {
      return [];
    }
    if (entity.execution.mode !== "harness_then_baml" || entity.execution.harness !== "copilot-sdk") {
      return [];
    }
    const skillNames = entity.capabilities?.skills ?? [];

    const skillDirectories = skillNames.map((skillName) => {
      const result = validateSkillReference(skillName, options.repoRoot);
      if (!result.valid || !result.skillPath) {
        throw new Error(formatEntityValidationErrors(result.errors));
      }
      return discoveryDirectoryForSkillPath(result.skillPath);
    });
    const uniqueSkillDirectories = unique(skillDirectories);
    const enabledSkillNames = new Set(skillNames);
    const disabledSkills = uniqueSkillDirectories
      .flatMap((directory) => siblingSkillDirectories(directory))
      .filter((skillName) => !enabledSkillNames.has(skillName))
      .sort();

    return [{
      entityId: entity.id,
      skillNames,
      skillDirectories: uniqueSkillDirectories,
      disabledSkills,
    }];
  });

  if (options.entityId && checks.length === 0) {
    throw new Error(`Entity "${options.entityId}" is not a copilot-sdk entity.`);
  }
  return checks;
}

function supportedPluginId(plugin: string): SupportedPluginId {
  if (plugin === SupportedPluginId.HVE_CORE) {
    return SupportedPluginId.HVE_CORE;
  }
  throw new Error(`Unsupported workflow plugin command capability plugin: ${plugin}`);
}

function pluginDirectoryForCommand(args: {
  plugin: SupportedPluginId;
  plugins: PluginConfigs;
}): string {
  const directory = args.plugins[args.plugin]?.directory;
  if (!directory) {
    throw new Error(`No plugin directory configured for ${args.plugin}.`);
  }
  if (!existsSync(directory)) {
    throw new Error(`Configured plugin directory for ${args.plugin} does not exist: ${directory}`);
  }
  return directory;
}

function collectWorkflowPluginCommandChecks(options: {
  plugins: PluginConfigs;
}): WorkflowPluginCommandCheck[] {
  const plan = materializeWorkflowPlan("source-to-project", {
    objective: "Validate source-to-project plugin commands",
    source: "sdk-doctor",
    project: "weavekit",
    mode: "advisory",
  });
  return plan.nodes.flatMap((node) => {
    return (node.capabilities?.pluginCommands ?? []).map((capability: WorkflowPluginCommandCapability) => {
      const plugin = supportedPluginId(capability.plugin);
      return {
        nodeId: node.id,
        plugin,
        command: capability.command,
        pluginDirectory: pluginDirectoryForCommand({ plugin, plugins: options.plugins }),
      };
    });
  });
}

function assertSkillListContainsEnabledSkill(args: {
  entityId: string;
  skillName: string;
  skills: SkillListItem[];
}): void {
  const skill = args.skills.find((candidate) => candidate.name === args.skillName);
  if (!skill) {
    const available = args.skills.map((candidate) => candidate.name).sort().join(", ");
    throw new Error(`Copilot SDK session did not list skill ${args.skillName} for entity ${args.entityId}. Available skills: ${available || "<none>"}.`);
  }
  if (skill.enabled === false) {
    throw new Error(`Copilot SDK session listed skill ${args.skillName} for entity ${args.entityId}, but it is disabled.`);
  }
}

function listResultItems<T>(result: { plugins?: T[]; commands?: T[] } | T[]): T[] {
  if (Array.isArray(result)) {
    return result;
  }
  return result.plugins ?? result.commands ?? [];
}

function commandName(command: CommandListItem | string): string | undefined {
  if (typeof command === "string") {
    return command;
  }
  return command.name ?? command.command ?? command.id;
}

function assertPluginListContainsEnabledPlugin(args: {
  plugin: SupportedPluginId;
  plugins: PluginListItem[];
}): void {
  const plugin = args.plugins.find((candidate) => candidate.id === args.plugin || candidate.name === args.plugin);
  if (!plugin) {
    const available = args.plugins.map((candidate) => candidate.id ?? candidate.name).filter(Boolean).sort().join(", ");
    throw new Error(`Copilot SDK session did not list plugin ${args.plugin}. Available plugins: ${available || "<none>"}.`);
  }
  if (plugin.enabled === false) {
    throw new Error(`Copilot SDK session listed plugin ${args.plugin}, but it is disabled.`);
  }
}

function assertCommandListContainsCommand(args: {
  nodeId: string;
  command: string;
  commands: Array<CommandListItem | string>;
}): void {
  if (args.commands.some((candidate) => commandName(candidate) === args.command)) {
    return;
  }
  const available = args.commands.map(commandName).filter(Boolean).sort().join(", ");
  throw new Error(`Copilot SDK session did not list command ${args.command} for source-to-project/${args.nodeId}. Available commands: ${available || "<none>"}.`);
}

async function verifyEntitySkillsInSession(args: {
  client: EntitySdkDoctorClient;
  check: EntitySkillCheck;
  model?: string;
}): Promise<string[]> {
  if (args.check.skillNames.length === 0) {
    return [`${args.check.entityId}: no capabilities.skills configured`];
  }

  const session = await args.client.createSession({
    ...(args.model ? { model: args.model } : {}),
    skillDirectories: args.check.skillDirectories,
    disabledSkills: args.check.disabledSkills,
  });
  try {
    if (!session.rpc?.skills?.ensureLoaded || !session.rpc.skills.list) {
      throw new Error("Copilot SDK session does not expose rpc.skills.ensureLoaded/list.");
    }
    await session.rpc.skills.ensureLoaded();
    const diagnostics = await session.rpc.skills.reload?.();
    if (diagnostics?.errors?.length) {
      throw new Error(`Copilot SDK skill reload failed for ${args.check.entityId}: ${diagnostics.errors.join("; ")}`);
    }
    const listed = await session.rpc.skills.list();
    const skills = listed.skills ?? [];
    for (const skillName of args.check.skillNames) {
      await session.rpc.skills.enable?.({ name: skillName });
      assertSkillListContainsEnabledSkill({ entityId: args.check.entityId, skillName, skills });
    }
    return args.check.skillNames.map((skillName) => `${args.check.entityId}: skill ${skillName} loaded`);
  } finally {
    await session.disconnect();
  }
}

async function verifyWorkflowPluginCommandsInSession(args: {
  client: EntitySdkDoctorClient;
  checks: WorkflowPluginCommandCheck[];
  model?: string;
}): Promise<string[]> {
  if (args.checks.length === 0) {
    return [];
  }
  const pluginDirectories = unique(args.checks.map((check) => check.pluginDirectory));
  const session = await args.client.createSession({
    ...(args.model ? { model: args.model } : {}),
    pluginDirectories,
  });
  try {
    if (!session.rpc?.plugins?.list || !session.rpc?.commands?.list) {
      throw new Error("Copilot SDK session does not expose rpc.plugins.list/rpc.commands.list.");
    }
    const listedPlugins = listResultItems(await session.rpc.plugins.list());
    const listedCommands = listResultItems(await session.rpc.commands.list());
    const plugins = unique(args.checks.map((check) => check.plugin)) as SupportedPluginId[];
    for (const plugin of plugins) {
      assertPluginListContainsEnabledPlugin({ plugin, plugins: listedPlugins });
    }
    for (const check of args.checks) {
      assertCommandListContainsCommand({
        nodeId: check.nodeId,
        command: check.command,
        commands: listedCommands,
      });
    }
    return args.checks.map((check) =>
      `source-to-project/${check.nodeId}: plugin command ${check.command} discovered`
    );
  } finally {
    await session.disconnect();
  }
}

export async function runEntitySdkDoctor(options: EntitySdkDoctorOptions = {}): Promise<string> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const config = loadTypedWeavekitConfig(options.configPath);
  const staticValidation = validateEntityCatalog(repoRoot);
  if (!staticValidation.valid) {
    throw new Error(formatEntityValidationErrors(staticValidation.errors));
  }

  const checks = collectEntitySkillChecks({ repoRoot, entityId: options.entityId });
  const workflowPluginChecks = options.entityId
    ? []
    : collectWorkflowPluginCommandChecks({ plugins: config.plugins });
  if (checks.length === 0 && workflowPluginChecks.length === 0) {
    return formatDoctorOutput(["No copilot-sdk entities configured."]);
  }

  const lines: string[] = [];
  const skillChecks = checks.filter((check) => check.skillNames.length > 0);
  lines.push(...checks
    .filter((check) => check.skillNames.length === 0)
    .map((check) => `${check.entityId}: no capabilities.skills configured`));
  if (skillChecks.length === 0 && workflowPluginChecks.length === 0) {
    return formatDoctorOutput(checks.map((check) => `${check.entityId}: no capabilities.skills configured`));
  }

  const client = await (options.clientFactory ? options.clientFactory() : createLiveCopilotClient(config.copilot));
  const model = options.model ?? config.copilot.sdkDoctorModel;
  await client.start();
  try {
    for (const check of skillChecks) {
      lines.push(...await verifyEntitySkillsInSession({
        client,
        check,
        model,
      }));
    }
    lines.push(...await verifyWorkflowPluginCommandsInSession({
      client,
      checks: workflowPluginChecks,
      model,
    }));
  } finally {
    const stopErrors = await client.stop();
    if (stopErrors?.length) {
      throw stopErrors[0];
    }
  }

  return formatDoctorOutput(lines);
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  runEntitySdkDoctor(parseArgs(process.argv.slice(2)))
    .then((output) => {
      process.stdout.write(output);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
