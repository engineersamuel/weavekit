import type { WeavekitConfig } from "../config.js";

export const DEFAULT_MASTERMIND_LIVE_PROXY_BASE_URL = "http://127.0.0.1:8080/v1";
export const DEFAULT_MASTERMIND_LIVE_PROXY_API_KEY = "anything";
export const DEFAULT_MASTERMIND_LIVE_BAML_MODEL = "gpt-5.5";
export const DEFAULT_MASTERMIND_LIVE_SERVICE_NAME = "weavekit-mastermind";

export function applyMastermindLiveEnvironmentDefaults(
  _config: Pick<WeavekitConfig, "mastermind">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.COPILOT_PROXY_BASE_URL ??= DEFAULT_MASTERMIND_LIVE_PROXY_BASE_URL;
  env.COPILOT_PROXY_API_KEY ??= DEFAULT_MASTERMIND_LIVE_PROXY_API_KEY;
  env.BAML_MODEL ??= DEFAULT_MASTERMIND_LIVE_BAML_MODEL;
  env.OTEL_SERVICE_NAME ??= DEFAULT_MASTERMIND_LIVE_SERVICE_NAME;
}
