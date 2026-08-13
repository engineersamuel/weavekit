import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import type { RlmExecutionBudgetSnapshot } from "./budget.js";

const tracer = trace.getTracer("weavekit");

export type RlmSpanAttributes = {
  profile: string;
  model: string;
  prompt: string;
  toolCallId?: string;
  depthRemaining: number;
  maxDepth: number;
  budget: RlmExecutionBudgetSnapshot;
  modelRationale?: string;
  requestedModel?: string;
  modelFallback?: boolean;
  modelCandidates?: readonly string[];
};

export function buildRlmCallSpanName(attributes: RlmSpanAttributes): string {
  const depthUsed = attributes.maxDepth - attributes.depthRemaining + 1;
  const callNumber = attributes.budget.usedCalls + 1;
  return `RLM #${callNumber} d${depthUsed}/${attributes.maxDepth} · ${attributes.profile}`;
}

export function buildRlmRootSpanName(traceName: string): string {
  const mode = traceName === "rlm-poc-validation-scenario" ? "validation" : "orchestration";
  return `SUBMIND d0 · ${mode}`;
}

/**
 * Wraps one `rlm` tool invocation in a Langfuse-visible span (ADR 0010: the recursion tree must
 * be observable). Nested `rlm` calls made from within `operation` automatically become child
 * spans because they run inside this span's active OpenTelemetry context.
 */
export async function withRlmSpan<T>(
  attributes: RlmSpanAttributes,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  const depthUsed = attributes.maxDepth - attributes.depthRemaining + 1;
  const callNumber = attributes.budget.usedCalls + 1;
  return tracer.startActiveSpan(
    buildRlmCallSpanName(attributes),
    {
      attributes: {
        "langfuse.observation.type": "agent",
        "langfuse.observation.input": JSON.stringify({
          prompt: attributes.prompt,
          profile: attributes.profile,
          depthUsed,
          maxDepth: attributes.maxDepth,
          budget: attributes.budget,
        }),
        "gen_ai.system": "copilot-sdk",
        "gen_ai.operation.name": "rlm",
        "gen_ai.request.model": attributes.model,
        ...(attributes.modelRationale
          ? { "weavekit.rlm.model.rationale": attributes.modelRationale }
          : {}),
        ...(attributes.requestedModel
          ? { "weavekit.rlm.model.requested": attributes.requestedModel }
          : {}),
        ...(attributes.modelFallback !== undefined
          ? { "weavekit.rlm.model.used_fallback": attributes.modelFallback }
          : {}),
        ...(attributes.modelCandidates
          ? {
              "weavekit.rlm.model.candidates": JSON.stringify(attributes.modelCandidates),
            }
          : {}),
        ...(attributes.toolCallId
          ? {
              "gen_ai.tool.call.id": attributes.toolCallId,
              "weavekit.rlm.tool_call_id": attributes.toolCallId,
            }
          : {}),
        "weavekit.rlm.profile": attributes.profile,
        "weavekit.rlm.depth_used": depthUsed,
        "weavekit.rlm.depth_remaining": attributes.depthRemaining,
        "weavekit.rlm.max_depth": attributes.maxDepth,
        "weavekit.rlm.call_number": callNumber,
        "weavekit.rlm.budget.max_calls": attributes.budget.maxCalls,
        "weavekit.rlm.budget.used_calls": attributes.budget.usedCalls,
        "weavekit.rlm.budget.remaining_calls": attributes.budget.remainingCalls,
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
