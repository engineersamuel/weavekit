import { createHash } from "node:crypto";
import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import type { Collector } from "@boundaryml/baml";
import type { ExecutionAttempt, LinearTicketSnapshot, MastermindWorkItem } from "./store/store.js";

const tracer = trace.getTracer("weavekit");
const invalidTraceId = "00000000000000000000000000000000";

export type MastermindTraceInfo = {
  traceId: string;
  url?: string;
};

export type SafeReviewUrlMetadata = {
  decision: "approved" | "rejected";
  reason: "valid" | "invalid_url" | "unsupported_scheme" | "missing_host" | "embedded_credentials";
  rawStringLength: number;
  urlFingerprint: string;
  retryable: boolean;
  scheme?: string;
  hostnameFingerprint?: string;
  pathnameFingerprint?: string;
  toolCallId?: string;
};

export type ReviewUrlValidation =
  | {
      accepted: true;
      reason: "valid";
      metadata: SafeReviewUrlMetadata;
    }
  | {
      accepted: false;
      reason: "invalid_url" | "unsupported_scheme" | "missing_host" | "embedded_credentials";
      metadata: SafeReviewUrlMetadata;
      feedback: string;
    };

export type LeaseTelemetryAccumulator = {
  recordSuccess(renewedAt: Date): void;
  recordLost(): void;
  recordError(error: Error): void;
  finish(): void;
};

export async function traceMastermindWork<T>(
  workId: string,
  onTraceStarted: ((trace: MastermindTraceInfo) => void) | undefined,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    "mastermind.work",
    {
      attributes: {
        "weavekit.mastermind.work_id": workId,
        "langfuse.trace.name": "mastermind-linear-ticket",
        "langfuse.observation.type": "chain",
        "langfuse.trace.input": serializeTelemetryValue({ workId }),
      },
    },
    async (span) => {
      try {
        const traceInfo = currentMastermindTrace(span);
        if (traceInfo && langfuseExportConfigured()) {
          onTraceStarted?.(traceInfo);
        }
        const result = await operation(span);
        span.setAttribute("langfuse.trace.output", serializeTelemetryValue(result));
        const failureMessage = mastermindWorkFailureMessage(result);
        span.setStatus(
          failureMessage
            ? { code: SpanStatusCode.ERROR, message: failureMessage }
            : { code: SpanStatusCode.OK },
        );
        return result;
      } catch (error) {
        const exception = error instanceof Error ? error : new Error(String(error));
        span.recordException(exception);
        span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function mastermindWorkFailureMessage(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  if (record.state !== "failed") {
    return undefined;
  }
  const reasons = Array.isArray(record.failureReasons)
    ? record.failureReasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  return reasons.length > 0
    ? `Mastermind work failed: ${reasons.join("; ")}`
    : "Mastermind work finished in failed state.";
}

export async function withMastermindSpan<T>(
  name: string,
  attributes: Attributes,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await operation(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const exception = error instanceof Error ? error : new Error(String(error));
      span.recordException(exception);
      span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function setMastermindWorkAttributes(span: Span, work: MastermindWorkItem): void {
  setSpanAttributes(span, {
    "weavekit.mastermind.issue_id": work.issueId,
    "weavekit.mastermind.state": work.state,
    "weavekit.mastermind.retry_count": work.retryCount,
    ...(work.projectPolicyId
      ? { "weavekit.mastermind.project_policy_id": work.projectPolicyId }
      : {}),
    ...(work.plannedAction ? { "weavekit.mastermind.planned_action": work.plannedAction } : {}),
  });
}

export function executionTelemetryAttributes(input: {
  work: MastermindWorkItem;
  attempt?: ExecutionAttempt;
  repositoryMode?: string;
}): Attributes {
  return {
    "weavekit.mastermind.work_id": input.work.id,
    "weavekit.mastermind.issue_id": input.work.issueId,
    "weavekit.mastermind.execution.state": input.work.state,
    ...(input.attempt
      ? {
          "weavekit.mastermind.execution.attempt_id": input.attempt.id,
          "weavekit.mastermind.execution.attempt_number": input.attempt.attemptNumber,
          "weavekit.mastermind.execution.executor_kind": input.attempt.executorKind,
          "weavekit.mastermind.execution.project_policy_id": input.attempt.projectPolicyId,
          "weavekit.mastermind.execution.project_policy_version":
            input.attempt.projectPolicyVersion,
        }
      : {}),
    ...(input.repositoryMode
      ? { "weavekit.mastermind.execution.repository_mode": input.repositoryMode }
      : {}),
  };
}

export function setMastermindTicketAttributes(span: Span, ticket: LinearTicketSnapshot): void {
  setSpanAttributes(span, {
    "weavekit.mastermind.ticket.identifier": ticket.identifier,
    "weavekit.mastermind.ticket.url": ticket.url,
    "weavekit.mastermind.ticket.status": ticket.status,
    "langfuse.trace.metadata": serializeTelemetryValue({
      issueId: ticket.id,
      identifier: ticket.identifier,
      url: ticket.url,
      status: ticket.status,
      projectId: ticket.projectId,
      teamId: ticket.teamId,
    }),
  });
}

export function setMastermindSpanInput(span: Span, input: unknown): void {
  span.setAttribute("langfuse.observation.input", serializeTelemetryValue(input));
}

export function setMastermindSpanOutput(span: Span, output: unknown): void {
  span.setAttribute("langfuse.observation.output", serializeTelemetryValue(output));
}

export function setMastermindBamlUsage(span: Span, collector: Collector): void {
  const usage = collector.usage;
  if (usage?.inputTokens !== null && usage?.inputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
  }
  if (usage?.outputTokens !== null && usage?.outputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
  }
  if (usage?.cachedInputTokens !== null && usage?.cachedInputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.cached_input_tokens", usage.cachedInputTokens);
  }
  const log = collector.last;
  if (log?.timing?.durationMs !== null && log?.timing?.durationMs !== undefined) {
    span.setAttribute("weavekit.mastermind.baml.duration_ms", log.timing.durationMs);
  }
}

export function addMastermindProgressEvent(message: string): void {
  trace.getActiveSpan()?.addEvent("mastermind.progress", {
    "weavekit.mastermind.progress": message,
  });
}

export function validateReviewWebFetchUrl(
  rawUrl: string,
  options: {
    toolCallId?: string;
  } = {},
): ReviewUrlValidation {
  const metadata = {
    rawStringLength: rawUrl.length,
    urlFingerprint: truncatedSha256(rawUrl),
    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
  };
  const missingHostMatch = rawUrl.match(/^([a-z][a-z0-9+.-]*):\/\/(?:[/?#]|$)/iu);
  if (missingHostMatch) {
    const scheme = `${missingHostMatch[1]!.toLowerCase()}:`;
    return scheme === "https:"
      ? {
          accepted: false,
          reason: "missing_host",
          feedback: "web_fetch requires an absolute HTTPS URL without embedded credentials.",
          metadata: {
            decision: "rejected",
            reason: "missing_host",
            retryable: true,
            ...metadata,
            scheme,
          },
        }
      : {
          accepted: false,
          reason: "unsupported_scheme",
          feedback: "web_fetch requires an absolute HTTPS URL without embedded credentials.",
          metadata: {
            decision: "rejected",
            reason: "unsupported_scheme",
            retryable: true,
            ...metadata,
            scheme,
          },
        };
  }

  try {
    const parsed = new URL(rawUrl);
    const parsedMetadata = {
      ...metadata,
      scheme: parsed.protocol,
      hostnameFingerprint: parsed.hostname ? truncatedSha256(parsed.hostname) : undefined,
      pathnameFingerprint: truncatedSha256(parsed.pathname || "/"),
    };
    if (parsed.protocol !== "https:") {
      return {
        accepted: false,
        reason: "unsupported_scheme",
        feedback: "web_fetch requires an absolute HTTPS URL without embedded credentials.",
        metadata: {
          decision: "rejected",
          reason: "unsupported_scheme",
          retryable: true,
          ...parsedMetadata,
        },
      };
    }
    if (!parsed.hostname) {
      return {
        accepted: false,
        reason: "missing_host",
        feedback: "web_fetch requires an absolute HTTPS URL without embedded credentials.",
        metadata: {
          decision: "rejected",
          reason: "missing_host",
          retryable: true,
          ...parsedMetadata,
        },
      };
    }
    if (parsed.username || parsed.password) {
      return {
        accepted: false,
        reason: "embedded_credentials",
        feedback: "web_fetch requires an absolute HTTPS URL without embedded credentials.",
        metadata: {
          decision: "rejected",
          reason: "embedded_credentials",
          retryable: false,
          ...parsedMetadata,
        },
      };
    }
    return {
      accepted: true,
      reason: "valid",
      metadata: {
        decision: "approved",
        reason: "valid",
        retryable: false,
        ...parsedMetadata,
      },
    };
  } catch {
    return {
      accepted: false,
      reason: "invalid_url",
      feedback: "web_fetch requires an absolute HTTPS URL without embedded credentials.",
      metadata: {
        decision: "rejected",
        reason: "invalid_url",
        retryable: true,
        ...metadata,
      },
    };
  }
}

export function addMastermindWebFetchPermissionEvent(
  span: Pick<Span, "addEvent">,
  validation: ReviewUrlValidation,
): void {
  span.addEvent("mastermind.web_fetch.permission", {
    "weavekit.mastermind.web_fetch.decision": validation.metadata.decision,
    "weavekit.mastermind.web_fetch.reason": validation.metadata.reason,
    "weavekit.mastermind.web_fetch.raw_length": validation.metadata.rawStringLength,
    "weavekit.mastermind.web_fetch.url_fingerprint": validation.metadata.urlFingerprint,
    "weavekit.mastermind.web_fetch.retryable": validation.metadata.retryable,
    ...(validation.metadata.scheme
      ? { "weavekit.mastermind.web_fetch.scheme": validation.metadata.scheme }
      : {}),
    ...(validation.metadata.hostnameFingerprint
      ? {
          "weavekit.mastermind.web_fetch.hostname_fingerprint":
            validation.metadata.hostnameFingerprint,
        }
      : {}),
    ...(validation.metadata.pathnameFingerprint
      ? {
          "weavekit.mastermind.web_fetch.pathname_fingerprint":
            validation.metadata.pathnameFingerprint,
        }
      : {}),
    ...(validation.metadata.toolCallId
      ? { "weavekit.mastermind.web_fetch.tool_call_id": validation.metadata.toolCallId }
      : {}),
  });
}

export function createLeaseTelemetryAccumulator(args: {
  span: Pick<Span, "addEvent" | "setAttribute">;
  workId: string;
  durationMs: number;
  intervalMs: number;
  clock?: () => Date;
}): LeaseTelemetryAccumulator {
  let renewalCount = 0;
  let status: "active" | "stopped" | "lost" | "error" = "active";
  let terminalEventRecorded = false;
  setLeaseAttribute(args.span, "duration_ms", args.durationMs);
  setLeaseAttribute(args.span, "heartbeat_interval_ms", args.intervalMs);
  setLeaseAttribute(args.span, "renewal_count", renewalCount);
  setLeaseAttribute(args.span, "status", status);

  return {
    recordSuccess(renewedAt: Date) {
      if (status !== "active") {
        return;
      }
      renewalCount += 1;
      setLeaseAttribute(args.span, "renewal_count", renewalCount);
      setLeaseAttribute(args.span, "last_renewed_at", renewedAt.toISOString());
      setLeaseAttribute(
        args.span,
        "latest_expiry_at",
        new Date(renewedAt.getTime() + args.durationMs).toISOString(),
      );
      setLeaseAttribute(args.span, "status", status);
    },
    recordLost() {
      if (status !== "active") {
        return;
      }
      status = "lost";
      setLeaseAttribute(args.span, "status", status);
      if (!terminalEventRecorded) {
        terminalEventRecorded = true;
        args.span.addEvent("mastermind.lease.status", {
          "weavekit.mastermind.work_id": args.workId,
          "weavekit.mastermind.lease.status": status,
          "weavekit.mastermind.lease.renewal_count": renewalCount,
          "weavekit.mastermind.lease.heartbeat_interval_ms": args.intervalMs,
          "weavekit.mastermind.lease.observed_at": (
            args.clock ?? (() => new Date())
          )().toISOString(),
        });
      }
    },
    recordError(error: Error) {
      if (status !== "active") {
        return;
      }
      status = "error";
      setLeaseAttribute(args.span, "status", status);
      if (!terminalEventRecorded) {
        terminalEventRecorded = true;
        args.span.addEvent("mastermind.lease.status", {
          "weavekit.mastermind.work_id": args.workId,
          "weavekit.mastermind.lease.status": status,
          "weavekit.mastermind.lease.renewal_count": renewalCount,
          "weavekit.mastermind.lease.heartbeat_interval_ms": args.intervalMs,
          "weavekit.mastermind.lease.error_type": error.name || "Error",
          "weavekit.mastermind.lease.error_message": sanitizeTelemetryErrorMessage(error.message),
          "weavekit.mastermind.lease.observed_at": (
            args.clock ?? (() => new Date())
          )().toISOString(),
        });
      }
    },
    finish() {
      if (status !== "active") {
        return;
      }
      status = "stopped";
      setLeaseAttribute(args.span, "status", status);
      setLeaseAttribute(
        args.span,
        "stopped_at",
        (args.clock ?? (() => new Date()))().toISOString(),
      );
    },
  };
}

export function langfuseExportConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() && process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

export function buildLangfuseTraceUrl(traceId: string): string | undefined {
  const projectId = process.env.LANGFUSE_PROJECT_ID?.trim();
  if (!projectId) {
    return undefined;
  }
  const baseUrl = (process.env.LANGFUSE_BASE_URL?.trim() || "https://cloud.langfuse.com").replace(
    /\/+$/u,
    "",
  );
  return `${baseUrl}/project/${encodeURIComponent(projectId)}/traces/${traceId}`;
}

function currentMastermindTrace(span: Span): MastermindTraceInfo | undefined {
  const traceId = span.spanContext().traceId;
  if (!traceId || traceId === invalidTraceId) {
    return undefined;
  }
  const url = buildLangfuseTraceUrl(traceId);
  return {
    traceId,
    ...(url ? { url } : {}),
  };
}

function serializeTelemetryValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return '"[unserializable]"';
  }
}

function truncatedSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function sanitizeTelemetryErrorMessage(message: string): string {
  return message.replace(/\s+/gu, " ").trim().slice(0, 200);
}

function setLeaseAttribute(
  span: Pick<Span, "setAttribute">,
  attribute: string,
  value: boolean | number | string,
): void {
  span.setAttribute(`weavekit.mastermind.lease.${attribute}`, value);
}

function setSpanAttributes(span: Span, attributes: Attributes): void {
  if ("setAttributes" in span && typeof span.setAttributes === "function") {
    span.setAttributes(attributes);
    return;
  }
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      span.setAttribute(key, value);
    }
  }
}
