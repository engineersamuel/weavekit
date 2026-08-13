import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HerdrAgentStatus } from "../../../src/herdr/contracts.js";
import {
  TRELLAGE_EXITED_STATUS,
  type TrellageBackend,
  type TrellageSession,
} from "../../../src/rlm-poc/trellage/backend.js";
import { TrellageOutcome } from "../../../src/rlm-poc/trellage/contracts.js";
import { runTrellageDriveLoop } from "../../../src/rlm-poc/trellage/driveLoop.js";
import {
  buildDelegatedPrompt,
  prepareResultLocation,
  resolveResultLocation,
  type TrellageResultLocation,
} from "../../../src/rlm-poc/trellage/result.js";

const SESSION: TrellageSession = { agentId: "pane-1", paneId: "pane-1", tabId: "tab-1" };

/**
 * Scripted stand-in for a real harness pane.
 *
 * Container mode cannot run without a TTY, so the backend seam is the only way to exercise the
 * drive loop's classification rules deterministically.
 */
type Step = {
  status: string;
  screen?: string;
  /** Runs when the loop observes this step, letting a step write the result file. */
  effect?: () => Promise<void> | void;
};

function createFakeBackend(steps: Step[]) {
  const prompts: string[] = [];
  const keys: string[][] = [];
  // `observed` is the step the loop last saw, so `read`/`status` reflect that step rather than the
  // one that comes next.
  let observed = 0;
  let next = 0;
  const current = (): Step => steps[Math.min(observed, steps.length - 1)]!;
  const backend: TrellageBackend = {
    launch: async () => SESSION,
    prompt: async (_session, text) => {
      prompts.push(text);
    },
    waitForState: async () => {
      observed = Math.min(next, steps.length - 1);
      next = observed + 1;
      const step = current();
      await step.effect?.();
      return step.status;
    },
    status: async () => current().status,
    read: async () => current().screen ?? "",
    sendKeys: async (_session, sent) => {
      keys.push(sent);
    },
    dispose: async () => undefined,
  };
  return { backend, prompts, keys };
}

let location: TrellageResultLocation;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "trellage-drive-"));
  location = resolveResultLocation(root, "run-1", "call-1");
  await prepareResultLocation(location);
});

const baseOptions = () => ({
  location,
  prompt: "do the thing",
  timeoutMs: 60_000,
  maxTurns: 5,
  sleep: async () => undefined,
});

describe("runTrellageDriveLoop", () => {
  it("completes when the harness settles and the result file exists", async () => {
    const { backend, prompts } = createFakeBackend([
      { status: HerdrAgentStatus.Idle },
      {
        status: HerdrAgentStatus.Idle,
        effect: () => writeFile(location.absolutePath, "the answer"),
      },
    ]);

    const result = await runTrellageDriveLoop({
      ...baseOptions(),
      backend,
      session: SESSION,
      answer: vi.fn(),
    });

    expect(result.outcome).toBe(TrellageOutcome.Completed);
    expect(result.text).toBe("the answer");
    expect(prompts).toEqual(["do the thing"]);
  });

  it("approves an unambiguous permission dialog without consulting the submind", async () => {
    const answer = vi.fn();
    const { backend, keys } = createFakeBackend([
      { status: HerdrAgentStatus.Idle },
      {
        status: HerdrAgentStatus.Blocked,
        screen: "Do you want to proceed?\n❯ 1. No, exit\n  2. Yes, I accept",
      },
      {
        status: HerdrAgentStatus.Idle,
        effect: () => writeFile(location.absolutePath, "done"),
      },
    ]);

    const result = await runTrellageDriveLoop({
      ...baseOptions(),
      backend,
      session: SESSION,
      answer,
    });

    expect(result.outcome).toBe(TrellageOutcome.Completed);
    expect(keys).toEqual([["down", "enter"]]);
    expect(answer).not.toHaveBeenCalled();
  });

  it("asks the submind to choose when no option is unambiguously affirmative", async () => {
    const answer = vi.fn(async () => "2");
    const { backend, keys } = createFakeBackend([
      { status: HerdrAgentStatus.Idle },
      {
        status: HerdrAgentStatus.Blocked,
        screen: "❯ 1. Rebase onto main\n  2. Merge main in\n  3. Cancel",
      },
      {
        status: HerdrAgentStatus.Idle,
        effect: () => writeFile(location.absolutePath, "merged"),
      },
    ]);

    const result = await runTrellageDriveLoop({
      ...baseOptions(),
      backend,
      session: SESSION,
      answer,
    });

    expect(answer).toHaveBeenCalledOnce();
    expect(keys).toEqual([["down", "enter"]]);
    expect(result.userInputs).toHaveLength(1);
    expect(result.outcome).toBe(TrellageOutcome.Completed);
  });

  it("answers a prose question that settled to idle without a result file", async () => {
    const answer = vi.fn(async () => "use Postgres");
    const { backend, prompts, keys } = createFakeBackend([
      { status: HerdrAgentStatus.Idle },
      { status: HerdrAgentStatus.Idle, screen: "Which database should I use?" },
      // The screen survives the loop's Enter nudge, proving the harness really is waiting on us.
      { status: HerdrAgentStatus.Idle, screen: "Which database should I use?" },
      {
        status: HerdrAgentStatus.Idle,
        effect: () => writeFile(location.absolutePath, "scaffolded"),
      },
    ]);

    const result = await runTrellageDriveLoop({
      ...baseOptions(),
      backend,
      session: SESSION,
      answer,
    });

    expect(keys).toEqual([["enter"]]);
    expect(answer).toHaveBeenCalledWith("Which database should I use?");
    expect(prompts).toEqual(["do the thing", "use Postgres"]);
    expect(result.outcome).toBe(TrellageOutcome.Completed);
    expect(result.userInputs).toEqual([
      { question: "Which database should I use?", answer: "use Postgres" },
    ]);
  });

  it("fails closed on an unclassifiable state rather than reporting success", async () => {
    const { backend } = createFakeBackend([
      { status: HerdrAgentStatus.Idle },
      { status: HerdrAgentStatus.Unknown, screen: "garbled" },
    ]);

    const result = await runTrellageDriveLoop({
      ...baseOptions(),
      backend,
      session: SESSION,
      answer: vi.fn(),
    });

    expect(result.outcome).toBe(TrellageOutcome.Unclassifiable);
    expect(result.evidence).toBe("garbled");
  });

  it("reports an exited harness as failed when it produced no result", async () => {
    const { backend } = createFakeBackend([
      { status: HerdrAgentStatus.Idle },
      { status: TRELLAGE_EXITED_STATUS, screen: "command not found: trellage" },
    ]);

    const result = await runTrellageDriveLoop({
      ...baseOptions(),
      backend,
      session: SESSION,
      answer: vi.fn(),
    });

    expect(result.outcome).toBe(TrellageOutcome.Exited);
    expect(result.text).toContain("command not found");
  });

  it("keeps a result file written just before the harness exited", async () => {
    const { backend } = createFakeBackend([
      { status: HerdrAgentStatus.Idle },
      {
        status: TRELLAGE_EXITED_STATUS,
        effect: () => writeFile(location.absolutePath, "finished then quit"),
      },
    ]);

    const result = await runTrellageDriveLoop({
      ...baseOptions(),
      backend,
      session: SESSION,
      answer: vi.fn(),
    });

    expect(result.outcome).toBe(TrellageOutcome.Completed);
    expect(result.text).toBe("finished then quit");
  });

  it("stops asking once the turn cap is reached", async () => {
    const answer = vi.fn(async () => "keep going");
    const { backend } = createFakeBackend([
      { status: HerdrAgentStatus.Idle },
      { status: HerdrAgentStatus.Idle, screen: "another question?" },
    ]);

    const result = await runTrellageDriveLoop({
      ...baseOptions(),
      backend,
      session: SESSION,
      answer,
      maxTurns: 2,
    });

    expect(result.outcome).toBe(TrellageOutcome.TurnLimit);
    expect(result.turns).toBe(2);
  });

  it("gives up when the harness never becomes ready", async () => {
    const { backend } = createFakeBackend([{ status: HerdrAgentStatus.Working }]);

    await expect(
      runTrellageDriveLoop({
        ...baseOptions(),
        backend,
        session: SESSION,
        answer: vi.fn(),
        timeoutMs: 0,
      }),
    ).rejects.toThrow(/ready to accept a prompt/u);
  });
});

describe("result contract", () => {
  it("tells the harness a worktree-relative path, because containers remap absolute paths", () => {
    const prompt = buildDelegatedPrompt("build it", location);

    expect(prompt).toContain(".weavekit/rlm-trellage/run-1/call-1/result.md");
    expect(prompt).not.toContain(location.absolutePath);
  });

  it("clears a stale result file so it cannot be read as this run's answer", async () => {
    await writeFile(location.absolutePath, "stale");
    await prepareResultLocation(location);

    await expect(readFile(location.absolutePath, "utf8")).rejects.toThrow();
  });
});

describe("runTrellageDriveLoop quiescence", () => {
  /**
   * Herdr reports Claude Code as `idle` while it is still thinking, so lifecycle state alone made
   * an in-progress turn look like a prose question and the loop typed an answer into it.
   */
  it("keeps waiting while a settled harness is still repainting its screen", async () => {
    const answer = vi.fn(async () => "should not be asked");
    let reads = 0;
    const backend: TrellageBackend = {
      launch: async () => SESSION,
      prompt: async () => undefined,
      waitForState: async () => HerdrAgentStatus.Idle,
      status: async () => HerdrAgentStatus.Idle,
      read: async () => {
        reads += 1;
        if (reads >= 8) {
          await writeFile(location.absolutePath, "finished at last");
          return "done";
        }
        return `✶ Thinking… (${reads}s)`;
      },
      sendKeys: async () => undefined,
      dispose: async () => undefined,
    };

    const result = await runTrellageDriveLoop({
      ...baseOptions(),
      backend,
      session: SESSION,
      answer,
    });

    expect(result.outcome).toBe(TrellageOutcome.Completed);
    expect(result.text).toBe("finished at last");
    expect(answer).not.toHaveBeenCalled();
  });

  it("treats a settled harness with a still screen and no result as a question", async () => {
    const answer = vi.fn(async (_question: string, _choices?: string[]) => "here is your answer");
    const prompts: string[] = [];
    let answered = false;
    const backend: TrellageBackend = {
      launch: async () => SESSION,
      prompt: async (_session, text) => {
        prompts.push(text);
        if (answered) await writeFile(location.absolutePath, "done after answering");
      },
      waitForState: async () => HerdrAgentStatus.Idle,
      status: async () => HerdrAgentStatus.Idle,
      read: async () => "Which database should I use?",
      sendKeys: async () => undefined,
      dispose: async () => undefined,
    };

    const result = await runTrellageDriveLoop({
      ...baseOptions(),
      backend,
      session: SESSION,
      answer: async (question, choices) => {
        answered = true;
        return answer(question, choices);
      },
    });

    expect(answer).toHaveBeenCalledTimes(1);
    expect(prompts).toEqual(["do the thing", "here is your answer"]);
    expect(result.outcome).toBe(TrellageOutcome.Completed);
    expect(result.userInputs).toHaveLength(1);
  });
});

describe("runTrellageDriveLoop prompt submission", () => {
  /**
   * Copilot CLI collapses a multi-line prompt into a `[Paste #1]` block that needs a second Enter,
   * so the turn never started and the untouched screen was escalated to the submind as a question.
   */
  it("presses enter once before deciding an unchanged screen is a question", async () => {
    const answer = vi.fn(async () => "should not be asked");
    const keys: string[][] = [];
    let submitted = false;
    const backend: TrellageBackend = {
      launch: async () => SESSION,
      prompt: async () => undefined,
      waitForState: async () => HerdrAgentStatus.Idle,
      status: async () => HerdrAgentStatus.Idle,
      read: async () => (submitted ? "working on it" : "❯ [Paste #1 - 14 lines]"),
      sendKeys: async (_session, sent) => {
        keys.push(sent);
        submitted = true;
        await writeFile(location.absolutePath, "submitted and finished");
      },
      dispose: async () => undefined,
    };

    const result = await runTrellageDriveLoop({
      ...baseOptions(),
      backend,
      session: SESSION,
      answer,
    });

    expect(keys).toEqual([["enter"]]);
    expect(result.outcome).toBe(TrellageOutcome.Completed);
    expect(result.text).toBe("submitted and finished");
    expect(answer).not.toHaveBeenCalled();
  });

  it("keeps waiting when the stable screen is only the submitted prompt echo", async () => {
    const answer = vi.fn(async () => "should not be asked");
    let reads = 0;
    const backend: TrellageBackend = {
      launch: async () => SESSION,
      prompt: async () => undefined,
      waitForState: async () => HerdrAgentStatus.Idle,
      status: async () => HerdrAgentStatus.Idle,
      read: async () => {
        reads += 1;
        if (reads >= 30) {
          await writeFile(location.absolutePath, "finished after startup");
        }
        return [
          "❯ Read the file .weavekit/rlm-trellage/run/call/task.md and carry out the task described in it.",
          "⏵⏵ bypass permissions on (shift+tab to cycle)",
          "Update available! Run: mise upgrade claude",
        ].join("\n");
      },
      sendKeys: async () => undefined,
      dispose: async () => undefined,
    };

    const result = await runTrellageDriveLoop({
      ...baseOptions(),
      backend,
      session: SESSION,
      answer,
    });

    expect(result.outcome).toBe(TrellageOutcome.Completed);
    expect(result.text).toBe("finished after startup");
    expect(answer).not.toHaveBeenCalled();
  });
});
