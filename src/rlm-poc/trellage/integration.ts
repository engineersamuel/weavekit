import { approveAll } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import {
  canonicalRepository,
  mainRepository,
  resolveExistingHerdrWorktree,
} from "../../herdr/provision.js";
import type { RlmExecutionBudget } from "../budget.js";
import { writeRlmOutput } from "../environment.js";
import type { RlmClientFactory, RlmSession } from "../session.js";
import type { CopilotModelCatalog } from "../modelCatalog.js";
import {
  createTrellageCatalog,
  discoverTrellageProfiles,
  selectRlmTrellageProfiles,
} from "./catalog.js";
import type { TrellageInvokeArgs } from "./contracts.js";
import type { TrellageAnswerer } from "./driveLoop.js";
import type { RlmVisualizationObserver } from "../visualization/contracts.js";
import { createTrellageTool, type CreateTrellageToolOptions } from "./tool.js";
import { TrellageWorktreeRegistry, type TrellageWorktreeDisposition } from "./worktrees.js";

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const ANSWER_TIMEOUT_MS = 90_000;
const REPEATED_REPORT_INSTRUCTION =
  "Yes. Report the result now. Write the final answer to the requested result.md file, then " +
  "reply in the terminal with that file path only. Do not ask again.";

type AskedQuestion = {
  raw: string;
  normalized: string;
  tokens: string[];
  choicesKey: string;
  answer: string;
  repeats: number;
};

export type TrellageIntegration = {
  /**
   * Builds the `invoke_trellage` tool for one session. It is per-session rather than shared so the
   * storyboard can attribute each delegation to the `rlm` call that owns the session it ran in.
   */
  createTool: (context?: { parentCallId?: string; depth?: number }) => Tool<TrellageInvokeArgs>;
  worktrees: TrellageWorktreeRegistry;
  /** Reclaims untouched worktrees and reports the ones holding delegated work. */
  finalize: () => Promise<TrellageWorktreeDisposition[]>;
};

export type SetupTrellageOptions = {
  runId: string;
  executionBudget: RlmExecutionBudget;
  /** Answers harness questions on behalf of the root Submind. */
  answer: TrellageAnswerer;
  cwd?: string;
  /** Provisions the root repository's worktree up front rather than on first delegation. */
  provisionEagerly?: boolean;
  /** Borrows the current linked worktree instead of provisioning a sibling. */
  reuseCurrentWorktree?: boolean;
  toolOptions?: Partial<
    Pick<CreateTrellageToolOptions, "timeoutMs" | "maxTurns" | "maxConcurrent">
  >;
  modelCatalog?: CopilotModelCatalog;
  /** Run-owned storyboard recorder shared with the `rlm` tools. */
  visualization?: RlmVisualizationObserver;
};

/**
 * Builds the `invoke_trellage` integration, or returns `undefined` when this process cannot drive a
 * discovered harness. The RLM sees only profiles backed by a verified structured adapter (native
 * `cldx`, `cpx`, and `omp`/`copilot`, plus Claude container profiles) and always provisions their
 * worktree through Git, never through Herdr panes or agents.
 */
export async function setupTrellageIntegration(
  options: SetupTrellageOptions,
): Promise<TrellageIntegration | undefined> {
  const cwd = options.cwd ?? process.cwd();
  const profiles = await discoverTrellageProfiles();
  if (profiles.length === 0) return undefined;

  const availableProfiles = selectRlmTrellageProfiles(profiles);
  if (availableProfiles.length === 0) return undefined;
  let repositoryPath: string;
  try {
    repositoryPath = await mainRepository(cwd);
  } catch {
    return undefined;
  }

  let currentWorktree;
  if (options.reuseCurrentWorktree) {
    const currentRepositoryPath = await canonicalRepository(cwd);
    if (currentRepositoryPath === repositoryPath) {
      throw new Error("Current-worktree reuse requires a linked Git worktree.");
    }
    currentWorktree = await resolveExistingHerdrWorktree(cwd);
  }

  const worktrees = new TrellageWorktreeRegistry({
    runId: options.runId,
    ...(currentWorktree ? { currentWorktree } : {}),
    direct: true,
  });
  if (options.provisionEagerly) {
    // Provisioning runs the repository's worktree init hooks, which can be slow. Failing here must
    // not abort the run: the registry will simply retry on the first actual delegation.
    try {
      const worktree = await worktrees.acquire(repositoryPath);
      writeRlmOutput(
        `${YELLOW}[trellage] worktree ready:${RESET} ${worktree.worktreePath} (${worktree.branchName})\n`,
      );
    } catch (error) {
      writeRlmOutput(
        `${YELLOW}[trellage] worktree provisioning deferred:${RESET} ${String(error)}\n`,
      );
    }
  }

  const catalog = createTrellageCatalog(availableProfiles);
  const createTool: TrellageIntegration["createTool"] = (context) =>
    createTrellageTool({
      runId: options.runId,
      catalog,
      worktrees,
      repositoryPath,
      answer: options.answer,
      executionBudget: options.executionBudget,
      ...(options.modelCatalog ? { modelCatalog: options.modelCatalog } : {}),
      ...(options.visualization ? { visualization: options.visualization } : {}),
      ...(context?.parentCallId ? { owningCallId: context.parentCallId } : {}),
      ...(context?.depth === undefined ? {} : { depth: context.depth }),
      ...options.toolOptions,
    });

  return { createTool, worktrees, finalize: () => worktrees.finalize() };
}

export type SubmindAnswererOptions = {
  model: string;
  clientFactory: RlmClientFactory;
  getConversationContext: () => Promise<string>;
  onAnswered?: (exchange: { question: string; answer: string }) => void;
};

/**
 * Answers a delegated harness's question on behalf of the root Submind.
 *
 * Mirrors `createSubmindUserInputHandler`: the root session is blocked inside the turn that
 * triggered this call, so it cannot be re-entered. A fresh single-shot session grounded in a
 * snapshot of the root conversation answers instead.
 */
export function createTrellageAnswerer(options: SubmindAnswererOptions): TrellageAnswerer {
  const askedQuestions: AskedQuestion[] = [];

  return async (question, choices) => {
    writeRlmOutput(`\n${YELLOW}[trellage] harness asked:${RESET}\n${question}\n`);
    const repeated = findRepeatedQuestion(askedQuestions, question, choices);
    if (repeated) {
      repeated.repeats += 1;
      const answer = chooseRepeatedQuestionAnswer(repeated, question);
      writeRlmOutput(
        `${YELLOW}[trellage] repeated question x${repeated.repeats}:${RESET} ${answer}\n`,
      );
      options.onAnswered?.({ question, answer });
      return answer;
    }

    const conversationContext = await options.getConversationContext();
    const choiceGuidance =
      choices && choices.length > 0
        ? ` Reply with exactly one of these values and no other text: ${JSON.stringify(choices)}.`
        : "";
    const client = await options.clientFactory();
    await client.start();
    let session: RlmSession | undefined;
    try {
      session = await client.createSession({
        model: options.model,
        systemMessage: {
          mode: "append",
          content:
            "You answer on behalf of the root Submind, which delegated work to an autonomous " +
            "coding agent running in a separate terminal. That agent has stopped to ask the " +
            "question below and cannot continue until you answer. Below is a snapshot of your " +
            "root conversation. Use its instructions, facts, and decisions to answer " +
            "definitively and concisely. Prefer letting the agent proceed: approve routine " +
            "actions rather than blocking on them. If the snapshot genuinely does not contain " +
            "the answer, say so plainly instead of inventing it." +
            choiceGuidance +
            "\n\n<root_conversation>\n" +
            conversationContext +
            "\n</root_conversation>",
        },
        enableConfigDiscovery: false,
        enableSkills: false,
        memory: { enabled: false },
        availableTools: [],
        excludedTools: ["task_complete", "ask_user"],
        onPermissionRequest: approveAll,
      });
      const response = await session.sendAndWait({ prompt: question }, ANSWER_TIMEOUT_MS);
      const answer = await readTrellageAnswer(session, response);
      if (!answer) throw new Error("The submind answerer returned an empty response.");
      askedQuestions.push({
        raw: question,
        normalized: normalizeQuestion(question),
        tokens: questionTokens(question),
        choicesKey: choicesKey(choices),
        answer,
        repeats: 1,
      });
      writeRlmOutput(`${YELLOW}[trellage] submind answered:${RESET} ${answer}\n`);
      options.onAnswered?.({ question, answer });
      return answer;
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

async function readTrellageAnswer(
  session: RlmSession,
  response: { data?: { content?: string } } | undefined,
): Promise<string> {
  const direct = response?.data?.content?.trim() ?? "";
  if (direct) return direct;
  const events = await session.getEvents?.();
  if (!events) return "";
  for (const event of [...events].reverse()) {
    if (event.type !== "assistant.message") continue;
    const content = event.data.content.trim();
    if (content) return content;
  }
  return "";
}

function findRepeatedQuestion(
  askedQuestions: readonly AskedQuestion[],
  question: string,
  choices?: string[],
): AskedQuestion | undefined {
  const normalized = normalizeQuestion(question);
  const currentChoicesKey = choicesKey(choices);
  const currentTokens = questionTokens(question);
  const currentIsReportPermission = isReportPermissionQuestion(question);
  return askedQuestions.find((entry) => {
    if (entry.choicesKey !== currentChoicesKey) return false;
    if (entry.normalized === normalized) return true;
    if (currentIsReportPermission && isReportPermissionQuestion(entry.raw)) return true;
    if (entry.tokens.length === 0 || currentTokens.length === 0) return false;
    return tokenOverlap(entry.tokens, currentTokens) >= 0.5;
  });
}

function chooseRepeatedQuestionAnswer(previous: AskedQuestion, question: string): string {
  if (isReportPermissionQuestion(previous.raw) || isReportPermissionQuestion(question)) {
    return REPEATED_REPORT_INSTRUCTION;
  }
  return previous.answer;
}

function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/`[^`]*`/gu, " ")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function questionTokens(question: string): string[] {
  return [...new Set(tokenizeQuestion(question))].sort();
}

function choicesKey(choices?: string[]): string {
  return choices?.join("\u0000") ?? "";
}

function isReportPermissionQuestion(question: string): boolean {
  const normalized = normalizeQuestion(question);
  return (
    /(may|can|should) i (?:now )?(?:report|return|write|save|submit|share)/u.test(normalized) ||
    (/(report|write|save|submit|share)/u.test(normalized) &&
      /(result|result md|file|path)/u.test(normalized))
  );
}

function tokenizeQuestion(question: string): string[] {
  return normalizeQuestion(question)
    .split(" ")
    .filter((token) => token.length >= 3 && !QUESTION_STOP_WORDS.has(token));
}

function tokenOverlap(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  return intersection / union.size;
}

const QUESTION_STOP_WORDS = new Set([
  "the",
  "and",
  "that",
  "this",
  "with",
  "from",
  "into",
  "your",
  "their",
  "have",
  "what",
  "when",
  "where",
  "which",
  "will",
  "would",
  "should",
  "could",
  "please",
  "just",
  "than",
  "then",
  "them",
  "they",
  "there",
  "about",
  "because",
  "need",
  "asks",
  "asked",
  "asking",
  "does",
  "done",
  "only",
  "else",
  "into",
  "after",
  "before",
  "reply",
  "exactly",
]);
