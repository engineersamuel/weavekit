import { describe, expect, it } from "vitest";
import { RunRecordSubmindTraceSource } from "../../src/mastermind/selfImprovement/traceSource.js";
import type { ExecutionAttempt } from "../../src/mastermind/store/store.js";

const source = new RunRecordSubmindTraceSource();

describe("RunRecordSubmindTraceSource", () => {
  it("maps every persisted call onto a trace observation", async () => {
    const summary = await source.fetchSubmindTraceSummary(
      attempt({
        summary: "Implemented the ticket.",
        submindTrace: { traceId: "trace-1", url: "https://langfuse/trace-1" },
        runRecord: {
          schemaVersion: 1,
          runId: "run-1",
          calls: [
            {
              callId: "run-1:call-1",
              callNumber: 1,
              profile: "review",
              depthUsed: 1,
              status: "succeeded",
              model: "claude-opus-5",
              startedAt: "2026-08-13T12:00:00.000Z",
              completedAt: "2026-08-13T12:00:12.000Z",
              summary: "Reviewed the diff.",
            },
            {
              callId: "run-1:call-2",
              callNumber: 2,
              profile: "validation",
              depthUsed: 2,
              status: "failed",
              startedAt: "2026-08-13T12:00:01.000Z",
              completedAt: "2026-08-13T12:00:03.000Z",
              summary: "Session timed out.",
            },
          ],
        },
      }),
    );

    expect(summary).toEqual({
      traceId: "trace-1",
      url: "https://langfuse/trace-1",
      rootOutput: "Implemented the ticket.",
      observations: [
        {
          name: "review call 1",
          type: "rlm-call",
          status: "ok",
          summary: "Reviewed the diff.",
          model: "claude-opus-5",
          durationMs: 12_000,
        },
        {
          name: "validation call 2",
          type: "rlm-call",
          status: "error",
          summary: "Session timed out.",
          durationMs: 2_000,
        },
      ],
    });
  });

  it("falls back to the run id when the attempt captured no Langfuse trace reference", async () => {
    const summary = await source.fetchSubmindTraceSummary(
      attempt({ runRecord: { schemaVersion: 1, runId: "run-2", calls: [] } }),
    );

    expect(summary).toMatchObject({ traceId: "run-2", observations: [] });
    expect(summary).not.toHaveProperty("url");
  });

  it("returns undefined for an attempt with no run record", async () => {
    await expect(source.fetchSubmindTraceSummary(attempt({}))).resolves.toBeUndefined();
    await expect(
      source.fetchSubmindTraceSummary({ id: "a1" } as ExecutionAttempt),
    ).resolves.toBeUndefined();
  });
});

function attempt(result: unknown): ExecutionAttempt {
  return { id: "attempt-1", result } as ExecutionAttempt;
}
