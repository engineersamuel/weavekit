import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import type { TrellageProfile, TrellageTokenUsage, TrellageToolUseEvidence } from "./contracts.js";

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

export type TrellageResultTelemetry = {
  tokenUsage?: TrellageTokenUsage;
  costUsd?: number;
  premiumRequests?: number;
  durationMs?: number;
  changedFiles?: readonly string[];
  permissionDenials?: readonly string[];
  toolUses?: readonly TrellageToolUseEvidence[];
  toolUsesTruncated?: boolean;
};

export function buildTrellageResultAttributes(result: TrellageResultTelemetry): Attributes {
  const attributes: Attributes = {};
  const usageDetails: Record<string, number> = {};
  const usage = result.tokenUsage;
  if (usage?.inputTokens !== undefined) {
    attributes["gen_ai.usage.input_tokens"] = usage.inputTokens;
    usageDetails.input = usage.inputTokens;
  }
  if (usage?.outputTokens !== undefined) {
    attributes["gen_ai.usage.output_tokens"] = usage.outputTokens;
    usageDetails.output = usage.outputTokens;
  }
  if (usage?.cachedInputTokens !== undefined) {
    attributes["gen_ai.usage.cached_input_tokens"] = usage.cachedInputTokens;
    usageDetails.cached_input = usage.cachedInputTokens;
  }
  if (usage?.cacheCreationInputTokens !== undefined) {
    attributes["weavekit.trellage.usage.cache_creation_input_tokens"] =
      usage.cacheCreationInputTokens;
    usageDetails.cache_creation_input = usage.cacheCreationInputTokens;
  }
  const totalTokens =
    usage?.totalTokens ??
    (usage?.inputTokens !== undefined || usage?.outputTokens !== undefined
      ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      : undefined);
  if (totalTokens !== undefined) {
    usageDetails.total = totalTokens;
  }
  if (Object.keys(usageDetails).length > 0) {
    attributes["langfuse.observation.usage_details"] = JSON.stringify(usageDetails);
  }
  if (result.costUsd !== undefined) {
    attributes["weavekit.trellage.cost_usd"] = result.costUsd;
    attributes["langfuse.observation.cost_details"] = JSON.stringify({
      total: result.costUsd,
    });
  }
  if (result.durationMs !== undefined) {
    attributes["weavekit.trellage.duration_ms"] = result.durationMs;
  }
  if (result.premiumRequests !== undefined) {
    attributes["weavekit.trellage.premium_requests"] = result.premiumRequests;
  }
  if (result.changedFiles) {
    attributes["weavekit.trellage.changed_file_count"] = result.changedFiles.length;
  }
  if (result.permissionDenials) {
    attributes["weavekit.trellage.permission_denial_count"] = result.permissionDenials.length;
  }
  if (result.toolUses && result.toolUses.length > 0) {
    attributes["weavekit.trellage.tool_uses"] = JSON.stringify(result.toolUses);
    attributes["weavekit.trellage.tool_use_count"] = result.toolUses.reduce(
      (total, toolUse) => total + toolUse.count,
      0,
    );
  }
  if (result.toolUsesTruncated !== undefined) {
    attributes["weavekit.trellage.tool_uses_truncated"] = result.toolUsesTruncated;
  }
  return attributes;
}

export function recordTrellageResultAttributes(span: Span, result: TrellageResultTelemetry): void {
  span.setAttributes(buildTrellageResultAttributes(result));
}

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
