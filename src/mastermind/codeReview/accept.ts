import type { WeavekitConfig } from "../../config.js";
import { MastermindEventType, MastermindState } from "../domain/events.js";
import { transitionMastermindState } from "../domain/machine.js";
import type { LinearGateway } from "../linear/client.js";
import type { MastermindStore, MastermindWorkItem } from "../store/store.js";

type AcceptanceStore = Pick<
  MastermindStore,
  "acquireLease" | "findExecutionAttachment" | "getWork" | "releaseLease" | "transition"
>;

export async function acceptMastermindWork(input: {
  selector: string;
  config: WeavekitConfig;
  store: AcceptanceStore;
  linear: LinearGateway;
}): Promise<MastermindWorkItem> {
  const selector = input.selector.trim();
  if (!selector) {
    throw new Error(
      "Usage: mise run mastermind:accept <ticket-identifier|work-id|issue-id|attempt-id>",
    );
  }
  const target = await input.store.findExecutionAttachment(selector);
  if (!target) throw new Error(`No Mastermind execution found for: ${selector}`);
  const owner = input.config.mastermind.instanceId;
  const leased = await input.store.acquireLease(
    target.workId,
    owner,
    new Date(),
    input.config.mastermind.leaseDurationMs,
  );
  if (!leased) throw new Error(`Mastermind work ${target.workId} is currently leased.`);
  try {
    const work = await input.store.getWork(target.workId);
    if (!work) throw new Error(`Mastermind work ${target.workId} disappeared.`);
    if (work.state === MastermindState.COMPLETED) return work;
    if (work.state !== MastermindState.AWAITING_ACCEPTANCE) {
      throw new Error(
        `Mastermind work ${target.workId} cannot be accepted from state ${work.state}.`,
      );
    }
    if (!input.linear.setIssueState) {
      throw new Error("Linear gateway does not support workflow-state projection.");
    }
    await input.linear.setIssueState(work.issueId, input.config.mastermind.doneStateName ?? "Done");
    await input.linear.replaceIssueLabels(work.issueId, {
      remove: [
        input.config.mastermind.codeReviewLabelId ?? "",
        input.config.mastermind.codeReviewPassedLabelId ?? "",
        input.config.mastermind.changesRequestedLabelId ?? "",
      ].filter(Boolean),
      add: [],
    });
    if (input.linear.findIssueCommentByMarker && input.linear.createIssueComment) {
      const marker = `<!-- weavekit-mastermind-acceptance:${work.id} -->`;
      const existing = await input.linear.findIssueCommentByMarker(work.issueId, marker);
      if (!existing) {
        await input.linear.createIssueComment(
          work.issueId,
          `${marker}\nMastermind implementation accepted by a human. Ticket moved to **Done**.`,
        );
      }
    }
    return input.store.transition(work, owner, {
      eventType: MastermindEventType.ACCEPT_IMPLEMENTATION,
      priorState: work.state,
      nextState: transitionMastermindState(work.state, {
        type: MastermindEventType.ACCEPT_IMPLEMENTATION,
      }),
    });
  } finally {
    await input.store.releaseLease(target.workId, owner);
  }
}
