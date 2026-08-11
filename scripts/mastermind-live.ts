#!/usr/bin/env node
import { loadMastermindRuntimeConfig, loadLocalEnvFiles } from "../src/config.js";
import { applyMastermindLiveEnvironmentDefaults } from "../src/mastermind/liveEnv.js";
import { runMastermindLive } from "../src/mastermind/live.js";
import { langfuseExportConfigured } from "../src/mastermind/telemetry.js";
import { startTelemetry, type TelemetryHandle } from "../src/telemetry/bootstrap.js";

loadLocalEnvFiles();

let telemetry: TelemetryHandle | undefined;
try {
  const config = await loadMastermindRuntimeConfig();
  applyMastermindLiveEnvironmentDefaults(config);
  telemetry = await startTelemetry("weavekit-mastermind");
  if (!langfuseExportConfigured()) {
    process.stdout.write(
      "Langfuse tracing disabled. Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in ~/.weavekit/config.toml.\n",
    );
  }
  await runMastermindLive(config);
} catch (error) {
  process.stderr.write(
    `mastermind:live failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await telemetry?.shutdown();
}
