import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DecisionCouncilReport, DecisionCouncilRunState, DecisionPersonaFailure } from "./types.js";

export type DecisionCouncilArtifacts = {
  reportPath: string;
  statePath: string;
  debugTranscriptPaths: string[];
};

function renderList(items: string[]): string {
  if (items.length === 0) {
    return "- None\n";
  }

  return items.map((item) => `- ${item}`).join("\n") + "\n";
}

function renderFailures(failures: DecisionPersonaFailure[]): string {
  if (failures.length === 0) {
    return "- None\n";
  }

  return failures
    .map((failure) => `- ${failure.personaId}: ${failure.message} (retryable: ${failure.retryable})`)
    .join("\n") + "\n";
}

export function renderDecisionCouncilReportMarkdown(report: DecisionCouncilReport): string {
  if (report.finalReportMarkdown.trim().length > 0) {
    return report.finalReportMarkdown.endsWith("\n") ? report.finalReportMarkdown : `${report.finalReportMarkdown}\n`;
  }

  return [
    "# Design Council Report",
    "",
    "## Recommendation",
    "",
    report.recommendation,
    "",
    "## Rationale",
    "",
    renderList(report.rationale).trimEnd(),
    "",
    "## Strongest Objections",
    "",
    renderList(report.strongestObjections).trimEnd(),
    "",
    "## Unresolved Questions",
    "",
    renderList(report.unresolvedQuestions).trimEnd(),
    "",
    "## Confidence and Convergence",
    "",
    `- Confidence: ${report.confidence.toFixed(2)}`,
    `- Convergence: ${report.convergence.toFixed(2)}`,
    "",
    "## Next Experiment",
    "",
    report.nextExperiment,
    "",
    "## Failed Personas",
    "",
    renderFailures(report.failedPersonas).trimEnd(),
    "",
  ].join("\n");
}

export async function writeDecisionCouncilArtifacts(args: {
  outputDir: string;
  state: DecisionCouncilRunState;
}): Promise<DecisionCouncilArtifacts> {
  const { outputDir, state } = args;

  if (!state.finalReport) {
    throw new Error("Cannot write council artifacts without a final report.");
  }

  await mkdir(outputDir, { recursive: true });
  const debugDir = join(outputDir, "debug");
  await mkdir(debugDir, { recursive: true });

  const reportPath = join(outputDir, "CouncilReport.md");
  const statePath = join(outputDir, "CouncilRunState.json");

  await writeFile(reportPath, renderDecisionCouncilReportMarkdown(state.finalReport), "utf8");
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");

  const debugTranscriptPaths: string[] = [];
  for (const round of state.rounds) {
    for (let i = 0; i < round.rawResults.length; i++) {
      const result = round.rawResults[i]!;
      const transcriptPath = join(debugDir, `round-${round.brief.roundNumber}-${result.personaId}-${i}.txt`);
      await writeFile(transcriptPath, result.transcript.join("\n") + "\n", "utf8");
      debugTranscriptPaths.push(transcriptPath);
    }
  }

  return { reportPath, statePath, debugTranscriptPaths };
}
