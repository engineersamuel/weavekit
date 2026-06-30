import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

export function getDefaultWeavekitConfigPath(): string {
  return join(homedir(), ".weavekit", "config.toml");
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
