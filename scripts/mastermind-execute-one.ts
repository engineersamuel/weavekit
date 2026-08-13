#!/usr/bin/env node
import { loadLocalEnvFiles, loadMastermindRuntimeConfig } from "../src/config.js";
import { applyMastermindLiveEnvironmentDefaults } from "../src/mastermind/liveEnv.js";
import { LinearSetupClient } from "../src/mastermind/live.js";
import {
  createMastermindExecutionCoordinator,
  executeOneReadyWork,
  LinearGraphQlGateway,
  SqliteMastermindStore,
  validateMastermindExecutionRuntimeConfig,
} from "../src/mastermind/index.js";
import { langfuseExportConfigured } from "../src/mastermind/telemetry.js";
import { startTelemetry, type TelemetryHandle } from "../src/telemetry/bootstrap.js";

loadLocalEnvFiles();

let telemetry: TelemetryHandle | undefined;
let store: SqliteMastermindStore | undefined;
try {
  const config = await loadMastermindRuntimeConfig();
  applyMastermindLiveEnvironmentDefaults(config);
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Mastermind execution configuration missing: LINEAR_API_KEY");
  }
  const setup = await new LinearSetupClient(apiKey).getSetup();
  config.mastermind.readyLabelId = resolveLabelId(setup.labels, config.mastermind.readyLabelName);
  config.mastermind.needsInputLabelId = resolveLabelId(
    setup.labels,
    config.mastermind.needsInputLabelName,
  );
  config.mastermind.reviewFailedLabelId = resolveLabelId(
    setup.labels,
    config.mastermind.reviewFailedLabelName,
  );
  config.mastermind.codeReviewLabelId = resolveLabelId(
    setup.labels,
    config.mastermind.codeReviewLabelName ?? "mastermind-code-review",
  );
  config.mastermind.codeReviewPassedLabelId = resolveLabelId(
    setup.labels,
    config.mastermind.codeReviewPassedLabelName ?? "mastermind-code-review-passed",
  );
  config.mastermind.changesRequestedLabelId = resolveLabelId(
    setup.labels,
    config.mastermind.changesRequestedLabelName ?? "mastermind-changes-requested",
  );
  validateMastermindExecutionRuntimeConfig(config.mastermind, process.env);
  telemetry = await startTelemetry("weavekit-mastermind");
  if (!langfuseExportConfigured()) {
    process.stdout.write(
      "Langfuse tracing disabled. Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in ~/.weavekit/config.toml.\n",
    );
  }

  store = new SqliteMastermindStore(config.mastermind.sqlitePath);
  await store.initialize();
  const linear = new LinearGraphQlGateway(process.env.LINEAR_API_KEY!);
  const coordinator = createMastermindExecutionCoordinator(config, store, linear);
  if (!coordinator) {
    throw new Error("Mastermind direct execution is not configured.");
  }
  const result = await executeOneReadyWork({
    store,
    coordinator,
    postImplementationReviewEnabled: true,
    pollIntervalMs:
      config.mastermind.execution?.pollIntervalMs ??
      config.mastermind.rlmExecution?.pollIntervalMs ??
      config.mastermind.reconcileIntervalMs,
    onProgress: ({ work, attempt }) => {
      process.stdout.write(
        `[mastermind] work=${work.id} attempt=${attempt?.attemptNumber ?? "-"} state=${work.state}\n`,
      );
    },
  });

  if (result.disposition === "no-work") {
    process.stdout.write("No ready or recoverable Mastermind execution work found.\n");
  } else {
    process.stdout.write(
      `Mastermind execution finished: work=${result.work.id} attempt=${result.attempt.attemptNumber} outcome=${result.work.state}\n`,
    );
  }
} catch (error) {
  process.stderr.write(
    `mastermind:execute-one failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  store?.close();
  await telemetry?.shutdown();
}

function resolveLabelId(
  labels: Array<{ id: string; name: string }>,
  configuredName: string,
): string {
  const label = labels.find(
    (candidate) => candidate.name.toLocaleLowerCase() === configuredName.toLocaleLowerCase(),
  );
  if (!label) {
    throw new Error(
      `Linear label ${configuredName} does not exist. Run mastermind:live once to create it.`,
    );
  }
  return label.id;
}
