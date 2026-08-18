import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvFiles, loadWeavekitConfig } from "../config.js";

export type LoadRlmEnvironmentOptions = {
  homeDirectory?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  loadVarlock?: () => Promise<void>;
};

let redactOutput = (value: string): string => value;

export function writeRlmOutput(value: string): void {
  process.stdout.write(redactOutput(value));
}

export async function loadRlmVarlockEnvironment(): Promise<void> {
  const [{ internal, patchGlobalConsole }, { redactSensitiveConfig }] = await Promise.all([
    import("varlock"),
    import("varlock/env"),
  ]);
  const schemaPath = fileURLToPath(new URL(".env.schema", import.meta.url));
  const envGraph = await internal.loadEnvGraph({
    entryFilePaths: [schemaPath],
    overrideValues: process.env,
    processEnvOverride: process.env,
  });
  await envGraph.resolveEnvValues();
  internal.checkForConfigErrors(envGraph);
  const serializedGraph = envGraph.getSerializedGraph();
  const unresolvedKeys = Object.entries(serializedGraph.config)
    .filter(([key, item]) => process.env[key] === undefined && item.value === undefined)
    .map(([key]) => key);
  process.env.__VARLOCK_ENV = JSON.stringify(serializedGraph);
  internal.initVarlockEnv();
  for (const key of unresolvedKeys) {
    delete process.env[key];
  }
  redactOutput = (value) => String(redactSensitiveConfig(value));
  patchGlobalConsole();
}

/**
 * Makes the operator's Weavekit config and legacy home-level environment available to the RLM
 * process before Varlock validates the dedicated RLM schema and installs its redaction hooks.
 */
export async function loadRlmEnvironment(
  options: LoadRlmEnvironmentOptions = {},
): Promise<string[]> {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configPath = options.configPath ?? join(homeDirectory, ".weavekit", "config.toml");
  loadWeavekitConfig(configPath, env);
  const loaded = loadLocalEnvFiles(homeDirectory, env);
  await (options.loadVarlock ?? loadRlmVarlockEnvironment)();
  return Object.keys(loaded);
}
