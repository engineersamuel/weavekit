import { setTimeout as delay } from "node:timers/promises";
import { MastermindState } from "../domain/events.js";
import type { ExecutionAttempt, MastermindStore, MastermindWorkItem } from "../store/store.js";

const TERMINAL_EXECUTION_STATES = new Set<MastermindState>([
  MastermindState.AWAITING_ACCEPTANCE,
  MastermindState.CHANGES_REQUESTED,
  MastermindState.COMPLETED,
  MastermindState.NEEDS_HUMAN,
  MastermindState.FAILED,
]);

type OneShotStore = Pick<
  MastermindStore,
  | "getCurrentExecutionAttempt"
  | "getWork"
  | "listLaunchableExecutionWorkIds"
  | "listRecoverableExecutions"
>;

type OneShotCoordinator = {
  process(workId: string): Promise<void>;
};

export type OneShotExecutionProgress = {
  work: MastermindWorkItem;
  attempt?: ExecutionAttempt;
};

export type OneShotExecutionResult =
  | { disposition: "no-work" }
  | {
      disposition: "completed";
      work: MastermindWorkItem;
      attempt: ExecutionAttempt;
    };

export async function executeOneReadyWork(input: {
  store: OneShotStore;
  coordinator: OneShotCoordinator;
  workId?: string;
  postImplementationReviewEnabled?: boolean;
  pollIntervalMs: number;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
  onProgress?: (progress: OneShotExecutionProgress) => void;
}): Promise<OneShotExecutionResult> {
  const now = input.now ?? (() => new Date());
  const wait = input.wait ?? ((milliseconds) => delay(milliseconds));
  const recoverable = input.workId ? [] : await input.store.listRecoverableExecutions(now());
  const launchable = input.workId ? [] : await input.store.listLaunchableExecutionWorkIds(now());
  const workId = input.workId ?? recoverable[0]?.workId ?? launchable[0];
  if (!workId) {
    return { disposition: "no-work" };
  }

  while (true) {
    const beforeWork = await input.store.getWork(workId);
    const beforeAttempt = await input.store.getCurrentExecutionAttempt(workId);
    await input.coordinator.process(workId);
    const work = await input.store.getWork(workId);
    if (!work) {
      throw new Error(`Mastermind work item disappeared during one-shot execution: ${workId}`);
    }
    const attempt = await input.store.getCurrentExecutionAttempt(workId);
    input.onProgress?.({ work, attempt });

    if (
      attempt &&
      (TERMINAL_EXECUTION_STATES.has(work.state) ||
        (!input.postImplementationReviewEnabled && work.state === MastermindState.SUCCEEDED)) &&
      attempt.projection?.disposition === "applied"
    ) {
      return { disposition: "completed", work, attempt };
    }
    if (!attempt && work.state === MastermindState.ACTION_PLANNED) {
      const leaseBusy =
        work.leaseOwner && work.leaseExpiresAt && work.leaseExpiresAt > now().toISOString();
      throw new Error(
        leaseBusy
          ? `Mastermind work ${workId} is currently leased by ${work.leaseOwner}. Stop the daemon or retry after the lease expires.`
          : `Mastermind work ${workId} did not start direct execution. Verify global execution configuration and project opt-in.`,
      );
    }
    if (!attempt && TERMINAL_EXECUTION_STATES.has(work.state)) {
      throw new Error(
        `Mastermind work ${workId} ended in ${work.state} before an execution attempt started.`,
      );
    }

    const madeProgress =
      beforeWork?.rowVersion !== work.rowVersion ||
      beforeAttempt?.rowVersion !== attempt?.rowVersion;
    if (work.state === MastermindState.RUNNING || !madeProgress) {
      await wait(input.pollIntervalMs);
    }
  }
}
