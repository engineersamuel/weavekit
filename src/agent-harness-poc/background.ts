import { Trace } from "./trace.js";

export type WorkerResult = { id: string; payload: unknown };

export class DeferredBarrier {
  private readonly expected: number;
  private readonly releasePromise: Promise<void>;
  private readonly allStartedPromise: Promise<void>;
  private releaseResolve: () => void = () => {};
  private allStartedResolve: () => void = () => {};
  private startedCount = 0;
  private released = false;

  constructor(expected: number) {
    if (!Number.isInteger(expected) || expected < 1) {
      throw new Error("Barrier expected count must be a positive integer.");
    }
    this.expected = expected;
    this.releasePromise = new Promise((resolve) => {
      this.releaseResolve = resolve;
    });
    this.allStartedPromise = new Promise((resolve) => {
      this.allStartedResolve = resolve;
    });
  }

  markStarted(): void {
    this.startedCount += 1;
    if (this.startedCount === this.expected) {
      this.allStartedResolve();
    }
  }

  wait(): Promise<void> {
    return this.releasePromise;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.releaseResolve();
  }

  allStarted(): Promise<void> {
    return this.allStartedPromise;
  }
}

export class BackgroundCoordinator {
  private readonly trace: Trace;

  constructor(trace: Trace) {
    this.trace = trace;
  }

  async runWorkersInParallel<T extends WorkerResult>(
    workers: Array<() => Promise<T>>,
  ): Promise<T[]> {
    this.trace.push("bg.start", `starting ${workers.length} workers`);
    const pending = workers.map(async (worker, index) => {
      this.trace.push("bg.worker.start", `worker ${index} started`, { index });
      try {
        const result = await worker();
        this.trace.push("bg.worker.end", `worker ${index} completed`, {
          index,
          id: result.id,
        });
        return result;
      } catch (error) {
        this.trace.push("bg.worker.error", `worker ${index} failed`, {
          index,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
    const results = await Promise.all(pending);
    this.trace.push("bg.end", `completed ${results.length} workers`);
    return results;
  }
}
