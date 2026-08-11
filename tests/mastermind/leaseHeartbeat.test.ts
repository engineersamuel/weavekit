import type { Attributes, Span } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLeaseHeartbeat } from "../../src/mastermind/decision/loop.js";
import type { MastermindStore } from "../../src/mastermind/store/store.js";

function createFakeLeaseSpan(): Pick<Span, "addEvent" | "setAttribute"> & {
  attributes: Record<string, unknown>;
  events: Array<{ name: string; attributes: Record<string, unknown> }>;
} {
  const span = {
    attributes: {} as Record<string, unknown>,
    events: [] as Array<{ name: string; attributes: Record<string, unknown> }>,
    setAttribute(key: string, value: unknown) {
      span.attributes[key] = value;
      return span as unknown as Span;
    },
    addEvent(name: string, attributesOrStartTime?: Attributes) {
      span.events.push({
        name,
        attributes:
          attributesOrStartTime && !Array.isArray(attributesOrStartTime)
            ? (attributesOrStartTime as Record<string, unknown>)
            : {},
      });
      return span as unknown as Span;
    },
  };
  return span;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-05T20:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createLeaseHeartbeat", () => {
  it("stops without queuing new renewals while a pending renewal drains", async () => {
    const span = createFakeLeaseSpan();
    const renewal = createDeferred<boolean>();
    const renewLease = vi.fn(() => renewal.promise);
    const heartbeat = createLeaseHeartbeat({
      store: { renewLease } as unknown as MastermindStore,
      workId: "work-one",
      owner: "owner-one",
      durationMs: 80,
      rootSpan: span,
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(renewLease).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(renewLease).toHaveBeenCalledTimes(1);

    const stopPromise = heartbeat.stop();
    let stopResolved = false;
    void stopPromise.then(() => {
      stopResolved = true;
    });
    const assertAfterStopPromise = heartbeat.assertActive();

    await vi.advanceTimersByTimeAsync(200);
    expect(renewLease).toHaveBeenCalledTimes(1);
    expect(stopResolved).toBe(false);

    renewal.resolve(true);
    await Promise.all([stopPromise, assertAfterStopPromise]);
    await vi.advanceTimersByTimeAsync(200);

    expect(stopResolved).toBe(true);
    expect(renewLease).toHaveBeenCalledTimes(1);
    expect(span.attributes["weavekit.mastermind.lease.status"]).toBe("stopped");
    expect(span.events).toEqual([]);
  });

  it("preserves an in-flight renewal failure that completes after stop begins", async () => {
    const span = createFakeLeaseSpan();
    const renewal = createDeferred<boolean>();
    const renewLease = vi.fn(() => renewal.promise);
    const heartbeat = createLeaseHeartbeat({
      store: { renewLease } as unknown as MastermindStore,
      workId: "work-error",
      owner: "owner-one",
      durationMs: 80,
      rootSpan: span,
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(renewLease).toHaveBeenCalledTimes(1);

    const stopPromise = heartbeat.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(renewLease).toHaveBeenCalledTimes(1);

    renewal.reject(new Error("renewal exploded"));
    await stopPromise;

    expect(renewLease).toHaveBeenCalledTimes(1);
    expect(span.attributes["weavekit.mastermind.lease.status"]).toBe("error");
    expect(span.events).toEqual([
      expect.objectContaining({
        name: "mastermind.lease.status",
        attributes: expect.objectContaining({
          "weavekit.mastermind.lease.status": "error",
          "weavekit.mastermind.lease.error_message": "renewal exploded",
        }),
      }),
    ]);
  });
});
