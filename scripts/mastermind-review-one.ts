#!/usr/bin/env node
import { loadLocalEnvFiles, loadMastermindRuntimeConfig } from "../src/config.js";
import { MastermindState } from "../src/mastermind/domain/events.js";
import { applyMastermindLiveEnvironmentDefaults } from "../src/mastermind/liveEnv.js";
import { LinearSetupClient } from "../src/mastermind/live.js";
import {
  createMastermindExecutionCoordinator,
  executeOneReadyWork,
  LinearGraphQlGateway,
  SqliteMastermindStore,
  validateMastermindExecutionRuntimeConfig,
} from "../src/mastermind/index.js";

loadLocalEnvFiles();

let store: SqliteMastermindStore | undefined;
try {
  const selector = process.argv[2]?.trim() ?? "";
  if (!selector) {
    throw new Error(
      "Usage: mise run mastermind:review-one <ticket-identifier|work-id|issue-id|attempt-id>",
    );
  }
  const config = await loadMastermindRuntimeConfig();
  applyMastermindLiveEnvironmentDefaults(config);
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) throw new Error("Mastermind code review requires LINEAR_API_KEY.");
  const setup = await new LinearSetupClient(apiKey).getSetup();
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
  store = new SqliteMastermindStore(config.mastermind.sqlitePath);
  await store.initialize();
  const target = await store.findExecutionAttachment(selector);
  if (!target) throw new Error(`No Mastermind execution found for: ${selector}`);
  const work = await store.getWork(target.workId);
  if (
    !work ||
    (work.state !== MastermindState.SUCCEEDED &&
      work.state !== MastermindState.CODE_REVIEW_PENDING &&
      work.state !== MastermindState.CODE_REVIEWING)
  ) {
    throw new Error(`Mastermind work ${target.workId} is not ready for post-code review.`);
  }
  const linear = new LinearGraphQlGateway(apiKey);
  const coordinator = createMastermindExecutionCoordinator(config, store, linear);
  if (!coordinator) throw new Error("Mastermind direct execution is not configured.");
  const result = await executeOneReadyWork({
    store,
    coordinator,
    workId: target.workId,
    postImplementationReviewEnabled: true,
    pollIntervalMs:
      config.mastermind.execution?.pollIntervalMs ?? config.mastermind.reconcileIntervalMs,
    onProgress: ({ work: current, attempt }) => {
      process.stdout.write(
        `[mastermind] work=${current.id} attempt=${attempt?.attemptNumber ?? "-"} state=${current.state}\n`,
      );
    },
  });
  if (result.disposition === "completed") {
    process.stdout.write(
      `Mastermind code review finished: work=${result.work.id} state=${result.work.state}\n`,
    );
  }
} catch (error) {
  process.stderr.write(
    `mastermind:review-one failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  store?.close();
}

function resolveLabelId(
  labels: Array<{ id: string; name: string }>,
  configuredName: string,
): string {
  const label = labels.find(
    (candidate) => candidate.name.toLocaleLowerCase() === configuredName.toLocaleLowerCase(),
  );
  if (!label) throw new Error(`Linear label ${configuredName} does not exist.`);
  return label.id;
}
