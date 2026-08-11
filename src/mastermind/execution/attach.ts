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
  if (!handle?.agentName) {
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
