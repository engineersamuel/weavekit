#!/usr/bin/env node
import { loadLocalEnvFiles, loadMastermindRuntimeConfig } from "../src/config.js";
import { SqliteMastermindStore } from "../src/mastermind/index.js";
import {
  buildTicketScorecard,
  type AttemptScorecard,
  type TicketScorecard,
} from "../src/mastermind/selfImprovement/runMetrics.js";
import type { StoredCodeReview } from "../src/mastermind/store/store.js";

const DEFAULT_RECENT_LIMIT = 5;

loadLocalEnvFiles();

let store: SqliteMastermindStore | undefined;
try {
  const selector = process.argv[2]?.trim();
  const config = await loadMastermindRuntimeConfig();
  store = new SqliteMastermindStore(config.mastermind.sqlitePath);
  await store.initialize();

  const targets: Array<{ workId: string; identifier: string }> = [];
  if (selector) {
    const attachment = await store.findExecutionAttachment(selector);
    if (!attachment) {
      throw new Error(`No Mastermind work matches "${selector}".`);
    }
    targets.push({ workId: attachment.workId, identifier: attachment.ticketIdentifier });
  } else {
    targets.push(...(await store.listRecentTicketWorkIds(DEFAULT_RECENT_LIMIT)));
  }
  if (targets.length === 0) {
    process.stdout.write("No Mastermind work items are recorded yet.\n");
  }

  for (const target of targets) {
    const attempts = await store.listExecutionAttempts(target.workId);
    const codeReview = await store.getCurrentCodeReview(target.workId);
    const byAttemptId = new Map<string, StoredCodeReview>(
      codeReview ? [[codeReview.executionAttemptId, codeReview]] : [],
    );
    process.stdout.write(
      formatTicketScorecard(
        target.identifier,
        buildTicketScorecard(target.workId, attempts, byAttemptId),
      ),
    );
  }
} catch (error) {
  process.stderr.write(
    `mastermind:metrics failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  store?.close();
}

function formatTicketScorecard(identifier: string, scorecard: TicketScorecard): string {
  const lines = [`${identifier}  work=${scorecard.workId}`];
  if (scorecard.attempts.length === 0) {
    lines.push("  no execution attempts recorded");
  }
  for (const attempt of scorecard.attempts) {
    lines.push(...formatAttempt(attempt));
  }
  lines.push(
    `  attempts to code-review pass: ${scorecard.attemptsToCodeReviewPass ?? "not passed yet"}`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

function formatAttempt(attempt: AttemptScorecard): string[] {
  const { efficiency, outcome } = attempt;
  const lines = [
    `  attempt ${attempt.attemptNumber}  state=${outcome.state}` +
      `${outcome.outcome ? ` outcome=${outcome.outcome}` : ""}`,
  ];
  if (efficiency) {
    const profiles = Object.entries(efficiency.callsByProfile)
      .sort(([, left], [, right]) => right - left)
      .map(([profile, count]) => `${profile}=${count}`)
      .join(" ");
    lines.push(
      `    spawns: total=${efficiency.totalCalls} maxDepth=${efficiency.maxDepthReached} ` +
        `failed=${efficiency.failedCalls}` +
        `${efficiency.wallMs !== undefined ? ` wall=${formatDuration(efficiency.wallMs)}` : ""}`,
      `    by profile: ${profiles || "(none)"}`,
    );
  } else {
    lines.push("    spawns: no run record (pre-instrumentation attempt, or a non-RLM executor)");
  }
  const findings = Object.entries(outcome.findingsBySeverity)
    .map(([severity, count]) => `${severity}=${count}`)
    .join(" ");
  lines.push(
    `    review: status=${outcome.codeReviewStatus ?? "-"} verdict=${outcome.codeReviewVerdict ?? "-"}` +
      `${outcome.codeReviewConfidence !== undefined ? ` confidence=${outcome.codeReviewConfidence}` : ""}`,
    `    findings: ${findings}`,
  );
  return lines;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
