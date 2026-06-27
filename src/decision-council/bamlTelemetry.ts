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
};

export type TraceBamlOperationDecorator = <This, Args extends unknown[], Return>(
  target: (this: This, ...args: Args) => Promise<Return>,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Return>>,
) => (this: This, ...args: Args) => Promise<Return>;

const tracer = trace.getTracer("weavekit.decision-council");
const telemetryScope = new AsyncLocalStorage<BamlTelemetryScope>();
const MAX_ATTRIBUTE_CHARS = 5 * 1024;

function serializeTelemetryAttribute(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return "null";
    }
    return serialized.length > MAX_ATTRIBUTE_CHARS ? serialized.slice(0, MAX_ATTRIBUTE_CHARS) : serialized;
  } catch {
    return '"[unserializable]"';
  }
}

function setSerializedAttribute(span: Span, key: string, value: unknown): void {
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
    const collector = new Collector(`decision-council.${operation}`);

    return telemetryScope.run({ collector, span }, async () => {
      try {
        const result = await target();
        setSerializedAttribute(span, "weavekit.decision_council.result", result);
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
    setContextAttributes(scope.span, context);
  }

  return {
    ...(scope ? { collector: scope.collector } : {}),
    tags,
  };
}

export function TraceBamlOperation(operation: BamlOperation): TraceBamlOperationDecorator {
  return function <This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Promise<Return>,
    _context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Return>>,
  ) {
    return async function tracedBamlOperation(this: This, ...args: Args): Promise<Return> {
      return runTracedBamlOperation(operation, args, () => target.apply(this, args));
    };
  };
}
