#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { loadLocalEnvFiles, loadMastermindRuntimeConfig } from "../src/config.js";
import { applyMastermindLiveEnvironmentDefaults } from "../src/mastermind/liveEnv.js";
import { LinearSetupClient, type LinearSetupIssue } from "../src/mastermind/live.js";
import { GeneratedMastermindDecisionProvider } from "../src/mastermind/decision/bamlAdapters.js";
import { MastermindDecisionLoop } from "../src/mastermind/decision/loop.js";
import { createTicketReviewHarness } from "../src/mastermind/review/harness.js";
import {
  createMastermindExecutionCoordinator,
  executeOneReadyWork,
  LinearGraphQlGateway,
  SqliteMastermindStore,
} from "../src/mastermind/index.js";
import { langfuseExportConfigured, traceMastermindWork } from "../src/mastermind/telemetry.js";
import { startTelemetry, type TelemetryHandle } from "../src/telemetry/bootstrap.js";

loadLocalEnvFiles();

const EXIT_NO_WORK = Symbol("mastermind-no-work");

let telemetry: TelemetryHandle | undefined;
let store: SqliteMastermindStore | undefined;
try {
  const requestedTicket = process.argv[2]?.trim();
  const config = await loadMastermindRuntimeConfig();
  applyMastermindLiveEnvironmentDefaults(config);
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "LINEAR_API_KEY is required. Add an admin-capable personal API key as the root LINEAR_API_KEY value in ~/.weavekit/config.toml.",
    );
  }
  if (config.mastermind.projectMappings.length === 0) {
    throw new Error(
      "mastermind.project_mappings is empty. Configure at least one Linear team -> project mapping before running mastermind.",
    );
  }

  const linearSetup = new LinearSetupClient(apiKey);
  const setup = await linearSetup.getSetup();
  config.mastermind.reviewedLabelId = resolveLabelId(
    setup.labels,
    config.mastermind.reviewedLabelName,
  );
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

  const issue = requestedTicket
    ? await findIssueByIdentifier(linearSetup, config.mastermind.projectMappings, requestedTicket)
    : await findMostRecentUnreviewedIssue(
        linearSetup,
        config.mastermind.projectMappings,
        config.mastermind.reviewedLabelId,
      );
  if (!issue) {
    process.stdout.write(
      requestedTicket
        ? `No Linear ticket matching "${requestedTicket}" was found on a mapped team.\n`
        : "No unreviewed Linear ticket was found on a mapped team.\n",
    );
    process.exitCode = 0;
    throw EXIT_NO_WORK;
  }
  if (!issue.projectId) {
    throw new Error(
      `Linear issue ${issue.identifier} has no project. Add it to a project and rerun.`,
    );
  }

  telemetry = await startTelemetry("weavekit-mastermind");
  if (!langfuseExportConfigured()) {
    process.stdout.write(
      "Langfuse tracing disabled. Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in ~/.weavekit/config.toml.\n",
    );
  }

  store = new SqliteMastermindStore(config.mastermind.sqlitePath);
  await store.initialize();
  const linear = new LinearGraphQlGateway(apiKey);

  process.stdout.write(`Reviewing ${issue.identifier}: ${issue.title}\n`);
  const { workId } = await store.ingestDelivery({
    deliveryId: randomUUID(),
    organizationId: setup.organization.id,
    eventType: "Issue",
    action: "mastermind-cli",
    issueId: issue.id,
  });

  const decisions = new GeneratedMastermindDecisionProvider(undefined, {
    synthesisModel: config.mastermind.synthesisModel,
  });
  const reviewHarness = createTicketReviewHarness(config);
  const loop = new MastermindDecisionLoop(
    config,
    store,
    linear,
    decisions,
    reviewHarness,
    (message) => {
      process.stdout.write(
        `${message
          .split("\n")
          .map((line) => `[mastermind] ${line}`)
          .join("\n")}\n`,
      );
    },
  );
  await loop.process(workId);

  const reviewed = await store.getWork(workId);
  if (!reviewed) {
    throw new Error(`Mastermind work item disappeared during review: ${workId}`);
  }
  process.stdout.write(
    `Review finished: work=${reviewed.id} state=${reviewed.state} plannedAction=${reviewed.plannedAction ?? "-"}\n`,
  );

  const coordinator = createMastermindExecutionCoordinator(config, store, linear, (message) => {
    process.stdout.write(`[mastermind] execution ${message}\n`);
  });
  if (!coordinator) {
    process.stdout.write(
      "Mastermind direct execution is not configured (set [mastermind.execution] and/or [mastermind.rlm_execution]); stopping after review.\n",
    );
  } else {
    // The poll loop calls coordinator.process() once per interval, and each call opens a span.
    // Without an active parent every one of those becomes its own root span, i.e. a separate
    // Langfuse trace (47 single-span traces were observed in one 20-minute run). Opening one root
    // trace around the whole loop nests them under a single execution trace instead.
    // Captured before the callback: control-flow narrowing of the outer `let store` is discarded
    // inside a closure.
    const executionStore = store;
    const result = await traceMastermindWork(
      workId,
      (traceInfo) => {
        process.stdout.write(
          `[mastermind] execution Langfuse trace: ${traceInfo.url ?? traceInfo.traceId}\n`,
        );
      },
      async (span) => {
        span.setAttribute("langfuse.trace.name", "mastermind-execution");
        return executeOneReadyWork({
          store: executionStore,
          coordinator,
          workId,
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
      },
    );
    if (result.disposition === "no-work") {
      process.stdout.write(
        "Ticket did not resolve to a launchable execution (needs human, ignored, or execution not opted in for this project).\n",
      );
    } else {
      process.stdout.write(
        `Mastermind execution finished: work=${result.work.id} attempt=${result.attempt.attemptNumber} outcome=${result.work.state}\n`,
      );
    }
  }
} catch (error) {
  if (error !== EXIT_NO_WORK) {
    process.stderr.write(
      `mastermind failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
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

async function findIssueByIdentifier(
  linearSetup: LinearSetupClient,
  projectMappings: Array<{ teamId: string }>,
  identifier: string,
): Promise<LinearSetupIssue | undefined> {
  const requested = identifier.toLocaleLowerCase();
  for (const mapping of projectMappings) {
    const issues = await linearSetup.listIssues(mapping.teamId);
    const match = issues.find(
      (issue) =>
        issue.id.toLocaleLowerCase() === requested ||
        issue.identifier.toLocaleLowerCase() === requested,
    );
    if (match) return match;
  }
  return undefined;
}

async function findMostRecentUnreviewedIssue(
  linearSetup: LinearSetupClient,
  projectMappings: Array<{ teamId: string }>,
  reviewedLabelId: string,
): Promise<LinearSetupIssue | undefined> {
  const candidates: LinearSetupIssue[] = [];
  const seenTeams = new Set<string>();
  for (const mapping of projectMappings) {
    if (seenTeams.has(mapping.teamId)) continue;
    seenTeams.add(mapping.teamId);
    const issues = await linearSetup.listIssues(mapping.teamId);
    candidates.push(
      ...issues.filter((issue) => !issue.labels.some((label) => label.id === reviewedLabelId)),
    );
  }
  // listIssues already returns Linear's default (most-recently-updated-first) ordering per team;
  // interleave by taking the first unreviewed ticket found across mapped teams.
  return candidates[0];
}
