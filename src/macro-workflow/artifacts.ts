import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MacroWorkflowRunStateLike, WorkflowReplayEvent } from "./types.js";

export type MacroWorkflowArtifactPaths = {
  reportPath: string;
  statePath: string;
  eventLogPath: string;
};

export type MacroWorkflowArtifactsInput = {
  outputDir: string;
  state: MacroWorkflowRunStateLike;
  replayEvents?: WorkflowReplayEvent[];
};

export async function writeMacroWorkflowArtifacts(
  input: MacroWorkflowArtifactsInput,
): Promise<MacroWorkflowArtifactPaths> {
  await mkdir(input.outputDir, { recursive: true });

  const reportPath = join(input.outputDir, "workflow-report.md");
  const statePath = join(input.outputDir, "workflow-state.json");
  const eventLogPath = join(input.outputDir, "workflow-events.jsonl");

  const report = [
    "# Macro Workflow Run Report",
    "",
    `- Plan: ${input.state.currentPlan.id}`,
    `- Objective: ${input.state.objective}`,
    `- Template: ${input.state.templateId}`,
    `- Status: ${input.state.status}`,
    "",
    "## Node Results",
    ...(input.state.nodeResults.length === 0
      ? ["No node results recorded."]
      : input.state.nodeResults.map((result) => `- ${result.nodeId}: ${result.status} - ${result.output}`)),
    "",
    "## Replans",
    ...(input.state.replans.length === 0 ? ["No replans recorded."] : input.state.replans.map((replan) => `- ${replan.failedNodeId}: ${replan.reason}`)),
  ].join("\n");

  await writeFile(reportPath, report, "utf8");
  await writeMacroWorkflowStateArtifact(input.outputDir, input.state);
  if (input.replayEvents) {
    await writeFile(eventLogPath, formatWorkflowReplayEvents(input.replayEvents), "utf8");
  }

  return { reportPath, statePath, eventLogPath };
}

export async function writeMacroWorkflowStateArtifact(outputDir: string, state: MacroWorkflowRunStateLike): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const statePath = join(outputDir, "workflow-state.json");
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  return statePath;
}

export async function appendWorkflowReplayEvent(outputDir: string, event: WorkflowReplayEvent): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const eventLogPath = join(outputDir, "workflow-events.jsonl");
  await appendFile(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
  return eventLogPath;
}

function formatWorkflowReplayEvents(events: WorkflowReplayEvent[]): string {
  if (events.length === 0) {
    return "";
  }
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}
