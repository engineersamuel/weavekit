import { describe, expect, it } from "vitest";
import {
  buildSourceToProjectPrAgentPrompt,
  launchSourceToProjectPrAgent,
} from "../../../src/macro-workflow/sourceToProject/prLauncher.js";

describe("source-to-project manual PR launcher", () => {
  it("creates a Herdr worktree, starts the configured agent, and sends the reviewed opportunity prompt", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];

    const result = await launchSourceToProjectPrAgent({
      config: {
        provider: "herdr",
        agentCommand: "claude",
        agentArgs: ["--dangerously-skip-permissions"],
        split: "down",
        agentOptions: [],
      },
      context: {
        runId: "run-1",
        nodeId: "visual-design-opportunity-opp-1",
        objective: "Apply source lessons",
        source: "https://example.com/source",
        project: {
          id: "weavekit",
          displayName: "Weavekit",
          workingTree: "/repo/weavekit",
          mainline: "origin main",
          remote: "origin",
          contextDocs: ["CONTEXT.md"],
          validationCommands: ["nub run typecheck", "nub run test"],
          autonomousPrAllowed: true,
          notification: "cli",
          knowledgeExport: "off",
        },
        opportunityId: "opp-1",
        opportunityTitle: "Add manual PR launch",
        reportMarkdown: "# Source-to-Project Report\n\nImplement the manual PR action.",
        visualPlanUrl: "https://plan.agent-native.com/local-plans/opp-1",
        planTitle: "Manual PR launch plan",
        recommendation: "Create a manual PR launch path.",
      },
      shell: {
        async run(command, args, options) {
          commands.push({ command, args, cwd: options.cwd });
          if (command === "herdr" && args[0] === "worktree") {
            return JSON.stringify({
              result: {
                worktree: {
                  path: "/Users/smendenhall/.herdr/worktrees/weavekit/worktree-source-to-project-opp-1",
                  branch: "source-to-project/opp-1-run-1",
                },
                workspace_id: "wP",
                tab: { tab_id: "wP:t1" },
              },
            });
          }
          return "";
        },
      },
    });

    expect(result).toMatchObject({
      provider: "herdr",
      worktreePath: "/Users/smendenhall/.herdr/worktrees/weavekit/worktree-source-to-project-opp-1",
      branchName: "worktree/opp-1-run-1",
      agentName: "source-to-project-opp-1-run-1",
      workspaceId: "wP",
      tabId: "wP:t1",
    });
    expect(commands[0]).toEqual({
      command: "herdr",
      args: [
        "worktree",
        "create",
        "--cwd",
        "/repo/weavekit",
        "--branch",
        "worktree/opp-1-run-1",
        "--label",
        "Add manual PR launch",
        "--json",
      ],
      cwd: "/repo/weavekit",
    });
    expect(commands[1]).toEqual({
      command: "sh",
      args: ["-lc", "command -v 'claude'"],
      cwd: "/repo/weavekit",
    });
    expect(commands[2]).toEqual({
      command: "herdr",
      args: [
        "agent",
        "start",
        "source-to-project-opp-1-run-1",
        "--cwd",
        "/Users/smendenhall/.herdr/worktrees/weavekit/worktree-source-to-project-opp-1",
        "--workspace",
        "wP",
        "--tab",
        "wP:t1",
        "--",
        "claude",
        "--dangerously-skip-permissions",
        expect.stringContaining("/plan\n\nRequirements:"),
      ],
      cwd: "/repo/weavekit",
    });
    expect(commands[2]?.args.at(-1)).toContain("Requirements:");
    expect(commands[2]?.args.at(-1)).not.toContain("Implement the reviewed source-to-project opportunity and open a PR.");
    expect(commands[2]?.args.at(-1)).not.toContain("Start agents from the CLI context");
    expect(commands[2]?.args.at(-1)).toContain("https://plan.agent-native.com/local-plans/opp-1");
    expect(commands[2]?.args.at(-1)).toContain("nub run typecheck");
    expect(commands.some((command) => command.args.slice(0, 2).join(" ") === "agent send")).toBe(false);
  });

  it("skips plan mode and asks the agent to implement directly when initialPromptMode is 'implement'", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];

    await launchSourceToProjectPrAgent({
      config: {
        provider: "herdr",
        agentCommand: "codex",
        agentArgs: [],
        split: "right",
        agentOptions: [],
      },
      context: { ...launchContextFixture(), initialPromptMode: "implement" },
      shell: {
        async run(command, args, options) {
          commands.push({ command, args, cwd: options.cwd });
          if (command === "sh") {
            return "/Users/smendenhall/.local/bin/codex\n";
          }
          if (command === "herdr" && args[0] === "worktree") {
            return JSON.stringify({
              result: {
                worktree: {
                  path: "/Users/smendenhall/.herdr/worktrees/weavekit/worktree-source-to-project-opp-1",
                  branch: "source-to-project/opp-1-run-1",
                },
                workspace_id: "wP",
                root_pane: { pane_id: "wP:p1", tab_id: "wP:t1" },
              },
            });
          }
          return "";
        },
      },
    });

    const paneRunCommand = commands.find((command) => command.command === "herdr" && command.args[0] === "pane" && command.args[1] === "run");
    expect(paneRunCommand?.args[2]).toBe("wP:p1");
    expect(paneRunCommand?.args[3]).not.toContain("/plan\n");
    expect(paneRunCommand?.args[3]).not.toContain("Start agents from the CLI context");
    expect(paneRunCommand?.args[3]).toContain("Implement this reviewed source-to-project opportunity directly");
    expect(paneRunCommand?.args[3]).toContain("Requirements:");
  });

  it("resolves bare agent commands before passing them to Herdr", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];

    await launchSourceToProjectPrAgent({
      config: {
        provider: "herdr",
        agentCommand: "codex",
        agentArgs: [],
        split: "right",
        agentOptions: [],
      },
      context: launchContextFixture(),
      shell: {
        async run(command, args, options) {
          commands.push({ command, args, cwd: options.cwd });
          if (command === "sh") {
            return "/Users/smendenhall/.local/bin/codex\n";
          }
          if (command === "herdr" && args[0] === "worktree") {
            return JSON.stringify({
              result: {
                worktree: {
                  path: "/Users/smendenhall/.herdr/worktrees/weavekit/worktree-source-to-project-opp-1",
                  branch: "source-to-project/opp-1-run-1",
                },
                workspace_id: "wP",
                root_pane: { pane_id: "wP:p1", tab_id: "wP:t1" },
              },
            });
          }
          return "";
        },
      },
    });

    const paneRunCommand = commands.find((command) => command.command === "herdr" && command.args[0] === "pane" && command.args[1] === "run");
    expect(paneRunCommand?.args[2]).toBe("wP:p1");
    expect(paneRunCommand?.args[3]).toContain("/Users/smendenhall/.local/bin/codex");
    expect(paneRunCommand?.args[3]).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(paneRunCommand?.args[3]).toContain("/plan");
    expect(paneRunCommand?.args[3]).toContain("Requirements:");
    expect(commands.some((command) => command.args.slice(0, 2).join(" ") === "agent start")).toBe(false);
    expect(commands.some((command) => command.args.slice(0, 2).join(" ") === "agent send")).toBe(false);
  });

  it("falls back to the configured split when Herdr does not return a worktree workspace", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];

    await launchSourceToProjectPrAgent({
      config: {
        provider: "herdr",
        agentCommand: "/Users/smendenhall/.local/bin/codex",
        agentArgs: [],
        split: "down",
        agentOptions: [],
      },
      context: launchContextFixture(),
      shell: {
        async run(command, args, options) {
          commands.push({ command, args, cwd: options.cwd });
          if (command === "herdr" && args[0] === "worktree") {
            return JSON.stringify({
              result: {
                worktree: {
                  path: "/Users/smendenhall/.herdr/worktrees/weavekit/no-workspace",
                  branch: "source-to-project/opp-1-run-1",
                },
              },
            });
          }
          return "";
        },
      },
    });

    const startCommand = commands.find((command) => command.command === "herdr" && command.args[0] === "agent" && command.args[1] === "start");
    expect(startCommand?.args).toContain("--split");
    expect(startCommand?.args).toContain("down");
    expect(startCommand?.args).not.toContain("--workspace");
    expect(startCommand?.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(startCommand?.args.at(-1)).toContain("/plan");
  });

  it("opens an existing Herdr worktree when create reports that the branch already exists", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];

    const result = await launchSourceToProjectPrAgent({
      config: {
        provider: "herdr",
        agentCommand: "/Users/smendenhall/.local/bin/codex",
        agentArgs: [],
        split: "right",
        agentOptions: [],
      },
      context: launchContextFixture(),
      shell: {
        async run(command, args, options) {
          commands.push({ command, args, cwd: options.cwd });
          if (command === "herdr" && args[0] === "worktree" && args[1] === "create") {
            throw new Error("branch already exists");
          }
          if (command === "herdr" && args[0] === "worktree" && args[1] === "open") {
            return JSON.stringify({
              result: {
                worktree: {
                  path: "/Users/smendenhall/.herdr/worktrees/weavekit/existing",
                  branch: "source-to-project/opp-1-run-1",
                },
              },
            });
          }
          return "";
        },
      },
    });

    expect(result.worktreePath).toBe("/Users/smendenhall/.herdr/worktrees/weavekit/existing");
    expect(commands.map((command) => command.args.slice(0, 2).join(" "))).toContain("worktree open");
  });

  it("renders the target project research brief explicitly in the agent prompt", () => {
    const prompt = buildSourceToProjectPrAgentPrompt({
      ...launchContextFixture(),
      projectBrief: {
        projectId: "path-override",
        displayName: "Path override",
        architecture: "Keep Runs in-process with isolated worktrees and single-writer maker/checker enforcement.",
        constraints: [
          "No durable work queues or cross-run persistent worktrees.",
          "No scheduler or always-on agents.",
        ],
        goals: [
          "Strengthen per-Run isolation.",
          "Make maker/checker separation explicit at runtime.",
        ],
        changeSurfaces: [
          "src/worktree.ts",
          "src/harnesses.ts",
        ],
        validationCommands: [
          "nub run typecheck",
          "nub run test",
        ],
        risks: [
          "Fail-closed guards may break misconfigured plans.",
        ],
        evidence: [
          {
            id: "p-architecture",
            source: "Project brief: architecture",
            quote: "Keep Runs as in-process, single-machine executions.",
          },
        ],
      },
    });

    expect(prompt).toContain("Target project research brief:");
    expect(prompt).toContain("Architecture: Keep Runs in-process with isolated worktrees and single-writer maker/checker enforcement.");
    expect(prompt).toContain("Constraints:");
    expect(prompt).toContain("- No durable work queues or cross-run persistent worktrees.");
    expect(prompt).toContain("Goals:");
    expect(prompt).toContain("- Strengthen per-Run isolation.");
    expect(prompt).toContain("Change surfaces:");
    expect(prompt).toContain("- src/worktree.ts");
    expect(prompt).toContain("Project research validation commands:");
    expect(prompt).toContain("- nub run test");
    expect(prompt).toContain("Project risks:");
    expect(prompt).toContain("- Fail-closed guards may break misconfigured plans.");
    expect(prompt).toContain("Project evidence:");
    expect(prompt).toContain("- p-architecture: Project brief: architecture - Keep Runs as in-process, single-machine executions.");
    expect(prompt).not.toContain("Path override");
  });
});

function launchContextFixture(): Parameters<typeof launchSourceToProjectPrAgent>[0]["context"] {
  return {
    runId: "run-1",
    nodeId: "visual-design-opportunity-opp-1",
    objective: "Apply source lessons",
    source: "https://example.com/source",
    project: {
      id: "weavekit",
      displayName: "Weavekit",
      workingTree: "/repo/weavekit",
      mainline: "origin main",
      remote: "origin",
      contextDocs: ["CONTEXT.md"],
      validationCommands: ["nub run typecheck", "nub run test"],
      autonomousPrAllowed: true,
      notification: "cli",
      knowledgeExport: "off",
    },
    opportunityId: "opp-1",
    opportunityTitle: "Add manual PR launch",
    reportMarkdown: "# Source-to-Project Report\n\nImplement the manual PR action.",
    visualPlanUrl: "https://plan.agent-native.com/local-plans/opp-1",
    planTitle: "Manual PR launch plan",
    recommendation: "Create a manual PR launch path.",
  };
}
