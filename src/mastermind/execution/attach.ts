import { join } from "node:path";
import { ExecutorKind, type ExecutorHandle } from "../../submind/contracts.js";
import type { ExecutionAttachmentTarget, MastermindStore } from "../store/store.js";

type AttachmentStore = Pick<MastermindStore, "findExecutionAttachment">;

export type HerdrAttachmentRunner = (
  command: string,
  args: string[],
) => Promise<{ exitCode: number | null }>;

export async function attachMastermindExecution(input: {
  selector: string;
  store: AttachmentStore;
  herdrEnv: string | undefined;
  run: HerdrAttachmentRunner;
  /** Receives human-facing guidance for executors that cannot be attached to. */
  emit?: (message: string) => void;
}): Promise<ExecutionAttachmentTarget> {
  const selector = input.selector.trim();
  if (!selector) {
    throw new Error(
      "Usage: mise run mastermind:attach <ticket-identifier|work-id|issue-id|attempt-id>",
    );
  }
  const target = await input.store.findExecutionAttachment(selector);
  if (!target) {
    throw new Error(`No Mastermind execution found for: ${selector}`);
  }
  const handle = target.attempt.executorHandle;
  if (!handle) {
    throw new Error(`Mastermind execution ${target.attempt.id} has no executor handle.`);
  }
  if (handle.executor === ExecutorKind.RLM_SUBMIND) {
    // The RLM submind is a detached child process, not a Herdr agent. There is nothing to attach
    // to, so report where its evidence lives rather than failing on agent_not_found.
    input.emit?.(describeRlmExecution(handle));
    return target;
  }
  if (!handle.agentName) {
    throw new Error(
      `Mastermind execution ${target.attempt.id} has no Herdr agent handle to attach to.`,
    );
  }
  const subcommand = input.herdrEnv === "1" ? "focus" : "attach";
  const result = await input.run("herdr", ["agent", subcommand, handle.agentName]);
  if (result.exitCode !== 0) {
    throw new Error(
      `herdr agent ${subcommand} ${handle.agentName} exited with code ${result.exitCode ?? "unknown"}.`,
    );
  }
  return target;
}

function describeRlmExecution(handle: ExecutorHandle): string {
  return [
    "This execution ran as a detached RLM submind process, not a Herdr agent.",
    `Worktree: ${handle.worktreePath}`,
    ...(handle.logPath ? [`Log:      ${handle.logPath}`] : []),
    `Result:   ${join(handle.worktreePath, ".weavekit", "mastermind-result.json")}`,
    "",
  ].join("\n");
}
