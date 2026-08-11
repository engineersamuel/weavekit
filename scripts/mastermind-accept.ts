#!/usr/bin/env node
import { loadLocalEnvFiles, loadMastermindRuntimeConfig } from "../src/config.js";
import {
  acceptMastermindWork,
  LinearGraphQlGateway,
  SqliteMastermindStore,
} from "../src/mastermind/index.js";
import { LinearSetupClient } from "../src/mastermind/live.js";

loadLocalEnvFiles();

let store: SqliteMastermindStore | undefined;
try {
  const selector = process.argv[2] ?? "";
  const config = await loadMastermindRuntimeConfig();
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) throw new Error("Mastermind acceptance requires LINEAR_API_KEY.");
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
  store = new SqliteMastermindStore(config.mastermind.sqlitePath);
  await store.initialize();
  const work = await acceptMastermindWork({
    selector,
    config,
    store,
    linear: new LinearGraphQlGateway(apiKey),
  });
  process.stdout.write(`Mastermind work accepted: work=${work.id} state=${work.state}\n`);
} catch (error) {
  process.stderr.write(
    `mastermind:accept failed: ${error instanceof Error ? error.message : String(error)}\n`,
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
