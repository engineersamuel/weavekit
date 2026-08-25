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

type OneShotExecutionInput = {
  store: OneShotStore;
  coordinator: OneShotCoordinator;
  workId?: string;
  postImplementationReviewEnabled?: boolean;
  pollIntervalMs: number;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
  onProgress?: (progress: OneShotExecutionProgress) => void;
};

type ExecutionPoll = {
  beforeWork?: MastermindWorkItem;
  beforeAttempt?: ExecutionAttempt;
  work: MastermindWorkItem;
  attempt?: ExecutionAttempt;
};

type CompletedExecutionResult = Extract<OneShotExecutionResult, { disposition: "completed" }>;

export async function executeOneReadyWork(
  input: OneShotExecutionInput,
): Promise<OneShotExecutionResult> {
  const now = input.now ?? (() => new Date());
  const wait = input.wait ?? ((milliseconds) => delay(milliseconds));
  const workId = await selectWorkId(input.store, input.workId, now());
  if (!workId) {
    return { disposition: "no-work" };
  }

  let lastProgressFingerprint: string | undefined;
  while (true) {
    const poll = await processExecutionPoll(input, workId);
    lastProgressFingerprint = reportProgress(
      input.onProgress,
      lastProgressFingerprint,
      poll.work,
      poll.attempt,
    );
    const completed = completedExecution(
      poll.work,
      poll.attempt,
      input.postImplementationReviewEnabled,
    );
    if (completed) return completed;
    assertExecutionStarted(poll.work, poll.attempt, workId, now());
    if (shouldWaitForNextPoll(poll)) {
      await wait(input.pollIntervalMs);
    }
  }
}

async function selectWorkId(
  store: OneShotStore,
  requestedWorkId: string | undefined,
  now: Date,
): Promise<string | undefined> {
  if (requestedWorkId) return requestedWorkId;
  const recoverable = await store.listRecoverableExecutions(now);
  const launchable = await store.listLaunchableExecutionWorkIds(now);
  return recoverable[0]?.workId ?? launchable[0];
}

async function processExecutionPoll(
  input: OneShotExecutionInput,
  workId: string,
): Promise<ExecutionPoll> {
  const beforeWork = await input.store.getWork(workId);
  const beforeAttempt = await input.store.getCurrentExecutionAttempt(workId);
  await input.coordinator.process(workId);
  const work = await input.store.getWork(workId);
  if (!work) {
    throw new Error(`Mastermind work item disappeared during one-shot execution: ${workId}`);
  }
  const attempt = await input.store.getCurrentExecutionAttempt(workId);
  return { beforeWork, beforeAttempt, work, attempt };
}

function reportProgress(
  onProgress: OneShotExecutionInput["onProgress"],
  previousFingerprint: string | undefined,
  work: MastermindWorkItem,
  attempt: ExecutionAttempt | undefined,
): string {
  const fingerprint = JSON.stringify([
    work.id,
    work.state,
    attempt?.id,
    attempt?.attemptNumber,
    attempt?.state,
    attempt?.projection?.disposition,
  ]);
  if (fingerprint !== previousFingerprint) onProgress?.({ work, attempt });
  return fingerprint;
}

function completedExecution(
  work: MastermindWorkItem,
  attempt: ExecutionAttempt | undefined,
  postImplementationReviewEnabled: boolean | undefined,
): CompletedExecutionResult | undefined {
  if (!attempt || attempt.projection?.disposition !== "applied") return undefined;
  const completed =
    TERMINAL_EXECUTION_STATES.has(work.state) ||
    (!postImplementationReviewEnabled && work.state === MastermindState.SUCCEEDED);
  return completed ? { disposition: "completed", work, attempt } : undefined;
}

function assertExecutionStarted(
  work: MastermindWorkItem,
  attempt: ExecutionAttempt | undefined,
  workId: string,
  now: Date,
): void {
  if (attempt) return;
  if (work.state === MastermindState.ACTION_PLANNED) {
    const leaseBusy =
      work.leaseOwner && work.leaseExpiresAt && work.leaseExpiresAt > now.toISOString();
    throw new Error(
      leaseBusy
        ? `Mastermind work ${workId} is currently leased by ${work.leaseOwner}. Stop the daemon or retry after the lease expires.`
        : `Mastermind work ${workId} did not start direct execution. Verify global execution configuration and project opt-in.`,
    );
  }
  if (TERMINAL_EXECUTION_STATES.has(work.state)) {
    throw new Error(
      `Mastermind work ${workId} ended in ${work.state} before an execution attempt started.`,
    );
  }
}

function shouldWaitForNextPoll(poll: ExecutionPoll): boolean {
  const madeProgress =
    poll.beforeWork?.rowVersion !== poll.work.rowVersion ||
    poll.beforeAttempt?.rowVersion !== poll.attempt?.rowVersion;
  return poll.work.state === MastermindState.RUNNING || !madeProgress;
}
