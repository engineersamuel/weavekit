import { describe, expect, it, vi } from "vitest";
import type { ToolResultObject } from "@github/copilot-sdk";
import { createRlmExecutionBudget } from "../../../src/rlm-poc/budget.js";
import { TrellageTurnOutcome } from "../../../src/generated/baml_client/index.js";
import { createTrellageCatalog } from "../../../src/rlm-poc/trellage/catalog.js";
import {
  TrellageHarness,
  TrellageMode,
  TrellageOutcome,
  type TrellageInvokeArgs,
  type TrellageProfile,
} from "../../../src/rlm-poc/trellage/contracts.js";
import { createTrellageTool } from "../../../src/rlm-poc/trellage/tool.js";
import type { TrellageProcessInput } from "../../../src/rlm-poc/trellage/headlessRunner.js";
import type { TrellageWorktreeRegistry } from "../../../src/rlm-poc/trellage/worktrees.js";

const PROFILE: TrellageProfile = {
  harness: TrellageHarness.Copilot,
  mode: TrellageMode.Native,
  launcher: "cpx",
  name: "hve",
  description: "Copilot engineering.",
  sandbox: false,
};

type Handler = (
  args: TrellageInvokeArgs,
  invocation: { toolCallId?: string },
) => Promise<ToolResultObject>;

describe("headless Trellage tool wiring", () => {
  it("uses the native JSONL path without creating a PTY backend", async () => {
    const argv: string[][] = [];
    const budget = createRlmExecutionBudget(2);
    const processRunner = {
      run: vi.fn(async (input: TrellageProcessInput) => {
        argv.push([...input.argv]);
        return {
          argv: [...input.argv],
          stdout: [
            JSON.stringify({ type: "session.start", data: { sessionId: "session-1" } }),
            JSON.stringify({
              type: "session.task_complete",
              data: {
                sessionId: "session-1",
                summary: "Implemented the task.",
                success: true,
              },
            }),
            JSON.stringify({ type: "result", sessionId: "session-1", exitCode: 0 }),
          ].join("\n"),
          stderr: "",
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
        };
      }),
    };
    const createBackend = vi.fn();
    const worktrees = {
      acquire: async () => ({
        worktreePath: process.cwd(),
        workspaceId: "native-test",
        repositoryPath: process.cwd(),
        branchName: "rlm/test",
        baseSha: "base",
        native: true,
      }),
      withExclusiveAccess: async <T>(_repository: string, operation: () => Promise<T>) =>
        operation(),
    } as unknown as TrellageWorktreeRegistry;
    const tool = createTrellageTool({
      runId: "test",
      catalog: createTrellageCatalog([PROFILE], async () => ({
        stdout: JSON.stringify({ readiness: "healthy" }),
      })),
      worktrees,
      repositoryPath: process.cwd(),
      answer: async () => "unused",
      executionBudget: budget,
      headlessRunner: processRunner,
      diagnose: {
        diagnose: async () => ({
          outcome: TrellageTurnOutcome.ACHIEVED,
          summary: "The task is complete.",
        }),
      },
      createBackend: createBackend as never,
    });

    const result = await (tool as unknown as { handler: Handler }).handler(
      { prompt: "Implement the task.", harness: TrellageHarness.Copilot, profile: "hve" },
      { toolCallId: "call-1" },
    );
    const payload = JSON.parse(result.textResultForLlm as string);

    expect(result.resultType).toBe("success");
    expect(payload.outcome).toBe(TrellageOutcome.Completed);
    expect(payload.attempts).toHaveLength(1);
    expect(argv[0]).toEqual(expect.arrayContaining(["--no-ask-user", "--allow-all"]));
    expect(createBackend).not.toHaveBeenCalled();
    expect(budget.usedCalls).toBe(1);
  });
});
