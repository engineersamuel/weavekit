import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadLocalEnvFiles, loadTypedWeavekitConfig, resolveProjectCatalogEntry, type ProjectCatalogEntry } from "../src/config.js";
import { createWorkflowDashboardServer } from "../src/macro-workflow/dashboardServer.js";
import type { MacroWorkflowRunStateLike, RuntimeWorkflowNode, WorkflowNodeExecutionResult, WorkflowReplayEvent } from "../src/macro-workflow/types.js";
import { WorkflowReplayEventKind } from "../src/macro-workflow/types.js";

export type PrLaunchSmokeRunOptions = {
  outputRoot: string;
  project: ProjectCatalogEntry;
  prompt?: string;
  runId?: string;
};

export type PrLaunchSmokeRun = {
  runId: string;
  outputDir: string;
  statePath: string;
  eventsPath: string;
};

const DEFAULT_PROMPT = [
  "This is a contrived smoke prompt for the manual PR launcher.",
  "Make a tiny harmless documentation-only change, run the configured validation command, commit it, and open a PR.",
  "The purpose is to verify that Weavekit -> dashboard -> Herdr worktree -> Codex agent handoff works.",
].join(" ");

export async function writePrLaunchSmokeRun(options: PrLaunchSmokeRunOptions): Promise<PrLaunchSmokeRun> {
  const runId = options.runId?.trim() || "manual-pr-smoke";
  const outputDir = join(resolve(options.outputRoot), runId);
  await mkdir(outputDir, { recursive: true });

  const prompt = options.prompt?.trim() || DEFAULT_PROMPT;
  const state = buildPrLaunchSmokeState({ project: options.project, prompt, runId });
  const events = buildPrLaunchSmokeEvents(state);
  const statePath = join(outputDir, "workflow-state.json");
  const eventsPath = join(outputDir, "workflow-events.jsonl");

  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  await writeFile(eventsPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  await writeFile(join(outputDir, "workflow-report.md"), state.nodeResults.find((result) => result.nodeId === "report-opportunity-smoke")?.output ?? "", "utf8");

  return { runId, outputDir, statePath, eventsPath };
}

function buildPrLaunchSmokeState(args: { project: ProjectCatalogEntry; prompt: string; runId: string }): MacroWorkflowRunStateLike {
  const opportunity = {
    id: "smoke",
    title: "Manual PR launcher smoke test",
    lesson: "A reviewed workflow should expose a manual handoff to an implementation agent.",
    projectChange: args.prompt,
    changeSurface: "source-to-project dashboard",
    score: { applicability: 0.99, impact: 0.9, confidence: 0.95, implementationCost: 0.1, risk: 0.1 },
    evidence: [{ id: "smoke-e1", source: "synthetic smoke fixture", quote: "manual PR launcher smoke test" }],
    speculative: false,
  };
  const nodes: RuntimeWorkflowNode[] = [
    {
      id: "plan-opportunity-smoke",
      kind: "planning",
      harness: "copilot-sdk",
      title: "Planning: manual PR launcher smoke test",
      description: "Synthetic accepted planning node for exercising the dashboard PR action.",
      model: "deterministic",
      prompt: "Create a minimal smoke implementation plan.",
      input: { opportunity },
      dependsOn: [],
      gates: ["output-contract"],
      writeMode: "read-only",
      replanPolicy: "never",
    },
    {
      id: "review-opportunity-smoke",
      kind: "deliberation",
      harness: "copilot-sdk",
      title: "Deliberation: approve smoke plan",
      description: "Synthetic review node that marks the smoke opportunity accepted.",
      model: "deterministic",
      prompt: "Review the minimal smoke implementation plan.",
      input: { opportunity },
      dependsOn: ["plan-opportunity-smoke"],
      gates: ["review-accepted"],
      writeMode: "read-only",
      replanPolicy: "never",
    },
    {
      id: "report-opportunity-smoke",
      kind: "report",
      harness: "reporter",
      title: "Report: manual PR launcher smoke test",
      description: "Synthetic report node containing the prompt that will be sent to the Herdr agent.",
      model: "deterministic",
      prompt: "Write the smoke source-to-project report.",
      input: { opportunity },
      dependsOn: ["review-opportunity-smoke"],
      gates: ["output-contract"],
      writeMode: "read-only",
      replanPolicy: "never",
    },
    {
      id: "visual-design-opportunity-smoke",
      kind: "visualization",
      harness: "copilot-sdk",
      title: "Visualization: manual PR launcher smoke test",
      description: "Synthetic passed visualization node for display only. Click Create PR on the report node.",
      model: "deterministic",
      prompt: "Create a visual smoke artifact.",
      input: { opportunity },
      dependsOn: ["report-opportunity-smoke"],
      gates: ["output-contract"],
      writeMode: "read-only",
      replanPolicy: "never",
    },
  ];
  const reportMarkdown = [
    "# Source-to-Project Report: smoke",
    "",
    "## Recommendation",
    args.prompt,
    "",
    "## Implementation Outline",
    "- Use the current Herdr-created worktree.",
    "- Make the smallest harmless change that proves the agent received this prompt.",
    "- Run the configured validation commands.",
    "- Commit the work and open a PR.",
  ].join("\n");
  const nodeResults: WorkflowNodeExecutionResult[] = [
    {
      nodeId: "source-reading",
      status: "passed",
      output: "Synthetic source analysis complete.",
      payload: { sourceAnalysis: { sourceId: "synthetic-smoke-source", title: "Manual PR smoke source" } },
    },
    {
      nodeId: "project-research",
      status: "passed",
      output: "Synthetic project research complete.",
      execution: { calls: [{ executor: "copilot-sdk", cwd: args.project.workingTree }] },
    },
    {
      nodeId: "plan-opportunity-smoke",
      status: "passed",
      output: "Smoke planning complete.",
      execution: { calls: [{ executor: "copilot-sdk", cwd: args.project.workingTree }] },
    },
    {
      nodeId: "review-opportunity-smoke",
      status: "passed",
      output: "Smoke deliberation accepted.",
      payload: {
        finalRecommendationReview: {
          status: "accepted",
          actionable: true,
          improvesProject: true,
          unnecessaryComplexity: false,
          benefitOutweighsCost: true,
          complexityAssessment: "Minimal smoke test.",
          rationale: "The fixture is intentionally contrived and bounded.",
        },
      },
    },
    {
      nodeId: "report-opportunity-smoke",
      status: "passed",
      output: reportMarkdown,
      payload: {
        sourceToProjectReportMarkdown: reportMarkdown,
        plan: {
          opportunityIds: ["smoke"],
          title: "Manual PR launcher smoke plan",
          recommendation: args.prompt,
          problemSolved: "The manual PR button needs a quick end-to-end exercise.",
          sourceLessonApplied: "Expose manual handoffs for reviewed work.",
          targetChange: "Launch a Herdr worktree and Codex agent from the dashboard action.",
          expectedUserValue: "The user can see the worktree and agent appear in Herdr.",
          implementationOutline: ["Click Create PR", "Inspect Herdr for the worktree and agent", "Confirm the prompt was delivered"],
          scope: "Synthetic dashboard smoke fixture only.",
          filesLikelyTouched: [],
          validationCommands: args.project.validationCommands,
          risks: ["The click intentionally creates real Herdr/worktree state."],
        },
      },
    },
    {
      nodeId: "visual-design-opportunity-smoke",
      status: "passed",
      output: "Synthetic visualization complete.",
      payload: {
        sourceToProjectVisualPlan: {
          opportunityId: "smoke",
          title: "Manual PR launcher smoke test",
          sourceReportNodeId: "report-opportunity-smoke",
          skill: "visual-plan",
          hostedArtifactUrl: "https://plan.agent-native.com/local-plans/manual-pr-smoke",
        },
      },
      execution: { calls: [{ executor: "copilot-sdk", cwd: args.project.workingTree }] },
    },
  ];
  return {
    runId: args.runId,
    runName: "Manual PR Launcher Smoke",
    planId: "manual-pr-launch-smoke",
    objective: "Exercise the source-to-project manual PR launch action.",
    templateId: "source-to-project",
    status: "passed",
    startedAt: new Date("2026-07-04T00:00:00.000Z"),
    completedAt: new Date("2026-07-04T00:00:01.000Z"),
    currentPlan: {
      id: "manual-pr-launch-smoke",
      objective: "Exercise the source-to-project manual PR launch action.",
      templateId: "source-to-project",
      maxReplans: 0,
      nodes,
    },
    nodeResults,
    replans: [],
  };
}

function buildPrLaunchSmokeEvents(state: MacroWorkflowRunStateLike): WorkflowReplayEvent[] {
  const nodes = state.currentPlan?.nodes ?? [];
  let seq = 0;
  const ts = "2026-07-04T00:00:00.000Z";
  return [
    {
      seq: ++seq,
      ts,
      kind: WorkflowReplayEventKind.PLANNING_STARTED,
      phase: "planning",
      nodeId: "workflow-planning",
      node: {
        id: "workflow-planning",
        kind: "planning",
        harness: "workflow-planner",
        title: "DAG Planning",
        prompt: state.objective,
        dependsOn: [],
      },
    },
    ...nodes.map((node): WorkflowReplayEvent => ({
      seq: ++seq,
      ts,
      kind: WorkflowReplayEventKind.NODE_ADDED,
      phase: "planning",
      nodeId: node.id,
      node,
    })),
    {
      seq: ++seq,
      ts,
      kind: WorkflowReplayEventKind.PLANNING_COMPLETE,
      phase: "running",
      nodeId: "workflow-planning",
      status: "passed",
    },
    ...nodes.map((node): WorkflowReplayEvent => ({
      seq: ++seq,
      ts,
      kind: WorkflowReplayEventKind.NODE_STATUS_CHANGED,
      phase: "running",
      nodeId: node.id,
      status: "passed",
    })),
    {
      seq: ++seq,
      ts,
      kind: WorkflowReplayEventKind.RUN_COMPLETED,
      phase: "completed",
      status: "passed",
    },
  ];
}

async function main() {
  loadLocalEnvFiles();
  const args = parseArgs(process.argv.slice(2));
  const config = loadTypedWeavekitConfig(args.configPath);
  const project = resolveProjectCatalogEntry(config, args.project);
  if (!project.autonomousPrAllowed) {
    throw new Error(`Project ${project.id} has autonomous_pr_allowed = false; enable it before using this smoke path.`);
  }
  const run = await writePrLaunchSmokeRun({
    outputRoot: args.outputRoot,
    project,
    prompt: args.prompt,
    runId: args.runId,
  });
  const server = await createWorkflowDashboardServer(undefined, {
    port: args.port,
    watchDir: args.outputRoot,
    configPath: args.configPath,
  });
  process.stdout.write(`Smoke run: ${run.outputDir}\n`);
  process.stdout.write(`Workflow dashboard: ${server.url}\n`);
  process.stdout.write("Open the dashboard, click the Visualization node, then click Create PR.\n");
  process.stdout.write("Stop with Ctrl-C when you are done.\n");
  await waitForShutdown(server.stop);
}

function parseArgs(argv: string[]): { project: string; outputRoot: string; prompt?: string; runId?: string; configPath?: string; port?: number } {
  const parsed: { project?: string; outputRoot?: string; prompt?: string; runId?: string; configPath?: string; port?: number } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project") {
      parsed.project = readArgValue(argv, index);
      index += 1;
      continue;
    }
    if (arg === "--output") {
      parsed.outputRoot = readArgValue(argv, index);
      index += 1;
      continue;
    }
    if (arg === "--prompt") {
      parsed.prompt = readArgValue(argv, index);
      index += 1;
      continue;
    }
    if (arg === "--run-id") {
      parsed.runId = readArgValue(argv, index);
      index += 1;
      continue;
    }
    if (arg === "--config") {
      parsed.configPath = readArgValue(argv, index);
      index += 1;
      continue;
    }
    if (arg === "--port") {
      parsed.port = Number(readArgValue(argv, index));
      index += 1;
      continue;
    }
  }
  return {
    project: parsed.project ?? "weavekit",
    outputRoot: parsed.outputRoot ? resolve(parsed.outputRoot) : resolve("runs/manual-pr-smoke"),
    prompt: parsed.prompt,
    runId: parsed.runId,
    configPath: parsed.configPath,
    port: parsed.port,
  };
}

function readArgValue(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${argv[index]}.`);
  }
  return value;
}

function waitForShutdown(stop: () => Promise<void>): Promise<void> {
  return new Promise((resolveShutdown) => {
    const shutdown = () => {
      stop().then(resolveShutdown).catch((error: unknown) => {
        process.stderr.write(`Dashboard shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
        resolveShutdown();
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
