import type { MastermindDefaults } from "../config.js";
import type { MastermindDecisionLoop } from "./decision/loop.js";
import type { MastermindExecutionCoordinator } from "./execution/coordinator.js";
import type { MastermindStore, TerminalWorkFreshnessScanCursor } from "./store/store.js";

const STARTUP_REVIEW_FRESHNESS_SCAN_PAGE_SIZE = 100;

export class MastermindService {
  private accepting = false;
  private reconciliationTimer?: ReturnType<typeof setInterval>;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly executionInFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly config: MastermindDefaults,
    private readonly store: MastermindStore,
    private readonly loop: MastermindDecisionLoop,
    private readonly executionCoordinator?: MastermindExecutionCoordinator,
  ) {}

  async start(): Promise<void> {
    await this.store.initialize();
    this.accepting = true;
    await this.reconcile({ includeTerminalFreshnessScan: true });
    this.reconciliationTimer = setInterval(
      () => void this.reconcile(),
      Math.min(
        this.config.reconcileIntervalMs,
        this.config.execution?.pollIntervalMs ?? this.config.reconcileIntervalMs,
      ),
    );
    this.reconciliationTimer.unref?.();
  }

  isReady(): boolean {
    return this.accepting;
  }

  enqueue(workId: string): void {
    void this.processAndWait(workId).catch((error) => {
      process.stderr.write(
        `[weavekit-mastermind] work ${workId} failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    });
  }

  processAndWait(workId: string): Promise<void> {
    if (!this.accepting) {
      return Promise.resolve();
    }
    const existing = this.inFlight.get(workId);
    if (existing) {
      return existing;
    }
    const run = this.loop
      .process(workId)
      .then(() => this.processExecutionAndWait(workId))
      .finally(() => {
        if (this.inFlight.get(workId) === run) {
          this.inFlight.delete(workId);
        }
      });
    this.inFlight.set(workId, run);
    return run;
  }

  processExecutionAndWait(workId: string): Promise<void> {
    if (!this.accepting || !this.executionCoordinator) {
      return Promise.resolve();
    }
    const existing = this.executionInFlight.get(workId);
    if (existing) return existing;
    const run = this.executionCoordinator.process(workId).finally(() => {
      if (this.executionInFlight.get(workId) === run) {
        this.executionInFlight.delete(workId);
      }
    });
    this.executionInFlight.set(workId, run);
    return run;
  }

  async stop(): Promise<void> {
    this.accepting = false;
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = undefined;
    }
    await Promise.allSettled(this.inFlight.values());
    await Promise.allSettled(this.executionInFlight.values());
    this.store.close();
  }

  private async reconcile(options: { includeTerminalFreshnessScan?: boolean } = {}): Promise<void> {
    if (!this.accepting) {
      return;
    }
    const now = new Date();
    const workIds = new Set(await this.store.listRecoverableWorkIds(now));
    const executionWorkIds = new Set(await this.store.listLaunchableExecutionWorkIds(now));
    for (const execution of await this.store.listRecoverableExecutions(now)) {
      executionWorkIds.add(execution.workId);
    }
    if (options.includeTerminalFreshnessScan) {
      let cursor: TerminalWorkFreshnessScanCursor | undefined;
      do {
        const page = await this.store.listTerminalWorkIdsForFreshnessScan(now, {
          limit: STARTUP_REVIEW_FRESHNESS_SCAN_PAGE_SIZE,
          cursor,
        });
        for (const workId of page.workIds) {
          workIds.add(workId);
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    for (const workId of workIds) {
      this.enqueue(workId);
    }
    for (const workId of executionWorkIds) {
      void this.processExecutionAndWait(workId).catch((error) => {
        process.stderr.write(
          `[weavekit-mastermind] execution ${workId} failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      });
    }
  }
}
