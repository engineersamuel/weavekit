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
    expect(setup.argv[1]).toEqual(expect.arrayContaining(["--resume", "session-1"]));
    expect(setup.argv[1]?.join(" ")).toContain('<trellage_answers version="1">');
    expect(setup.budget.usedCalls).toBe(2);
    expect(result.resumeCount).toBe(1);
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
