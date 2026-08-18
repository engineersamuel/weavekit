import { describe, expect, it, vi } from "vitest";
import { createRlmExecutionBudget } from "../../../src/rlm-poc/budget.js";
import { TrellageTurnOutcome } from "../../../src/generated/baml_client/index.js";
import {
  TrellageHarness,
  TrellageMode,
  TrellageOutcome,
  type TrellageProfile,
} from "../../../src/rlm-poc/trellage/contracts.js";
import { runTrellageHeadlessLoop } from "../../../src/rlm-poc/trellage/headlessLoop.js";
import type { TrellageProcessResult } from "../../../src/rlm-poc/trellage/headlessRunner.js";

const COPILOT_PROFILE: TrellageProfile = {
  harness: TrellageHarness.Copilot,
  mode: TrellageMode.Native,
  launcher: "cpx",
  name: "hve",
  description: "Copilot engineering.",
  sandbox: false,
};

const CLAUDE_PROFILE: TrellageProfile = {
  harness: TrellageHarness.Claude,
  mode: TrellageMode.Native,
  launcher: "cldx",
  name: "member",
  description: "Claude member.",
  sandbox: false,
};

const OMP_COPILOT_PROFILE: TrellageProfile = {
  harness: TrellageHarness.OhMyPi,
  mode: TrellageMode.Native,
  launcher: "omp",
  name: "copilot",
  description: "OMP with native Copilot authentication.",
  sandbox: false,
};

function copilotResult(
  summary: string,
  sessionId = "session-1",
  success = true,
): TrellageProcessResult {
  return {
    argv: ["cpx", "hve"],
    stdout: [
      JSON.stringify({ type: "session.start", data: { sessionId } }),
      JSON.stringify({
        type: "session.task_complete",
        data: { sessionId, summary, success },
      }),
      JSON.stringify({ type: "result", sessionId, exitCode: 0 }),
    ].join("\n"),
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
  };
}

function ompCopilotResult(summary: string, sessionId = "omp-session-1"): TrellageProcessResult {
  return {
    argv: ["omp", "copilot"],
    stdout: [
      JSON.stringify({ type: "session", id: sessionId }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: summary }],
          model: "gpt-5.6-sol",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      }),
      JSON.stringify({ type: "agent_end", isTerminal: true }),
    ].join("\n"),
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
  };
}

function claudeResult(
  summary: string,
  options: {
    sessionId?: string;
    usage?: Record<string, unknown>;
    costUsd?: number;
    premiumRequests?: number;
    durationMs?: number;
    changedFiles?: string[];
    permissionDenials?: string[];
    toolUses?: Array<Record<string, unknown>>;
  } = {},
): TrellageProcessResult {
  const sessionId = options.sessionId ?? "claude-session-1";
  return {
    argv: ["cldx", "member"],
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [...(options.toolUses ?? []), { type: "text", text: summary }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: summary,
        session_id: sessionId,
        ...(options.usage ? { usage: options.usage } : {}),
        ...(options.costUsd !== undefined ? { total_cost_usd: options.costUsd } : {}),
        ...(options.premiumRequests !== undefined
          ? { premium_requests: options.premiumRequests }
          : {}),
        ...(options.durationMs !== undefined ? { duration_ms: options.durationMs } : {}),
        ...(options.changedFiles ? { changed_files: options.changedFiles } : {}),
        ...(options.permissionDenials ? { permission_denials: options.permissionDenials } : {}),
      }),
    ].join("\n"),
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
  };
}

function loopInput(results: TrellageProcessResult[]) {
  const argv: string[][] = [];
  const diagnose = { diagnose: vi.fn() };
  const answer = vi.fn(async () => "Postgres");
  const budget = createRlmExecutionBudget(4);
  return {
    argv,
    diagnose,
    answer,
    budget,
    input: {
      profile: COPILOT_PROFILE,
      prompt: "Implement the storage service.",
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxAttempts: 4,
      executionBudget: budget,
      answer,
      diagnose,
      runProcess: async (input: { argv: readonly string[] }) => {
        argv.push([...input.argv]);
        const result = results.shift();
        if (!result) throw new Error("unexpected extra process attempt");
        return result;
      },
    },
  };
}

describe("runTrellageHeadlessLoop", () => {
  it("answers the envelope before diagnosis and resumes the same session on a new budget unit", async () => {
    const question =
      '<trellage_questions version="1">\n{"questions":[{"id":"database","text":"Which database?","choices":["Postgres","SQLite"]}]}\n</trellage_questions>';
    const setup = loopInput([
      copilotResult(question),
      copilotResult("Implemented storage service."),
    ]);
    setup.diagnose.diagnose.mockResolvedValue({
      outcome: TrellageTurnOutcome.ACHIEVED,
      summary: "The task is complete.",
    });

    const result = await runTrellageHeadlessLoop(setup.input);

    expect(result.outcome).toBe(TrellageOutcome.Completed);
    expect(result.userInputs).toEqual([{ question: "Which database?", answer: "Postgres" }]);
    expect(setup.diagnose.diagnose).toHaveBeenCalledTimes(1);
    expect(setup.diagnose.diagnose).toHaveBeenCalledWith(
      expect.objectContaining({ originalGoal: "Implement the storage service." }),
    );
    expect(setup.argv[1]).toEqual(expect.arrayContaining(["--resume", "session-1"]));
    expect(setup.argv[1]?.join(" ")).toContain('<trellage_answers version="1">');
    expect(setup.budget.usedCalls).toBe(2);
    expect(result.resumeCount).toBe(1);
    expect(result.toolUsesTruncated).toBe(false);
  });

  it("aggregates bounded normalized evidence across clarification and resume attempts", async () => {
    const question =
      '<trellage_questions version="1">\n{"questions":[{"id":"database","text":"Which database?"}]}\n</trellage_questions>';
    const results = [
      claudeResult(question, {
        usage: {
          input_tokens: 10,
          outputTokens: 2,
          cache_read_input_tokens: 3,
          total_tokens: 12,
        },
        costUsd: 1,
        premiumRequests: 1,
        durationMs: 100,
        changedFiles: ["src/a.ts"],
        toolUses: [
          { type: "tool_use", name: "Skill", input: { skill: "vitest", prompt: "private" } },
          { type: "tool_use", name: "Skill", input: { skill: "vitest" } },
          {
            type: "tool_use",
            name: "Agent",
            input: { subagent_type: "member", description: "private" },
          },
        ],
      }),
      claudeResult("Implemented storage service.", {
        usage: {
          promptTokens: 20,
          completion_tokens: 4,
          cacheCreationInputTokens: 5,
          totalTokens: 24,
        },
        costUsd: 2,
        premiumRequests: 2,
        durationMs: 200,
        changedFiles: ["src/a.ts", "src/b.ts"],
        toolUses: [
          { type: "tool_use", name: "Skill", input: { skill: "vitest" } },
          { type: "tool_use", name: "Bash", input: { command: "private" } },
        ],
      }),
    ];
    const diagnose = { diagnose: vi.fn() };
    diagnose.diagnose.mockResolvedValue({
      outcome: TrellageTurnOutcome.ACHIEVED,
      summary: "The task is complete.",
    });

    const result = await runTrellageHeadlessLoop({
      profile: CLAUDE_PROFILE,
      prompt: "Implement the storage service.",
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxAttempts: 2,
      executionBudget: createRlmExecutionBudget(2),
      answer: async () => "Postgres",
      diagnose,
      runProcess: async () => {
        const next = results.shift();
        if (!next) throw new Error("unexpected extra process attempt");
        return next;
      },
    });

    expect(result).toMatchObject({
      outcome: TrellageOutcome.Completed,
      tokenUsage: {
        inputTokens: 30,
        outputTokens: 6,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 5,
        totalTokens: 36,
      },
      costUsd: 3,
      premiumRequests: 3,
      durationMs: 300,
      changedFiles: ["src/a.ts", "src/b.ts"],
      permissionDenials: [],
      toolUses: [
        { name: "Skill", selector: "vitest", count: 3 },
        { name: "Agent", selector: "member", count: 1 },
        { name: "Bash", count: 1 },
      ],
      toolUsesTruncated: false,
    });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.stdout).toContain('"prompt":"private"');
  });

  it("retains aggregate permission denials on a resumed failure", async () => {
    const question =
      '<trellage_questions version="1">\n{"questions":[{"id":"database","text":"Which database?"}]}\n</trellage_questions>';
    const results = [
      claudeResult(question, { durationMs: 100 }),
      claudeResult("Blocked.", {
        durationMs: 200,
        permissionDenials: ["Write(src/storage.ts)"],
      }),
    ];

    const result = await runTrellageHeadlessLoop({
      profile: CLAUDE_PROFILE,
      prompt: "Implement the storage service.",
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxAttempts: 2,
      executionBudget: createRlmExecutionBudget(2),
      answer: async () => "Postgres",
      diagnose: { diagnose: vi.fn() },
      runProcess: async () => {
        const next = results.shift();
        if (!next) throw new Error("unexpected extra process attempt");
        return next;
      },
    });

    expect(result.outcome).toBe(TrellageOutcome.Unclassifiable);
    expect(result.permissionDenials).toEqual(["Write(src/storage.ts)"]);
    expect(result.durationMs).toBe(300);
  });

  it("does not treat a Copilot success boolean as goal achievement", async () => {
    const setup = loopInput([copilotResult("I need a database decision but cannot continue.")]);
    setup.diagnose.diagnose.mockResolvedValue({
      outcome: TrellageTurnOutcome.NEEDS_INFORMATION,
      summary: "The database decision is missing.",
    });

    const result = await runTrellageHeadlessLoop(setup.input);

    expect(result.outcome).toBe(TrellageOutcome.Unclassifiable);
    expect(result.evidence).toContain("NEEDS_INFORMATION");
    expect(setup.budget.usedCalls).toBe(1);
  });

  it("fails repeated unresolved questions rather than re-answering indefinitely", async () => {
    const question =
      '<trellage_questions version="1">\n{"questions":[{"id":"database","text":"Which database?"}]}\n</trellage_questions>';
    const setup = loopInput([copilotResult(question), copilotResult(question)]);

    const result = await runTrellageHeadlessLoop(setup.input);

    expect(result.outcome).toBe(TrellageOutcome.Unclassifiable);
    expect(result.evidence).toContain("repeated unresolved");
    expect(setup.answer).toHaveBeenCalledTimes(1);
    expect(setup.diagnose.diagnose).not.toHaveBeenCalled();
    expect(setup.budget.usedCalls).toBe(2);
  });

  it("fails when a resumed completion does not preserve the original session ID", async () => {
    const question =
      '<trellage_questions version="1">\n{"questions":[{"id":"database","text":"Which database?"}]}\n</trellage_questions>';
    const setup = loopInput([
      copilotResult(question, "session-1"),
      copilotResult("Implemented storage service.", "session-2"),
    ]);

    const result = await runTrellageHeadlessLoop(setup.input);

    expect(result.outcome).toBe(TrellageOutcome.Unclassifiable);
    expect(result.evidence).toContain("did not preserve its session ID");
    expect(setup.diagnose.diagnose).not.toHaveBeenCalled();
  });

  it("fails malformed envelopes before semantic diagnosis", async () => {
    const setup = loopInput([
      copilotResult(
        '<trellage_questions version="1">{"questions":[{"id":"q1","text":""}]}</trellage_questions>',
      ),
    ]);

    const result = await runTrellageHeadlessLoop(setup.input);

    expect(result.outcome).toBe(TrellageOutcome.Unclassifiable);
    expect(setup.diagnose.diagnose).not.toHaveBeenCalled();
  });

  it("resumes OMP Copilot with the initial session ID", async () => {
    const question =
      '<trellage_questions version="1">\n{"questions":[{"id":"database","text":"Which database?"}]}\n</trellage_questions>';
    const results = [ompCopilotResult(question), ompCopilotResult("Implemented storage service.")];
    const argv: string[][] = [];
    const diagnose = { diagnose: vi.fn() };
    diagnose.diagnose.mockResolvedValue({
      outcome: TrellageTurnOutcome.ACHIEVED,
      summary: "The task is complete.",
    });

    const result = await runTrellageHeadlessLoop({
      profile: OMP_COPILOT_PROFILE,
      prompt: "Implement the storage service.",
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxAttempts: 2,
      executionBudget: createRlmExecutionBudget(2),
      answer: async () => "Postgres",
      diagnose,
      runProcess: async (input) => {
        argv.push([...input.argv]);
        const next = results.shift();
        if (!next) throw new Error("unexpected extra process attempt");
        return next;
      },
    });

    expect(result.outcome).toBe(TrellageOutcome.Completed);
    expect(result.lastResult?.sessionId).toBe("omp-session-1");
    expect(argv[0]).not.toContain("--resume=omp-session-1");
    expect(argv[1]).toContain("--resume=omp-session-1");
    expect(argv[1]?.join(" ")).toContain('<trellage_answers version="1">');
  });

  it("fails immediately when OMP exits non-zero", async () => {
    const processResult = { ...ompCopilotResult("This must not be accepted."), exitCode: 1 };
    const diagnose = { diagnose: vi.fn() };

    const result = await runTrellageHeadlessLoop({
      profile: OMP_COPILOT_PROFILE,
      prompt: "Implement the storage service.",
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxAttempts: 2,
      executionBudget: createRlmExecutionBudget(2),
      answer: async () => "Postgres",
      diagnose,
      runProcess: async () => processResult,
    });

    expect(result.outcome).toBe(TrellageOutcome.Exited);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.result).toBeUndefined();
    expect(diagnose.diagnose).not.toHaveBeenCalled();
  });
});
