import { join } from "node:path";
import type { DecisionCouncilReport } from "../decision-council/types.js";
import type { WorkQueueBackend } from "./backend.js";
import { runWorkQueueSpan } from "./telemetry.js";

export type DecisionCouncilWorkQueueOptions = {
  backend: WorkQueueBackend;
  workItemId: string;
  claimOnStart?: boolean;
  closeOnSuccess?: boolean;
  createFollowUp?: boolean;
  syncOnComplete?: boolean;
};

export async function startDecisionCouncilWorkItem(options?: DecisionCouncilWorkQueueOptions): Promise<void> {
  if (!options?.claimOnStart) return;
  await runWorkQueueSpan("claim", { itemId: options.workItemId }, async () => options.backend.claim(options.workItemId));
}

export async function completeDecisionCouncilWorkItem(args: {
  options?: DecisionCouncilWorkQueueOptions;
  report: DecisionCouncilReport;
  outputDir?: string;
}): Promise<void> {
  const { options, report, outputDir } = args;
  if (!options) return;

  if (options.createFollowUp) {
    await runWorkQueueSpan("create-follow-up", { itemId: options.workItemId }, async () =>
      options.backend.create({
        title: `Decision Council next experiment: ${report.nextExperiment}`,
        description: [
          `Recommendation: ${report.recommendation}`,
          "",
          "Unresolved questions:",
          ...report.unresolvedQuestions.map((question) => `- ${question}`),
        ].join("\n"),
        type: "task",
        priority: 2,
        labels: ["weavekit", "decision-council"],
        dependencies: [{ type: "discovered-from", id: options.workItemId }],
      }),
    );
  }

  if (options.closeOnSuccess) {
    const reportPath = outputDir ? join(outputDir, "DecisionCouncilReport.md") : "not written";
    await runWorkQueueSpan("close", { itemId: options.workItemId }, async () =>
      options.backend.close(options.workItemId, {
        reason: `Decision Council completed. Recommendation: ${report.recommendation} Report: ${reportPath}`,
      }),
    );
  }

  if (options.syncOnComplete) {
    await runWorkQueueSpan("sync", { itemId: options.workItemId }, async () => options.backend.sync());
  }
}
