import { describe, expect, it } from "vitest";
import { runMacroWorkflow } from "../../../src/macro-workflow/runner.js";
import { materializeWorkflowPlan } from "../../../src/macro-workflow/templates.js";
import {
  createSourceToProjectDynamicExpander,
  createSourceToProjectHarnessRegistry,
} from "../../../src/macro-workflow/sourceToProject/harnesses.js";

describe("source-to-project autonomous PR mode", () => {
  it("runs worktree preparation before implementation nodes", async () => {
    const plan = materializeWorkflowPlan("source-to-project", {
      objective: "Apply one opportunity",
      source: "https://example.com/post",
      project: "weavekit",
      mode: "autonomous-pr",
    });
    const calls: string[] = [];
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
          calls.push(args.mode);
          if (args.operation?.startsWith("visual-design-")) {
            return "Published visual-plan MDX artifact: https://plan.agent-native.com/builder/autonomous-pr-visual";
          }
          return "raw output";
        },
      },
      worktree: {
        async prepare() {
          calls.push("prepare-worktree");
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
          calls.push([command, ...args].join(" "));
          return command === "gh" ? "https://example.com/pr/1\n" : "ok\n";
        },
      },
    };
    const harnesses = createSourceToProjectHarnessRegistry(sourceToProjectOptions);

    const state = await runMacroWorkflow(plan, {
      harnesses,
      expandAfterNode: createSourceToProjectDynamicExpander(sourceToProjectOptions),
    });

    expect(state.status).toBe("passed");
    expect(calls.indexOf("prepare-worktree")).toBeLessThan(calls.indexOf("implement"));
    expect(state.nodeResults.find((result) => result.nodeId === "open-pr")?.payload).toEqual({
      prUrl: "https://example.com/pr/1",
    });
  });
});
