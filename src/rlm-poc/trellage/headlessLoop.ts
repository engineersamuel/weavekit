import { claimRlmExecutionBudget, snapshotRlmExecutionBudget } from "../budget.js";
import { writeRlmOutput } from "../environment.js";
import { TrellageTurnOutcome } from "../../generated/baml_client/index.js";
import { headlessAdapterFor } from "./adapters/index.js";
import { buildHeadlessTrellageCommand } from "./catalog.js";
import {
  TrellageHeadlessTerminal,
  TrellageOutcome,
  type TrellageHeadlessAttempt,
  type TrellageHeadlessResult,
  type TrellageProfile,
  type TrellageUserInputExchange,
} from "./contracts.js";
import type { TrellageTurnDiagnoser } from "./diagnosis.js";
import type { TrellageAnswerer } from "./driveLoop.js";
import type { TrellageProcessInput, TrellageProcessResult } from "./headlessRunner.js";
import {
  buildTrellageHeadlessPrompt,
  formatTrellageAnswers,
  parseTrellageQuestions,
} from "./questionProtocol.js";
import type { RlmExecutionBudget } from "../budget.js";

export type TrellageHeadlessLoopInput = {
  profile: TrellageProfile;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  maxAttempts: number;
  executionBudget: RlmExecutionBudget;
  answer: TrellageAnswerer;
  diagnose: TrellageTurnDiagnoser;
  model?: string;
  effort?: string;
  autopilot?: boolean;
  maxAutopilotContinues?: number;
  signal?: AbortSignal;
  runProcess(input: TrellageProcessInput, attempt: number): Promise<TrellageProcessResult>;
};

export type TrellageHeadlessLoopResult = {
  text: string;
  outcome: TrellageOutcome;
  turns: number;
  userInputs: TrellageUserInputExchange[];
  attempts: TrellageHeadlessAttempt[];
  evidence?: string;
  questionCount: number;
  resumeCount: number;
  lastResult?: TrellageHeadlessResult;
};

/**
 * Runs a bounded native session, resumes the same session after structured clarification, and
 * only declares success after BAML diagnoses the original goal as achieved.
 */
export async function runTrellageHeadlessLoop(
  input: TrellageHeadlessLoopInput,
): Promise<TrellageHeadlessLoopResult> {
  const adapter = headlessAdapterFor(input.profile);
  const attempts: TrellageHeadlessAttempt[] = [];
  const userInputs: TrellageUserInputExchange[] = [];
  const seenQuestions = new Set<string>();
  let resumeSessionId: string | undefined;
  let prompt = buildTrellageHeadlessPrompt(input.prompt);
  let questionCount = 0;
  let resumeCount = 0;
  let lastResult: TrellageHeadlessResult | undefined;

  for (let number = 1; number <= input.maxAttempts; number += 1) {
    claimRlmExecutionBudget(input.executionBudget);
    const argv = buildHeadlessTrellageCommand(input.profile, {
      prompt,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.autopilot ? { autopilot: input.autopilot } : {}),
      ...(input.maxAutopilotContinues !== undefined
        ? { maxAutopilotContinues: input.maxAutopilotContinues }
        : {}),
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
    let process: TrellageProcessResult;
    try {
      process = await input.runProcess(
        {
          argv,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          ...(input.signal ? { signal: input.signal } : {}),
        },
        number,
      );
    } catch (error) {
      return failure(
        TrellageOutcome.Exited,
        "",
        attempts,
        userInputs,
        questionCount,
        resumeCount,
        `Headless launcher failed to start: ${error instanceof Error ? error.message : String(error)}`,
        lastResult,
      );
    }

    if (process.timedOut) {
      attempts.push(toAttempt(number, process));
      return failure(
        TrellageOutcome.Timeout,
        "",
        attempts,
        userInputs,
        questionCount,
        resumeCount,
        "Headless launcher timed out.",
        lastResult,
      );
    }
    if (process.cancelled) {
      attempts.push(toAttempt(number, process));
      return failure(
        TrellageOutcome.Exited,
        "",
        attempts,
        userInputs,
        questionCount,
        resumeCount,
        "Headless launcher was cancelled.",
        lastResult,
      );
    }
    if (process.exitCode !== 0 || process.signal) {
      attempts.push(toAttempt(number, process));
      return failure(
        TrellageOutcome.Exited,
        "",
        attempts,
        userInputs,
        questionCount,
        resumeCount,
        `Headless launcher exited with code ${String(process.exitCode)} and signal ${String(process.signal)}.`,
        lastResult,
      );
    }

    const result = adapter.parse(process);
    lastResult = result;
    attempts.push(toAttempt(number, process, result));
    if (resumeSessionId && result.sessionId !== resumeSessionId) {
      return failure(
        TrellageOutcome.Unclassifiable,
        result.finalText ?? "",
        attempts,
        userInputs,
        questionCount,
        resumeCount,
        "A resumed headless attempt did not preserve its session ID.",
        result,
      );
    }
    if (result.terminal !== TrellageHeadlessTerminal.Completed) {
      return failure(
        TrellageOutcome.Unclassifiable,
        result.finalText ?? "",
        attempts,
        userInputs,
        questionCount,
        resumeCount,
        result.harnessError ?? "Headless harness did not produce a successful terminal result.",
        result,
      );
    }
    if (result.permissionDenials.length > 0) {
      return failure(
        TrellageOutcome.Unclassifiable,
        result.finalText ?? "",
        attempts,
        userInputs,
        questionCount,
        resumeCount,
        `Headless harness was blocked by permission denials: ${result.permissionDenials.join(", ")}.`,
        result,
      );
    }

    const questionParse = parseTrellageQuestions(result.finalText ?? "");
    if (questionParse.kind === "malformed") {
      return failure(
        TrellageOutcome.Unclassifiable,
        result.finalText ?? "",
        attempts,
        userInputs,
        questionCount,
        resumeCount,
        questionParse.error,
        result,
      );
    }
    if (questionParse.kind === "questions") {
      if (!result.sessionId) {
        return failure(
          TrellageOutcome.Unclassifiable,
          result.finalText ?? "",
          attempts,
          userInputs,
          questionCount,
          resumeCount,
          "A clarification result did not provide a resumable session ID.",
          result,
        );
      }
      const answers: Array<{ id: string; answer: string }> = [];
      for (const question of questionParse.questions) {
        const questionKey = normalizedQuestionKey(question.text, question.choices);
        if (seenQuestions.has(questionKey)) {
          return failure(
            TrellageOutcome.Unclassifiable,
            result.finalText ?? "",
            attempts,
            userInputs,
            questionCount,
            resumeCount,
            `The harness repeated unresolved clarification "${question.id}".`,
            result,
          );
        }
        seenQuestions.add(questionKey);
        let answer: string;
        try {
          answer = await input.answer(question.text, question.choices);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writeRlmOutput(`\n[trellage] clarification answer failed: ${message}\n`);
          return failure(
            TrellageOutcome.Unclassifiable,
            result.finalText ?? "",
            attempts,
            userInputs,
            questionCount,
            resumeCount,
            `Root-grounded question answer failed: ${message}`,
            result,
          );
        }
        userInputs.push({ question: question.text, answer });
        answers.push({ id: question.id, answer });
      }
      questionCount += questionParse.questions.length;
      resumeSessionId = result.sessionId;
      resumeCount += 1;
      prompt = formatTrellageAnswers(answers);
      continue;
    }

    try {
      const diagnosis = await input.diagnose.diagnose({
        originalGoal: input.prompt,
        result,
      });
      if (diagnosis.outcome === TrellageTurnOutcome.ACHIEVED) {
        return {
          text: result.finalText ?? diagnosis.summary,
          outcome: TrellageOutcome.Completed,
          turns: attempts.length,
          userInputs,
          attempts,
          questionCount,
          resumeCount,
          lastResult: result,
        };
      }
      return failure(
        TrellageOutcome.Unclassifiable,
        result.finalText ?? "",
        attempts,
        userInputs,
        questionCount,
        resumeCount,
        `Goal diagnosis was ${diagnosis.outcome}: ${diagnosis.summary}`,
        result,
      );
    } catch (error) {
      return failure(
        TrellageOutcome.Unclassifiable,
        result.finalText ?? "",
        attempts,
        userInputs,
        questionCount,
        resumeCount,
        `Goal diagnosis failed: ${error instanceof Error ? error.message : String(error)}`,
        result,
      );
    }
  }

  return failure(
    TrellageOutcome.TurnLimit,
    lastResult?.finalText ?? "",
    attempts,
    userInputs,
    questionCount,
    resumeCount,
    `Headless attempt limit reached; budget ${JSON.stringify(snapshotRlmExecutionBudget(input.executionBudget))}.`,
    lastResult,
  );
}

function toAttempt(
  number: number,
  process: TrellageProcessResult,
  result?: TrellageHeadlessResult,
): TrellageHeadlessAttempt {
  return {
    number,
    argv: [...process.argv],
    exitCode: process.exitCode,
    signal: process.signal,
    timedOut: process.timedOut,
    cancelled: process.cancelled,
    stdout: process.stdout,
    stderr: process.stderr,
    ...(result ? { result } : {}),
  };
}

function failure(
  outcome: TrellageOutcome,
  text: string,
  attempts: TrellageHeadlessAttempt[],
  userInputs: TrellageUserInputExchange[],
  questionCount: number,
  resumeCount: number,
  evidence: string,
  lastResult?: TrellageHeadlessResult,
): TrellageHeadlessLoopResult {
  return {
    text,
    outcome,
    turns: attempts.length,
    userInputs,
    attempts,
    evidence,
    questionCount,
    resumeCount,
    ...(lastResult ? { lastResult } : {}),
  };
}

function normalizedQuestionKey(question: string, choices?: readonly string[]): string {
  return `${question.toLowerCase().replace(/\s+/gu, " ").trim()}\u0000${(choices ?? [])
    .map((choice) => choice.toLowerCase().replace(/\s+/gu, " ").trim())
    .join("\u0000")}`;
}
