import { approveAll } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import {
  canonicalRepository,
  mainRepository,
  resolveExistingHerdrWorktree,
} from "../../herdr/provision.js";
import { isHerdrEnvironment, resolveHerdrSocketPath } from "../../herdr/client.js";
import type { RlmExecutionBudget } from "../budget.js";
import { writeRlmOutput } from "../environment.js";
import type { RlmClientFactory, RlmSession } from "../session.js";
import type { CopilotModelCatalog } from "../modelCatalog.js";
import { createTrellageCatalog, discoverTrellageProfiles } from "./catalog.js";
import type { TrellageInvokeArgs } from "./contracts.js";
import type { TrellageAnswerer } from "./driveLoop.js";
import { createTrellageTool, type CreateTrellageToolOptions } from "./tool.js";
import { TrellageWorktreeRegistry, type TrellageWorktreeDisposition } from "./worktrees.js";

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const ANSWER_TIMEOUT_MS = 90_000;

export type TrellageIntegration = {
  tool: Tool<TrellageInvokeArgs>;
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
  /** Borrows the current live Herdr linked worktree instead of provisioning a sibling. */
  reuseCurrentWorktree?: boolean;
  toolOptions?: Partial<
    Pick<CreateTrellageToolOptions, "timeoutMs" | "maxTurns" | "maxConcurrent">
  >;
  modelCatalog?: CopilotModelCatalog;
};

/**
 * Builds the `invoke_trellage` integration, or returns `undefined` when this process cannot drive a
 * harness.
 *
 * Returning `undefined` rather than a failing tool is deliberate: `trellage` requires a controlling
 * terminal, which only Herdr provides here, so outside a Herdr session the tool could never
 * succeed. Registering it anyway would just invite the model to waste calls discovering that.
 */
export async function setupTrellageIntegration(
  options: SetupTrellageOptions,
): Promise<TrellageIntegration | undefined> {
  const cwd = options.cwd ?? process.cwd();
  if (!isHerdrEnvironment()) return undefined;
  try {
    await resolveHerdrSocketPath(cwd, undefined);
  } catch {
    return undefined;
  }

  let repositoryPath: string;
  try {
    repositoryPath = await mainRepository(cwd);
  } catch {
    return undefined;
  }

  const profiles = await discoverTrellageProfiles();
  if (profiles.length === 0) return undefined;

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

  const tool = createTrellageTool({
    runId: options.runId,
    catalog: createTrellageCatalog(profiles),
    worktrees,
    repositoryPath,
    answer: options.answer,
    executionBudget: options.executionBudget,
    ...(options.modelCatalog ? { modelCatalog: options.modelCatalog } : {}),
    ...options.toolOptions,
  });

  return { tool, worktrees, finalize: () => worktrees.finalize() };
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
  return async (question, choices) => {
    writeRlmOutput(`\n${YELLOW}[trellage] harness asked:${RESET}\n${question}\n`);
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
        availableTools: [],
        onPermissionRequest: approveAll,
      });
      const response = await session.sendAndWait({ prompt: question }, ANSWER_TIMEOUT_MS);
      const answer = response?.data?.content?.trim() ?? "";
      if (!answer) throw new Error("The submind answerer returned an empty response.");
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
