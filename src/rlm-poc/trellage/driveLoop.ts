import { setTimeout as delay } from "node:timers/promises";
import { HerdrAgentStatus } from "../../herdr/contracts.js";
import { HerdrReadSource } from "../../herdr/scope.js";
import { TRELLAGE_EXITED_STATUS, type TrellageBackend, type TrellageSession } from "./backend.js";
import {
  TrellageOutcome,
  type TrellageTransition,
  type TrellageUserInputExchange,
} from "./contracts.js";
import { readResult, toSingleLine, type TrellageResultLocation } from "./result.js";
import {
  TrellageScreenKind,
  classifyScreen,
  extractQuestion,
  findApprovalOption,
  findOptionByNumber,
  isLikelyQuestion,
  keysToChoose,
} from "./screen.js";

/** States that mean "the harness is not currently producing output". */
const SETTLED: readonly string[] = [
  HerdrAgentStatus.Idle,
  HerdrAgentStatus.Done,
  HerdrAgentStatus.Blocked,
  HerdrAgentStatus.Unknown,
];

const WAIT_SLICE_MS = 60_000;
const SETTLE_GRACE_MS = 1_500;
const QUIESCENCE_POLL_MS = 500;
/** Consecutive unchanged screens required before a settled harness is believed to be waiting. */
const QUIESCENCE_SAMPLES = 3;
/** Upper bound on quiescence sampling, so a screen with a permanent animation cannot hang the loop. */
const QUIESCENCE_MAX_SAMPLES = 40;
/** Maximum Enter nudges to submit one visibly stuck prompt before treating the screen as a question. */
const PROMPT_NUDGE_LIMIT = 3;

export type TrellageAnswerer = (question: string, choices?: string[]) => Promise<string>;

export type DriveLoopOptions = {
  backend: TrellageBackend;
  session: TrellageSession;
  location: TrellageResultLocation;
  /** Full prompt, including the result-file contract, sent to open the delegated turn. */
  prompt: string;
  /** Answers questions the harness asks, on behalf of the root Submind. */
  answer: TrellageAnswerer;
  /** Hard wall-clock ceiling for the whole invocation. */
  timeoutMs: number;
  /** Maximum answer/re-prompt cycles before giving up. */
  maxTurns: number;
  onTransition?: (transition: TrellageTransition) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type DriveLoopResult = {
  outcome: TrellageOutcome;
  text: string;
  turns: number;
  userInputs: TrellageUserInputExchange[];
  transitions: TrellageTransition[];
  evidence?: string;
};

/**
 * Runs a delegated harness turn to completion.
 *
 * The loop exists because no single Herdr signal means "done". `agent.wait` reports lifecycle
 * state, not turn boundaries, and `blocked` only fires for *structured* UI — a harness that asks a
 * question in prose settles to `idle`, exactly like one that finished. So the loop treats lifecycle
 * state as a trigger to *inspect*, and the result file as the only proof of completion: settled
 * with a result file means done; settled without one means the harness is waiting on us.
 */
export async function runTrellageDriveLoop(options: DriveLoopOptions): Promise<DriveLoopResult> {
  const { backend, session, location, answer, maxTurns, onTransition } = options;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const deadline = Date.now() + options.timeoutMs;
  const transitions: TrellageTransition[] = [];
  const userInputs: TrellageUserInputExchange[] = [];
  let turns = 0;

  const record = (status: string, note?: string): void => {
    const transition: TrellageTransition = {
      status,
      at: new Date().toISOString(),
      ...(note === undefined ? {} : { note }),
    };
    transitions.push(transition);
    onTransition?.(transition);
  };

  const finish = async (outcome: TrellageOutcome, note: string): Promise<DriveLoopResult> => {
    const result = await readResult(location);
    const evidence = await readEvidence(backend, session);
    record(outcome, note);
    return {
      // A result file written just before a timeout or exit still represents completed work, so it
      // is preferred over the failure text regardless of how the loop ended.
      outcome: result ? TrellageOutcome.Completed : outcome,
      text: result ?? `${note}\n\nLast screen:\n${evidence ?? "(unavailable)"}`,
      turns,
      userInputs,
      transitions,
      ...(result ? {} : { evidence: evidence ?? undefined }),
    };
  };

  await settleStartup({ backend, session, location, answer, userInputs, record, deadline, sleep });

  // Reset whenever text is submitted. Some harnesses need one follow-up Enter after their prompt
  // visibly lands in the composer, so allow a bounded retry while that prompt is still shown.
  let promptNudges = 0;
  await backend.prompt(session, options.prompt);
  turns += 1;
  record("prompted");

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return finish(TrellageOutcome.Timeout, "The harness ran out of time.");

    const status = await observeSettledStatus(backend, session, remainingMs);
    record(status);

    if (status === HerdrAgentStatus.Working) {
      await sleep(SETTLE_GRACE_MS);
      continue;
    }

    if (status === TRELLAGE_EXITED_STATUS) {
      return finish(TrellageOutcome.Exited, "The harness process exited.");
    }

    if (status === HerdrAgentStatus.Blocked) {
      const handled = await handleBlocked({ backend, session, answer, userInputs, record });
      if (handled === BlockedHandling.NotAQuestion) {
        record(HerdrAgentStatus.Working, "blocked screen did not contain a question");
        await sleep(SETTLE_GRACE_MS);
        continue;
      }
      if (handled === BlockedHandling.Unhandled) {
        return finish(
          TrellageOutcome.Unclassifiable,
          "The harness is blocked on a prompt that could not be answered.",
        );
      }
      if (turns >= maxTurns) {
        return finish(TrellageOutcome.TurnLimit, `The harness exceeded ${maxTurns} turns.`);
      }
      promptNudges = 0;
      turns += 1;
      continue;
    }

    // `idle`, `done`, and `unknown` all mean "not producing output" — but Herdr classifies some
    // harnesses as settled while they are still thinking, so lifecycle state alone would make an
    // in-progress turn look like a question. Wait for the screen to actually stop changing, and
    // keep checking for the result file throughout.
    const quiescence = await awaitQuiescence({ backend, session, location, deadline, sleep });
    if (quiescence.result) {
      record(TrellageOutcome.Completed, "result file present");
      return {
        outcome: TrellageOutcome.Completed,
        text: quiescence.result,
        turns,
        userInputs,
        transitions,
      };
    }
    if (!quiescence.stable) {
      // The screen is still moving, so the harness is working regardless of what Herdr reported.
      record(HerdrAgentStatus.Working, "screen still changing");
      continue;
    }

    if (status === HerdrAgentStatus.Unknown) {
      // `unknown` means Herdr can see an agent but cannot classify it, so nothing about the screen
      // can be trusted. With no result file there is no evidence of completion: fail closed.
      return finish(
        TrellageOutcome.Unclassifiable,
        "The harness reached an unclassifiable state without producing a result.",
      );
    }

    const screen = await backend.read(session, { source: HerdrReadSource.Visible, lines: 120 });
    if (shouldNudgePrompt(promptNudges, screen, options.prompt)) {
      // Some harnesses keep a fully composed prompt in the composer even after the first Enter.
      // Retry only while that prompt is still visibly pending, so genuine prose questions are not
      // masked by repeated blank submissions.
      promptNudges += 1;
      await backend.sendKeys(session, ["enter"]);
      record(
        "nudged",
        promptNudges === 1
          ? "re-submitted a prompt the harness had not accepted"
          : "re-submitted a prompt that was still visibly stuck in the composer",
      );
      continue;
    }

    if (turns >= maxTurns) {
      return finish(TrellageOutcome.TurnLimit, `The harness exceeded ${maxTurns} turns.`);
    }

    // Settled with no result file: the harness is asking something in prose, which Herdr cannot
    // distinguish from completion.
    const question = extractQuestion(screen);
    if (!isLikelyQuestion(question)) {
      record(HerdrAgentStatus.Working, "settled screen did not contain a question");
      await sleep(SETTLE_GRACE_MS);
      continue;
    }
    const reply = await answer(question);
    userInputs.push({ question, answer: reply });
    record("answered", "prose question");
    await backend.prompt(session, toSingleLine(reply));
    promptNudges = 0;
    turns += 1;
  }
}

/**
 * Waits for the harness's screen to stop changing, or for the result file to appear.
 *
 * Herdr reports lifecycle state, and at least one harness (Claude Code) is reported as `idle` while
 * it is still thinking. Since a settled state with no result file is otherwise read as "the harness
 * asked something in prose", believing that state too early injects an answer into a turn that is
 * still running. A screen that is still repainting — spinners, elapsed-time counters, streaming
 * text — is proof the harness is busy, and it is the one signal that works across harnesses.
 */
async function awaitQuiescence(input: {
  backend: TrellageBackend;
  session: TrellageSession;
  location: TrellageResultLocation;
  deadline: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<{ stable: boolean; result?: string; screen: string }> {
  const { backend, session, location, deadline, sleep } = input;
  let previous = normalizeScreen(await readScreen(backend, session));
  let unchanged = 0;

  for (let sample = 0; sample < QUIESCENCE_MAX_SAMPLES; sample += 1) {
    const result = await readResult(location);
    if (result) return { stable: true, result, screen: previous };
    if (Date.now() >= deadline) return { stable: true, screen: previous };

    await sleep(QUIESCENCE_POLL_MS);
    const current = normalizeScreen(await readScreen(backend, session));
    unchanged = current === previous ? unchanged + 1 : 0;
    previous = current;
    if (unchanged >= QUIESCENCE_SAMPLES) return { stable: true, screen: current };

    const status = await backend.status(session).catch(() => HerdrAgentStatus.Unknown as string);
    // A move out of the settled set is meaningful on its own; let the main loop re-classify it.
    if (!SETTLED.includes(status)) return { stable: false, screen: current };
  }
  // The screen never settled, but the harness may still be waiting behind a permanent animation,
  // so fall through and let the caller treat it as a question rather than stalling until timeout.
  return { stable: true, screen: previous };
}

async function readScreen(backend: TrellageBackend, session: TrellageSession): Promise<string> {
  return backend.read(session, { source: HerdrReadSource.Visible, lines: 120 }).catch(() => "");
}

/** Drops the whitespace churn a repainting TUI produces so only real content changes register. */
function normalizeScreen(screen: string): string {
  return screen
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+$/u, ""))
    .filter((line) => line.length > 0)
    .join("\n");
}

function shouldNudgePrompt(nudges: number, screen: string, prompt: string): boolean {
  if (nudges === 0) return true;
  if (nudges >= PROMPT_NUDGE_LIMIT) return false;
  return screenShowsSubmittedPrompt(screen, prompt) || !isLikelyQuestion(extractQuestion(screen));
}

function screenShowsSubmittedPrompt(screen: string, prompt: string): boolean {
  const flattenedScreen = flattenForMatch(screen);
  const promptLines = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length >= 24);
  return promptLines.some((line) => flattenedScreen.includes(flattenForMatch(line)));
}

function flattenForMatch(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase();
}

type BlockedHandlerInput = {
  backend: TrellageBackend;
  session: TrellageSession;
  answer: TrellageAnswerer;
  userInputs: TrellageUserInputExchange[];
  record: (status: string, note?: string) => void;
};

const BlockedHandling = {
  Handled: "handled",
  NotAQuestion: "not-a-question",
  Unhandled: "unhandled",
} as const;
type BlockedHandling = (typeof BlockedHandling)[keyof typeof BlockedHandling];

/**
 * Waits out the harness's boot sequence and clears any gate it presents before the first prompt.
 *
 * Some harnesses open with a structured dialog — Claude Code's bypass-permissions confirmation, for
 * example — and typing a task into that dialog would answer it with garbage instead of running the
 * task. Container profiles additionally pay a Docker start here, which is why the wait is bounded
 * only by the invocation's own deadline.
 */
async function settleStartup(input: {
  backend: TrellageBackend;
  session: TrellageSession;
  location: TrellageResultLocation;
  answer: TrellageAnswerer;
  userInputs: TrellageUserInputExchange[];
  record: (status: string, note?: string) => void;
  deadline: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<void> {
  const { backend, session, record, deadline, sleep } = input;
  while (Date.now() < deadline) {
    const status = await observeSettledStatus(backend, session, deadline - Date.now());
    if (status === TRELLAGE_EXITED_STATUS) {
      throw new Error("The harness exited before it was ready to accept a prompt.");
    }
    if (status === HerdrAgentStatus.Working || status === HerdrAgentStatus.Unknown) {
      await sleep(SETTLE_GRACE_MS);
      continue;
    }
    if (status !== HerdrAgentStatus.Blocked) {
      // Ready-looking is not the same as ready: a harness still painting its banner can report
      // `idle`, and prompting into that either loses the text or answers a gate that is about to
      // appear. Only proceed once the screen has actually stopped moving.
      const quiescence = await awaitQuiescence({
        backend,
        session,
        location: input.location,
        deadline,
        sleep,
      });
      if (!quiescence.stable) continue;
      // A startup gate can paint *after* the harness first reports a settled state: Copilot's
      // folder-trust dialog arrives seconds behind its first `idle`, so the screen that finally
      // goes quiet is the dialog itself. Typing the task there answers the dialog with the task
      // text, so clear the gate and re-settle instead of returning.
      if (!isStartupGate(quiescence.screen)) return;
      record("startup-gate");
      const cleared = await handleBlocked(input);
      if (cleared === BlockedHandling.Unhandled) {
        throw new Error("The harness opened with a prompt that could not be answered.");
      }
      await sleep(SETTLE_GRACE_MS);
      continue;
    }
    record("startup-blocked");
    const handled = await handleBlocked(input);
    if (handled === BlockedHandling.NotAQuestion) {
      record(HerdrAgentStatus.Working, "startup blocked screen did not contain a question");
      await sleep(SETTLE_GRACE_MS);
      continue;
    }
    if (handled === BlockedHandling.Unhandled) {
      throw new Error("The harness opened with a prompt that could not be answered.");
    }
    await sleep(SETTLE_GRACE_MS);
  }
  throw new Error("Timed out waiting for the harness to become ready to accept a prompt.");
}

/**
 * True when a quiescent startup screen is a structured gate the harness is waiting on.
 *
 * A numbered list alone is not enough — harnesses list tips and recent sessions at their prompt —
 * so the screen must also be asking something before the loop answers it with keystrokes.
 */
function isStartupGate(screen: string): boolean {
  return (
    classifyScreen(screen).kind === TrellageScreenKind.Menu &&
    isLikelyQuestion(extractQuestion(screen))
  );
}

/**
 * Blocks until the harness stops producing output, reporting the state it landed on.
 *
 * A `agent.wait` that expires is not an error here: the loop owns the real deadline, so an expired
 * slice just means "still working" and the current state is re-read directly.
 */
async function observeSettledStatus(
  backend: TrellageBackend,
  session: TrellageSession,
  remainingMs: number,
): Promise<string> {
  try {
    return await backend.waitForState(session, SETTLED, Math.min(WAIT_SLICE_MS, remainingMs));
  } catch {
    return backend.status(session);
  }
}

async function handleBlocked(input: BlockedHandlerInput): Promise<BlockedHandling> {
  const { backend, session, answer, userInputs, record } = input;
  const detection = await backend
    .read(session, { source: HerdrReadSource.Detection, lines: 120 })
    .catch(() => "");
  const visible = await backend.read(session, {
    source: HerdrReadSource.Visible,
    lines: 120,
  });
  const screen = classifyScreen(detection.trim().length > 0 ? detection : visible);

  if (screen.kind === TrellageScreenKind.Prose) {
    const question = extractQuestion(visible);
    if (!isLikelyQuestion(question)) return BlockedHandling.NotAQuestion;
    const reply = await answer(question);
    userInputs.push({ question, answer: reply });
    record("answered", "blocked prose prompt");
    await backend.prompt(session, toSingleLine(reply));
    return BlockedHandling.Handled;
  }

  const approval = findApprovalOption(screen.options);
  if (approval) {
    // Delegated harnesses run unattended, matching the `approveAll` convention used elsewhere in
    // the prototype: an unambiguous permission prompt is approved without consulting the Submind.
    await backend.sendKeys(session, keysToChoose(screen.options, approval));
    record("approved", `option ${approval.number}: ${approval.label}`);
    return BlockedHandling.Handled;
  }

  // No option is unambiguously affirmative, so the choice is a judgement call. Hand it to the
  // Submind rather than guessing, since several harnesses pre-select a destructive option.
  const question = [
    "A delegated harness is waiting on a choice. Reply with only the number of the option to pick.",
    "",
    extractQuestion(visible),
  ].join("\n");
  const choices = screen.options.map((option) => String(option.number));
  const reply = await answer(question, choices);
  const chosen = findOptionByNumber(screen.options, Number.parseInt(reply.trim(), 10));
  if (!chosen) return BlockedHandling.Unhandled;
  userInputs.push({ question, answer: `${chosen.number}. ${chosen.label}` });
  await backend.sendKeys(session, keysToChoose(screen.options, chosen));
  record("answered", `chose option ${chosen.number}`);
  return BlockedHandling.Handled;
}

async function readEvidence(
  backend: TrellageBackend,
  session: TrellageSession,
): Promise<string | undefined> {
  try {
    const text = await backend.read(session, { source: HerdrReadSource.Visible, lines: 120 });
    return text.trim().length > 0 ? text.trim() : undefined;
  } catch {
    return undefined;
  }
}
