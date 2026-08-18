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
import { TrellageDirectiveTransport } from "../../../src/rlm-poc/trellage/profileDirectives.js";
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

function promptArg(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("-p");
  return index >= 0 ? argv[index + 1] : undefined;
}

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
            JSON.stringify({ type: "diagnostic", data: "x".repeat(300_000) }),
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
    expect(payload.attempts[0]).toMatchObject({
      number: 1,
      stdoutBytes: expect.any(Number),
      terminal: "completed",
      sessionId: "session-1",
    });
    expect(payload.attempts[0].stdoutBytes).toBeGreaterThan(300_000);
    expect(payload.attempts[0]).not.toHaveProperty("stdout");
    expect(payload.attempts[0]).not.toHaveProperty("stderr");
    expect(payload.attempts[0]).not.toHaveProperty("argv");
    expect((result.textResultForLlm as string).length).toBeLessThan(32_768);
    expect(argv[0]).toEqual(expect.arrayContaining(["--no-ask-user", "--allow-all"]));
    const prompt = promptArg(argv[0] ?? []) ?? "";
    expect(prompt).toMatch(/^Implement the task\.\n\n<trellage_headless_protocol>/u);
    expect(prompt).not.toContain("<trellage_profile_directive");
    expect(prompt).not.toContain("<trellage_delegated_task");
    expect(createBackend).not.toHaveBeenCalled();
    expect(budget.usedCalls).toBe(1);
  });

  it("keeps /fleet as the first prefix before a custom prompt-envelope directive", async () => {
    const argv: string[][] = [];
    const tool = createTrellageTool({
      runId: "test",
      catalog: createTrellageCatalog([PROFILE], async () => ({
        stdout: JSON.stringify({ readiness: "healthy" }),
      })),
      worktrees: {
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
      } as unknown as TrellageWorktreeRegistry,
      repositoryPath: process.cwd(),
      answer: async () => "unused",
      executionBudget: createRlmExecutionBudget(2),
      profileDirectiveRegistry: {
        [`${TrellageMode.Native}/cpx/hve`]: {
          transport: TrellageDirectiveTransport.PromptEnvelope,
          rootRoutingDescription: "Custom cpx routing.",
          invocationDirective: "Use custom routing.",
        },
      },
      headlessRunner: {
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
      },
      diagnose: {
        diagnose: async () => ({
          outcome: TrellageTurnOutcome.ACHIEVED,
          summary: "The task is complete.",
        }),
      },
    });

    const result = await (tool as unknown as { handler: Handler }).handler(
      {
        prompt: "Implement the task.",
        harness: TrellageHarness.Copilot,
        profile: "hve",
        fleet: true,
      },
      { toolCallId: "call-1" },
    );

    expect(result.resultType).toBe("success");
    const prompt = promptArg(argv[0] ?? []) ?? "";
    expect(prompt).toMatch(/^\/fleet <trellage_profile_directive version="1">/u);
    expect(prompt).toContain('<trellage_delegated_task version="1">');
  });
});
