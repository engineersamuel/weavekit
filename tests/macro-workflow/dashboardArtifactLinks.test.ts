import { describe, expect, it } from "vitest";
import { buildNodeArtifactLinks } from "../../src/macro-workflow/dashboard/artifactLinks.js";
import { WorkflowHarnessKind, WorkflowNodeKind, WorkflowNodeStatus } from "../../src/macro-workflow/types.js";
import type {
  MacroWorkflowRunStateLike,
  RuntimeWorkflowNode,
  WorkflowNodeExecutionResult,
} from "../../src/macro-workflow/types.js";

describe("dashboard artifact link helpers", () => {
  it("links node-produced report artifacts during running workflows instead of missing workflow reports", () => {
    const links = buildNodeArtifactLinks({
      node: reportNodeFixture(),
      result: resultFixture([{
        kind: "markdown",
        path: "verification-research-opp-ci-workflow-DeepResearchReport.md",
        description: "Deep research Markdown report.",
      }]),
      snapshot: snapshotFixture(WorkflowNodeStatus.RUNNING),
    });

    expect(links.map((link) => link.file)).toEqual([
      "verification-research-opp-ci-workflow-DeepResearchReport.md",
    ]);
    expect(links[0]).toMatchObject({
      label: "Open Deep research Markdown report",
      href: "/api/artifact?runId=run-1&file=verification-research-opp-ci-workflow-DeepResearchReport.md",
    });
  });

  it("includes the top-level workflow report after the run completes", () => {
    const links = buildNodeArtifactLinks({
      node: reportNodeFixture(),
      result: resultFixture([{
        kind: "markdown",
        path: "verification-research-opp-ci-workflow-DeepResearchReport.md",
        description: "Deep research Markdown report.",
      }]),
      snapshot: snapshotFixture(WorkflowNodeStatus.PASSED),
    });

    expect(links.map((link) => link.file)).toEqual([
      "verification-research-opp-ci-workflow-DeepResearchReport.md",
      "workflow-report.md",
    ]);
  });
});

function reportNodeFixture(): RuntimeWorkflowNode {
  return {
    id: "verification-research-opp-ci-workflow-report",
    kind: WorkflowNodeKind.REPORT,
    harness: WorkflowHarnessKind.REPORTER,
    title: "Compile deep research report",
    prompt: "Compile the deep research Markdown report.",
    dependsOn: ["verification-research-opp-ci-workflow-assess-1"],
    gates: [],
    writeMode: "read-only",
    replanPolicy: "never",
  };
}

function resultFixture(artifacts: WorkflowNodeExecutionResult["artifacts"]): WorkflowNodeExecutionResult {
  return {
    nodeId: "verification-research-opp-ci-workflow-report",
    status: WorkflowNodeStatus.PASSED,
    output: "# Deep Research Report",
    artifacts,
  };
}

function snapshotFixture(status: MacroWorkflowRunStateLike["status"]) {
  return {
    activeRunId: "run-1",
    run: {
      runId: "run-1",
      status,
    },
    state: {
      runId: "run-1",
      planId: "plan-1",
      objective: "Research",
      templateId: "verification-optimizer",
      status,
      startedAt: new Date("2026-07-07T00:00:00.000Z"),
      currentPlan: {
        id: "plan-1",
        objective: "Research",
        templateId: "verification-optimizer",
        maxReplans: 0,
        nodes: [reportNodeFixture()],
      },
      nodeResults: [],
      replans: [],
    } satisfies MacroWorkflowRunStateLike,
  };
}
