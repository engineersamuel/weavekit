import * as readline from "node:readline/promises";
import { approveAll } from "@github/copilot-sdk";
import type { RlmUserInputExchange } from "./contracts.js";
import { writeRlmOutput } from "./environment.js";
import type { RlmClientFactory, RlmSession } from "./session.js";

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
export const RLM_ASK_USER_ANSWER_TIMEOUT_MS = 60_000;

/**
 * Shape of `@github/copilot-sdk`'s `UserInputRequest`/`UserInputResponse`/`UserInputHandler`.
 * These types are not exported from the package's public entry point (only referenced by the
 * `onUserInputRequest` field's type internally), so they are hand-mirrored here rather than
 * imported - matching the `RlmPermissionHandler` opaque-type convention in `session.ts`.
 */
export type RlmUserInputRequest = {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
};
export type RlmUserInputResponse = { answer: string; wasFreeform: boolean };
export type RlmUserInputHandlerFn = (
  request: RlmUserInputRequest,
  invocation: { sessionId: string },
) => Promise<RlmUserInputResponse>;

export type ConsoleUserInputOptions = {
  /** Short human-readable label prefixed on the question prompt, e.g. "rlm default depth 1/3". */
  label: string;
  /** Recursion depth (submind = 0), used to indent output. */
  depthUsed?: number;
  onAnswered?: (exchange: RlmUserInputExchange) => void;
};

const indentFor = (depthUsed?: number): string => "  ".repeat(depthUsed ?? 0);

/**
 * Builds an `onUserInputRequest` handler that surfaces the nested session's `ask_user` tool calls
 * as a real, blocking terminal prompt: the question (and choices, if any) is printed, then the
 * process waits on stdin for the actual human running the prototype to type an answer.
 *
 * This is what makes the `rlm` recursion genuinely interactive rather than a one-shot batch call:
 * a deeply nested session can pause and wait on a real person, exactly like the top-level Copilot
 * CLI would.
 */
export function createConsoleUserInputHandler(
  options: ConsoleUserInputOptions,
): RlmUserInputHandlerFn {
  return async (request) => {
    const { label, depthUsed, onAnswered } = options;
    const indent = indentFor(depthUsed);
    writeRlmOutput(`\n${indent}${YELLOW}[${label}] ask_user:${RESET} ${request.question}\n`);
    if (request.choices?.length) {
      writeRlmOutput(`${indent}${YELLOW}  choices: ${request.choices.join(", ")}${RESET}\n`);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(`${YELLOW}[${label}] > ${RESET}`)).trim();
      const wasFreeform = !(request.choices ?? []).includes(answer);
      onAnswered?.({ question: request.question, answer });
      return { answer, wasFreeform };
    } finally {
      rl.close();
    }
  };
}

export type SubmindUserInputOptions = {
  /** Short human-readable label prefixed on console output, e.g. "rlm default depth 1/3". */
  label: string;
  /** Recursion depth (submind = 0), used to indent output. */
  depthUsed?: number;
  /**
   * The immediate task text delegated by this `rlm` call. This supplements the root conversation
   * snapshot so the answerer understands why the recursive worker is asking.
   */
  delegatedPrompt: string;
  /** Snapshots the root Submind's complete conversation at the moment of the request. */
  getConversationContext: () => Promise<string>;
  /** Model used for the answering call. Reuses the nested session's own profile model by default. */
  model: string;
  clientFactory: RlmClientFactory;
  sendTimeoutMs?: number;
  onAnswered?: (exchange: RlmUserInputExchange) => void;
};

/**
 * Builds an `onUserInputRequest` handler that answers the nested session's `ask_user` tool calls
 * on behalf of the root Submind, *without* unsafely re-entering its live session mid-turn. The
 * root remains blocked inside the turn that triggered the recursive tool-call chain.
 *
 * Instead, it spins up a brand-new, independent, single-shot session told exactly what was
 * delegated (`delegatedPrompt`), grounds it in a current root-conversation snapshot, and asks it
 * to answer the nested session's question without live-session reentrancy or human involvement.
 */
export function createSubmindUserInputHandler(
  options: SubmindUserInputOptions,
): RlmUserInputHandlerFn {
  return async (request) => {
    const {
      label,
      depthUsed,
      delegatedPrompt,
      getConversationContext,
      model,
      clientFactory,
      sendTimeoutMs,
      onAnswered,
    } = options;
    const indent = indentFor(depthUsed);
    writeRlmOutput(
      `\n${indent}${YELLOW}[${label}] ask_user -> submind:${RESET} ${request.question}\n`,
    );

    const conversationContext = await getConversationContext();
    const choices = request.choices ?? [];
    const choiceGuidance =
      choices.length > 0
        ? ` The allowed choices are: ${JSON.stringify(choices)}. ${
            request.allowFreeform === false
              ? "Return exactly one allowed choice and no other text."
              : "Prefer an allowed choice; use a freeform answer only when the root context requires it."
          }`
        : "";
    const client = await clientFactory();
    await client.start();
    let session: RlmSession | undefined;
    try {
      session = await client.createSession({
        model,
        systemMessage: {
          mode: "append",
          content:
            "You answer on behalf of the root Submind, which asked a recursive worker to accomplish " +
            `the following task: "${delegatedPrompt}". Below is a snapshot of your complete ` +
            "root conversation through the current recursive call. Use its instructions, " +
            "facts, prior answers, and decisions when answering. The sub-agent cannot answer this " +
            "itself and is asking you directly via its ask_user tool. Answer definitively, " +
            "directly, and concisely (one sentence) when the snapshot supports an answer." +
            choiceGuidance +
            " If it " +
            "does not, say precisely that the root Submind lacks the requested information; do not " +
            "invent it or continue the broader task.\n\n" +
            "<root_conversation>\n" +
            conversationContext +
            "\n</root_conversation>",
        },
        enableConfigDiscovery: false,
        enableSkills: false,
        memory: { enabled: false },
        availableTools: [],
        onPermissionRequest: approveAll,
      });
      const answerTimeoutMs = Math.min(
        sendTimeoutMs ?? RLM_ASK_USER_ANSWER_TIMEOUT_MS,
        RLM_ASK_USER_ANSWER_TIMEOUT_MS,
      );
      const response = await session.sendAndWait({ prompt: request.question }, answerTimeoutMs);
      const answer = response?.data?.content?.trim() ?? "";
      if (!answer) {
        throw new Error("The submind answerer returned an empty ask_user response.");
      }
      const wasFreeform = !choices.includes(answer);
      if (choices.length > 0 && request.allowFreeform === false && wasFreeform) {
        throw new Error(
          `The submind answerer returned "${answer}", which is not one of the allowed choices.`,
        );
      }
      writeRlmOutput(`${indent}${YELLOW}[${label}] submind answered:${RESET} ${answer}\n`);
      onAnswered?.({ question: request.question, answer });
      return { answer, wasFreeform };
    } finally {
      try {
        await session?.disconnect();
      } catch {
        // Best-effort cleanup must not mask the answer or the original failure.
      }
      try {
        await client.stop();
      } catch {
        // Same as above.
      }
    }
  };
}
