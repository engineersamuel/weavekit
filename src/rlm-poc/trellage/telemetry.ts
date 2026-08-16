import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import type { TrellageProfile } from "./contracts.js";

const tracer = trace.getTracer("weavekit");

export type TrellageSpanAttributes = {
  harness: string;
  profile: TrellageProfile;
  prompt: string;
  command: string;
  worktreePath: string;
  branchName: string;
  toolCallId?: string;
  callNumber: number;
};

export type TrellageAttemptSpanAttributes = {
  profile: TrellageProfile;
  attempt: number;
  argv: readonly string[];
};

/**
 * Wraps one `invoke_trellage` invocation in a Langfuse-visible span.
 *
 * It nests under the calling `rlm` span automatically via the active OpenTelemetry context, so a
 * delegated harness that stalls or ends `unclassifiable` is diagnosable from the trace alone —
 * which matters more here than for `rlm`, because the harness runs in a pane the operator may
 * never look at.
 */
export async function withTrellageSpan<T>(
  attributes: TrellageSpanAttributes,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    `TRELLAGE #${attributes.callNumber} · ${attributes.harness}/${attributes.profile.name}`,
    {
      attributes: {
        "langfuse.observation.type": "agent",
        "langfuse.observation.input": JSON.stringify({
          prompt: attributes.prompt,
          harness: attributes.harness,
          profile: attributes.profile.name,
          mode: attributes.profile.mode,
          command: attributes.command,
        }),
        "gen_ai.operation.name": "invoke_trellage",
        "gen_ai.system": attributes.profile.harness,
        ...(attributes.toolCallId ? { "gen_ai.tool.call.id": attributes.toolCallId } : {}),
        "weavekit.trellage.harness": attributes.harness,
        "weavekit.trellage.profile": attributes.profile.name,
        "weavekit.trellage.mode": attributes.profile.mode,
        "weavekit.trellage.launcher": attributes.profile.launcher,
        "weavekit.trellage.command": attributes.command,
        "weavekit.trellage.worktree_path": attributes.worktreePath,
        "weavekit.trellage.branch": attributes.branchName,
      },
    },
    async (span) => {
      try {
        const result = await operation(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        const exception = error instanceof Error ? error : new Error(String(error));
        span.setAttribute(
          "langfuse.observation.output",
          JSON.stringify({ status: "failed", error: exception.message }),
        );
        span.recordException(exception);
        span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Records one child process attempt without adding terminal text or raw JSONL to telemetry. */
export async function withTrellageAttemptSpan<T>(
  attributes: TrellageAttemptSpanAttributes,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    `TRELLAGE attempt ${attributes.attempt} · ${attributes.profile.launcher}/${attributes.profile.name}`,
    {
      attributes: {
        "langfuse.observation.type": "agent",
        "gen_ai.operation.name": "invoke_trellage_attempt",
        "gen_ai.system": attributes.profile.harness,
        "weavekit.trellage.attempt": attributes.attempt,
        "weavekit.trellage.launcher": attributes.profile.launcher,
        "weavekit.trellage.profile": attributes.profile.name,
        "weavekit.trellage.argv": JSON.stringify(attributes.argv),
      },
    },
    async (span) => {
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
    },
  );
}
