import type { Attributes, Span } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MastermindAction } from "../../src/mastermind/domain/events.js";
import {
  buildLangfuseTraceUrl,
  createLeaseTelemetryAccumulator,
  executionTelemetryAttributes,
  langfuseExportConfigured,
  mastermindWorkFailureMessage,
  validateReviewWebFetchUrl,
} from "../../src/mastermind/telemetry.js";

const envKeys = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PROJECT_ID",
] as const;

let envSnapshot = new Map<string, string | undefined>();

beforeEach(() => {
  envSnapshot = new Map(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of envKeys) {
    const value = envSnapshot.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

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

describe("Mastermind telemetry", () => {
  it("records execution correlation without paths, prompts, or terminal output", () => {
    const attributes = executionTelemetryAttributes({
      work: {
        id: "work-one",
        organizationId: "organization-one",
        issueId: "issue-one",
        projectPolicyId: "weavekit",
        state: "running",
        plannedAction: MastermindAction.IMPLEMENT_DIRECTLY,
        currentExecutionAttemptId: "attempt-one",
        retryCount: 0,
        rowVersion: 3,
        createdAt: "2026-08-06T12:00:00.000Z",
        updatedAt: "2026-08-06T12:01:00.000Z",
      },
      attempt: {
        id: "attempt-one",
        workId: "work-one",
        attemptNumber: 1,
        action: MastermindAction.IMPLEMENT_DIRECTLY,
        projectPolicyId: "weavekit",
        projectPolicyVersion: "policy-one",
        executorKind: "herdr-copilot",
        state: "running",
        retryEligible: false,
        rowVersion: 2,
        createdAt: "2026-08-06T12:00:00.000Z",
        updatedAt: "2026-08-06T12:01:00.000Z",
      },
      repositoryMode: "EXISTING_REPOSITORY",
    });

    expect(attributes).toMatchObject({
      "weavekit.mastermind.work_id": "work-one",
      "weavekit.mastermind.execution.attempt_id": "attempt-one",
      "weavekit.mastermind.execution.attempt_number": 1,
      "weavekit.mastermind.execution.executor_kind": "herdr-copilot",
      "weavekit.mastermind.execution.repository_mode": "EXISTING_REPOSITORY",
    });
    expect(Object.keys(attributes).join(" ")).not.toMatch(/path|prompt|terminal/u);
  });

  it("builds a direct Langfuse trace URL for the configured project", () => {
    process.env.LANGFUSE_BASE_URL = "http://localhost:3000/";
    process.env.LANGFUSE_PROJECT_ID = "project-one";

    expect(buildLangfuseTraceUrl("trace-one")).toBe(
      "http://localhost:3000/project/project-one/traces/trace-one",
    );
  });

  it("requires both Langfuse credentials before reporting export as configured", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    expect(langfuseExportConfigured()).toBe(false);

    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    expect(langfuseExportConfigured()).toBe(true);
  });

  it("turns terminal failed work into an explicit trace error message", () => {
    expect(
      mastermindWorkFailureMessage({
        state: "failed",
        failureReasons: ["Repository evidence is invalid."],
      }),
    ).toBe("Mastermind work failed: Repository evidence is invalid.");
    expect(mastermindWorkFailureMessage({ state: "action_planned" })).toBeUndefined();
  });

  it("hashes review web_fetch URL metadata without exposing raw URL parts", () => {
    const validation = validateReviewWebFetchUrl(
      "https://example.com/docs?q=private-token#fragment",
      {
        toolCallId: "call-one",
      },
    );

    expect(validation).toMatchObject({
      accepted: true,
      reason: "valid",
      metadata: {
        decision: "approved",
        reason: "valid",
        rawStringLength: 49,
        retryable: false,
        scheme: "https:",
        toolCallId: "call-one",
      },
    });
    expect(validation.metadata.urlFingerprint).toHaveLength(16);
    expect(validation.metadata.hostnameFingerprint).toHaveLength(16);
    expect(validation.metadata.pathnameFingerprint).toHaveLength(16);
    expect(JSON.stringify(validation.metadata)).not.toContain("example.com");
    expect(JSON.stringify(validation.metadata)).not.toContain("/docs");
    expect(JSON.stringify(validation.metadata)).not.toContain("private-token");
    expect(JSON.stringify(validation.metadata)).not.toContain("fragment");
  });

  it("classifies malformed, unsupported, and credentialed review URLs safely", () => {
    expect(validateReviewWebFetchUrl("not a URL")).toMatchObject({
      accepted: false,
      reason: "invalid_url",
      metadata: {
        reason: "invalid_url",
        retryable: true,
      },
    });
    expect(validateReviewWebFetchUrl("http://example.com")).toMatchObject({
      accepted: false,
      reason: "unsupported_scheme",
      metadata: {
        scheme: "http:",
        retryable: true,
      },
    });
    expect(validateReviewWebFetchUrl("https://")).toMatchObject({
      accepted: false,
      reason: "missing_host",
      metadata: {
        scheme: "https:",
        retryable: true,
      },
    });
    expect(validateReviewWebFetchUrl("https://user:pass@example.com/private")).toMatchObject({
      accepted: false,
      reason: "embedded_credentials",
      metadata: {
        scheme: "https:",
        retryable: false,
      },
    });
  });

  it("tracks aggregate lease telemetry and emits only one terminal event", () => {
    const span = createFakeLeaseSpan();
    let currentTime = new Date("2026-08-05T20:00:00.000Z");
    const telemetry = createLeaseTelemetryAccumulator({
      span,
      workId: "work-one",
      durationMs: 600,
      intervalMs: 150,
      clock: () => currentTime,
    });

    telemetry.recordSuccess(currentTime);
    currentTime = new Date("2026-08-05T20:00:00.150Z");
    telemetry.recordSuccess(currentTime);
    telemetry.finish();

    expect(span.attributes).toMatchObject({
      "weavekit.mastermind.lease.duration_ms": 600,
      "weavekit.mastermind.lease.heartbeat_interval_ms": 150,
      "weavekit.mastermind.lease.renewal_count": 2,
      "weavekit.mastermind.lease.last_renewed_at": "2026-08-05T20:00:00.150Z",
      "weavekit.mastermind.lease.latest_expiry_at": "2026-08-05T20:00:00.750Z",
      "weavekit.mastermind.lease.status": "stopped",
      "weavekit.mastermind.lease.stopped_at": "2026-08-05T20:00:00.150Z",
    });
    expect(span.events).toEqual([]);
  });

  it("keeps lost and error lease status terminal and idempotent", () => {
    const lostSpan = createFakeLeaseSpan();
    const lostTelemetry = createLeaseTelemetryAccumulator({
      span: lostSpan,
      workId: "work-lost",
      durationMs: 600,
      intervalMs: 150,
      clock: () => new Date("2026-08-05T20:01:00.000Z"),
    });
    lostTelemetry.recordSuccess(new Date("2026-08-05T20:00:59.500Z"));
    lostTelemetry.recordLost();
    lostTelemetry.finish();
    lostTelemetry.recordLost();
    expect(lostSpan.attributes["weavekit.mastermind.lease.status"]).toBe("lost");
    expect(lostSpan.events).toHaveLength(1);
    expect(lostSpan.events[0]).toMatchObject({
      name: "mastermind.lease.status",
      attributes: expect.objectContaining({
        "weavekit.mastermind.lease.status": "lost",
        "weavekit.mastermind.lease.renewal_count": 1,
      }),
    });

    const errorSpan = createFakeLeaseSpan();
    const errorTelemetry = createLeaseTelemetryAccumulator({
      span: errorSpan,
      workId: "work-error",
      durationMs: 600,
      intervalMs: 150,
      clock: () => new Date("2026-08-05T20:02:00.000Z"),
    });
    errorTelemetry.recordError(new Error("renewal exploded\nwith stack context"));
    errorTelemetry.finish();
    errorTelemetry.recordError(new Error("second error"));
    expect(errorSpan.attributes["weavekit.mastermind.lease.status"]).toBe("error");
    expect(errorSpan.events).toHaveLength(1);
    expect(errorSpan.events[0]).toMatchObject({
      name: "mastermind.lease.status",
      attributes: expect.objectContaining({
        "weavekit.mastermind.lease.status": "error",
        "weavekit.mastermind.lease.error_type": "Error",
        "weavekit.mastermind.lease.error_message": "renewal exploded with stack context",
      }),
    });
  });

  it("ignores late lost and error signals after the lease finishes", () => {
    const span = createFakeLeaseSpan();
    const telemetry = createLeaseTelemetryAccumulator({
      span,
      workId: "work-stopped",
      durationMs: 600,
      intervalMs: 150,
      clock: () => new Date("2026-08-05T20:03:00.000Z"),
    });

    telemetry.recordSuccess(new Date("2026-08-05T20:02:59.500Z"));
    telemetry.finish();
    telemetry.recordLost();
    telemetry.recordError(new Error("late renewal failure"));

    expect(span.attributes["weavekit.mastermind.lease.status"]).toBe("stopped");
    expect(span.events).toEqual([]);
  });
});
