import { AsyncLocalStorage } from "node:async_hooks";
import { Collector } from "@boundaryml/baml";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import type { BamlRouteOptions } from "./bamlRouting.js";

export type BamlOperation = "normalize" | "assess" | "report";

export type BamlTelemetryContext = {
  runId?: string;
  roundNumber?: number;
  personaId?: string;
};

type BamlTelemetryScope = {
  collector: Collector;
  span: Span;
  operation: BamlOperation | "route-model-call";
};

export type TraceBamlOperationDecorator = <This, Args extends unknown[], Return>(
  target: (this: This, ...args: Args) => Promise<Return>,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Return>>,
) => (this: This, ...args: Args) => Promise<Return>;

const tracer = trace.getTracer("weavekit.decision-council");
const telemetryScope = new AsyncLocalStorage<BamlTelemetryScope>();
const MAX_ATTRIBUTE_CHARS = 5 * 1024;
const MAX_STRING_CHARS = 256;

function truncateTelemetryValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_CHARS) return value;
    return `${value.slice(0, MAX_STRING_CHARS)}...<truncated ${value.length - MAX_STRING_CHARS} chars>`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateTelemetryValue(item, seen));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncateTelemetryValue(item, seen)]));
}

export function serializeTelemetryAttribute(value: unknown): string {
  try {
    const serialized = JSON.stringify(truncateTelemetryValue(value));
    if (serialized === undefined) {
      return "null";
    }
    if (serialized.length <= MAX_ATTRIBUTE_CHARS) {
      return serialized;
    }
    return JSON.stringify({
      truncated: true,
      preview: serialized.slice(0, MAX_ATTRIBUTE_CHARS - 256),
    });
  } catch {
    return '"[unserializable]"';
  }
}

export function setSerializedAttribute(span: Span, key: string, value: unknown): void {
  span.setAttribute(key, serializeTelemetryAttribute(value));
}

export function createCollectorTagMap(context: BamlTelemetryContext): Record<string, string> {
  const tags: Record<string, string> = {};
  if (context.runId) tags.runId = context.runId;
  if (context.roundNumber !== undefined) tags.roundNumber = String(context.roundNumber);
  if (context.personaId) tags.personaId = context.personaId;
  return tags;
}

function setContextAttributes(span: Span, context: BamlTelemetryContext): void {
  if (context.runId) span.setAttribute("weavekit.decision_council.run_id", context.runId);
  if (context.roundNumber !== undefined) {
    span.setAttribute("weavekit.decision_council.round_number", context.roundNumber);
  }
  if (context.personaId) span.setAttribute("weavekit.decision_council.persona_id", context.personaId);
}

function setCollectorAttributes(span: Span, collector: Collector): void {
  span.setAttribute("weavekit.decision_council.collector_log_count", collector.logs.length);
  const log = collector.last;
  if (log) {
    span.setAttribute("weavekit.decision_council.function_name", log.functionName);
    span.setAttribute("weavekit.decision_council.log_type", log.logType);
    if (log.timing?.durationMs !== null && log.timing?.durationMs !== undefined) {
      span.setAttribute("weavekit.decision_council.baml_duration_ms", log.timing.durationMs);
    }
  }

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
  const usageDetails: Record<string, number> = {};
  if (usage?.inputTokens !== null && usage?.inputTokens !== undefined) {
    usageDetails.input = usage.inputTokens;
  }
  if (usage?.outputTokens !== null && usage?.outputTokens !== undefined) {
    usageDetails.output = usage.outputTokens;
  }
  if (usageDetails.input !== undefined || usageDetails.output !== undefined) {
    usageDetails.total = (usageDetails.input ?? 0) + (usageDetails.output ?? 0);
  }
  if (usage?.cachedInputTokens !== null && usage?.cachedInputTokens !== undefined) {
    usageDetails.cached_input = usage.cachedInputTokens;
  }
  if (Object.keys(usageDetails).length > 0) {
    setSerializedAttribute(span, "langfuse.observation.usage_details", usageDetails);
  }
}

export async function runTracedBamlOperation<Return>(
  operation: BamlOperation | "route-model-call",
  args: unknown,
  target: () => Promise<Return>,
): Promise<Return> {
  return tracer.startActiveSpan(`run.council.baml.${operation}`, async (span) => {
    span.setAttribute("gen_ai.system", "baml");
    span.setAttribute("gen_ai.operation.name", operation);
    span.setAttribute("weavekit.decision_council.operation", operation);
    setSerializedAttribute(span, "weavekit.decision_council.args", args);
    setSerializedAttribute(span, "langfuse.observation.input", args);
    const collector = new Collector(`decision-council.${operation}`);

    return telemetryScope.run({ collector, span, operation }, async () => {
      try {
        const result = await target();
        setSerializedAttribute(span, "weavekit.decision_council.result", result);
        setSerializedAttribute(span, "langfuse.observation.output", result);
        setCollectorAttributes(span, collector);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        setCollectorAttributes(span, collector);
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    });
  });
}

export function createBamlTelemetryOptions(
  context: BamlTelemetryContext = {},
): Pick<BamlRouteOptions, "collector" | "tags"> {
  const scope = telemetryScope.getStore();
  const tags = createCollectorTagMap(context);
  if (scope) {
    if (scope.operation === "normalize" && context.personaId) {
      const spanName = `run.council.baml.persona.${context.personaId}`;
      scope.span.updateName(spanName);
    }
    setContextAttributes(scope.span, context);
  }

  return {
    ...(scope ? { collector: scope.collector } : {}),
    tags,
  };
}

export function TraceBamlOperation(operation: BamlOperation): any {
  return function traceBamlOperation(
    targetOrValue: unknown,
    contextOrKey: unknown,
    descriptor?: PropertyDescriptor,
  ) {
    if (descriptor) {
      const original = descriptor.value;
      if (typeof original !== "function") {
        return descriptor;
      }

      descriptor.value = function tracedBamlOperation(this: unknown, ...args: unknown[]) {
        return runTracedBamlOperation(operation, args, () => original.apply(this, args));
      };
      return descriptor;
    }

    const target = targetOrValue as (this: unknown, ...args: unknown[]) => Promise<unknown>;
    const _context = contextOrKey as ClassMethodDecoratorContext<
      unknown,
      (this: unknown, ...args: unknown[]) => Promise<unknown>
    >;

    return async function tracedBamlOperation(this: unknown, ...args: unknown[]): Promise<unknown> {
      return runTracedBamlOperation(operation, args, () => target.apply(this, args));
    };
  } as any;
}
