import { describe, expect, it } from "vitest";
import { runMacroWorkflow } from "../../../src/macro-workflow/runner.js";
import { materializeWorkflowPlan } from "../../../src/macro-workflow/templates.js";
import {
  createSourceToProjectDynamicExpander,
  createSourceToProjectHarnessRegistry,
} from "../../../src/macro-workflow/sourceToProject/harnesses.js";

type ReviewStatus = "accepted" | "needs_changes";

function reviewJson(status: ReviewStatus, finding = "A regression test is missing.") {
  return JSON.stringify({
    status,
    blockingFindings: status === "accepted" ? [] : [finding],
    rationale:
      status === "accepted"
        ? "No blocking findings remain."
        : "The implementation is not safe to publish yet.",
  });
}

describe("source-to-project autonomous PR mode", () => {
  async function runScenario(reviewStatuses: ReviewStatus[]) {
    const plan = materializeWorkflowPlan("source-to-project", {
      objective: "Apply one opportunity",
      source: "https://example.com/post",
      project: "weavekit",
      mode: "autonomous-pr",
    });
    const operations: string[] = [];
    const reviewQueue = reviewStatuses.map((status) => reviewJson(status));
    let validationRuns = 0;
    let prCreateRuns = 0;
    const sourceToProjectOptions: Parameters<typeof createSourceToProjectHarnessRegistry>[0] = {
      source: "https://example.com/post",
      mode: "autonomous-pr" as const,
      project: {
        id: "weavekit",
        displayName: "Weavekit",
        workingTree: "/repo/weavekit",
        mainline: "origin main",
        remote: "origin",
        contextDocs: ["CONTEXT.md"],
        validationCommands: ["echo ok"],
        autonomousPrAllowed: true,
        notification: "cli" as const,
        knowledgeExport: "off" as const,
      },
      copilot: {
        async run(args) {
          operations.push(args.operation ?? args.mode);
          if (
            args.operation === "review-implementation" ||
            args.operation === "re-review-implementation"
          ) {
            const verdict = reviewQueue.shift();
            if (!verdict) {
              throw new Error(`Missing queued verdict for ${args.operation}.`);
            }
            return verdict;
          }
          if (args.operation?.startsWith("visual-design-")) {
            return "Published visual-plan MDX artifact: https://plan.agent-native.com/builder/autonomous-pr-visual";
          }
          return args.operation === "fix-review-findings" ? "Fixed review findings." : "raw output";
        },
      },
      worktree: {
        async prepare() {
          operations.push("prepare-worktree");
          return {
            worktreePath: "/tmp/wt",
            branchName: "source-to-project/opp-1",
            baselineCommit: "abc123",
            copiedEnvFiles: [".env"],
          };
        },
      },
      shell: {
        async run(command, args) {
          operations.push([command, ...args].join(" "));
          if (command === "gh") {
            prCreateRuns += 1;
            return "https://example.com/pr/1\n";
          }
          if (command === "sh") {
            validationRuns += 1;
          }
          return "ok\n";
        },
      },
    };
    const harnesses = createSourceToProjectHarnessRegistry(sourceToProjectOptions);

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createSourceToProjectDynamicExpander(sourceToProjectOptions),
    });

    return { state, operations, validationRuns, prCreateRuns };
  }

  it("opens a PR after the initial structured review accepts", async () => {
    const { state, operations, prCreateRuns } = await runScenario(["accepted"]);

    expect(state.status).toBe("passed");
    expect(operations).toContain("review-implementation");
    expect(operations).not.toContain("fix-review-findings");
    expect(operations).not.toContain("re-review-implementation");
    expect(prCreateRuns).toBe(1);
    expect(operations.indexOf("prepare-worktree")).toBeLessThan(
      operations.indexOf("implement-selected-bundles"),
    );
    expect(
      state.nodeResults.find((result) => result.nodeId === "fix-review-findings")?.status,
    ).toBe("skipped");
    expect(state.nodeResults.find((result) => result.nodeId === "open-pr")?.payload).toMatchObject({
      finalImplementationReviewVerdict: { status: "accepted" },
    });
  });

  it("fixes, verifies, and re-reviews needs_changes exactly once", async () => {
    const { state, operations, validationRuns, prCreateRuns } = await runScenario([
      "needs_changes",
      "accepted",
    ]);

    expect(state.status).toBe("passed");
    expect(operations.filter((operation) => operation === "fix-review-findings")).toHaveLength(1);
    expect(operations.filter((operation) => operation === "re-review-implementation")).toHaveLength(
      1,
    );
    expect(validationRuns, operations.join("\n")).toBe(2);
    expect(prCreateRuns).toBe(1);
    expect(state.nodeResults.find((result) => result.nodeId === "open-pr")?.payload).toMatchObject({
      finalImplementationReviewVerdict: { status: "accepted" },
    });
  });

  it("fails closed when the re-review still needs changes", async () => {
    const { state, operations, prCreateRuns } = await runScenario([
      "needs_changes",
      "needs_changes",
    ]);

    expect(state.status).toBe("failed");
    expect(prCreateRuns).toBe(0);
    expect(state.nodeResults.find((result) => result.nodeId === "open-pr")).toMatchObject({
      status: "failed",
      payload: { finalImplementationReviewVerdict: { status: "needs_changes" } },
    });
    expect(operations.filter((operation) => operation === "fix-review-findings")).toHaveLength(1);
    expect(operations.filter((operation) => operation === "re-review-implementation")).toHaveLength(
      1,
    );
  });
});
