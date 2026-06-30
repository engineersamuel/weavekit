import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MacroWorkflowRunStateLike } from "./types.js";

export type MacroWorkflowArtifactPaths = {
  reportPath: string;
  statePath: string;
};

export type MacroWorkflowArtifactsInput = {
  outputDir: string;
  state: MacroWorkflowRunStateLike;
};

export async function writeMacroWorkflowArtifacts(
  input: MacroWorkflowArtifactsInput,
): Promise<MacroWorkflowArtifactPaths> {
  await mkdir(input.outputDir, { recursive: true });

  const reportPath = join(input.outputDir, "workflow-report.md");
  const statePath = join(input.outputDir, "workflow-state.json");

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
  await writeFile(statePath, JSON.stringify(input.state, null, 2), "utf8");

  return { reportPath, statePath };
}
