import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

export type TelemetryHandle = { shutdown(): Promise<void> };

const noopHandle: TelemetryHandle = { async shutdown() {} };
const defaultLangfuseBaseUrl = "https://cloud.langfuse.com";
const rawContentRedactionMessage = "<redacted; set LANGFUSE_EXPORT_RAW=true to export raw prompts and responses>";

export function telemetryEnabled(): boolean {
  return process.env.OTEL_SDK_DISABLED !== "true";
}

type LangfuseConfig = {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
};

function readLangfuseConfig(): LangfuseConfig | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return null;

  return {
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL ?? defaultLangfuseBaseUrl,
  };
}

function isRawExportEnabled(): boolean {
  return process.env.LANGFUSE_EXPORT_RAW === "true";
}

function redactLangfuseValue(data: unknown): unknown {
  if (isRawExportEnabled()) return data;

  if (data === null || data === undefined) return data;
  if (typeof data === "string") return rawContentRedactionMessage;
  if (typeof data === "number" || typeof data === "boolean" || typeof data === "bigint") return data;
  if (typeof data === "symbol" || typeof data === "function") return rawContentRedactionMessage;
  return rawContentRedactionMessage;
}

function buildLangfuseMask(): ((params: { data: unknown }) => unknown) | undefined {
  if (isRawExportEnabled()) return undefined;

  return ({ data }) => redactLangfuseValue(data);
}

function hasGenAiAttributes(span: ReadableSpan | null | undefined): boolean {
  if (!span?.attributes) return false;
  return Object.keys(span.attributes).some((key) => key.startsWith("gen_ai."));
}

function ensureInstrumentationScope(span: ReadableSpan | null | undefined): void {
  if (!span || typeof span !== "object") return;

  const currentScope = (span as ReadableSpan & { instrumentationScope?: { name?: string; version?: string } }).instrumentationScope;
  if (currentScope?.name) return;

  const library = (span as ReadableSpan & { instrumentationLibrary?: { name?: string; version?: string } })
    .instrumentationLibrary;
  const name = library?.name || "unknown";
  const version = library?.version;
  (span as ReadableSpan & { instrumentationScope?: { name: string; version?: string } }).instrumentationScope = {
    name,
    ...(version ? { version } : {}),
  };
}

function isWeavekitSpan(span: ReadableSpan | null | undefined): boolean {
  if (!span) return false;
  const scope = (span as ReadableSpan & { instrumentationScope?: { name?: string } }).instrumentationScope;
  return span.instrumentationLibrary?.name === "weavekit" || scope?.name === "weavekit";
}

function isCouncilSpan(span: ReadableSpan | null | undefined): boolean {
  if (!span?.name) return false;
  return span.name === "council-run" || span.name.startsWith("run.council.");
}

function isWorkQueueSpan(span: ReadableSpan | null | undefined): boolean {
  if (!span?.name) return false;
  return span.name.startsWith("work-queue.beads.");
}

function shouldExportToLangfuse(otelSpan: ReadableSpan | null | undefined): boolean {
  if (!otelSpan) return false;
  ensureInstrumentationScope(otelSpan);
  if (isWeavekitSpan(otelSpan) || isCouncilSpan(otelSpan) || isWorkQueueSpan(otelSpan)) return true;
  if (hasGenAiAttributes(otelSpan)) return true;
  try {
    return isDefaultExportSpan(otelSpan);
  } catch {
    return false;
  }
}

function buildSpanProcessors(): SpanProcessor[] {
  const spanProcessors: SpanProcessor[] = [];
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }

  const langfuseConfig = readLangfuseConfig();
  if (langfuseConfig) {
    spanProcessors.push(
      new LangfuseSpanProcessor({
        ...langfuseConfig,
        shouldExportSpan: ({ otelSpan }) => shouldExportToLangfuse(otelSpan as ReadableSpan | null | undefined),
        ...(isRawExportEnabled() ? {} : { mask: buildLangfuseMask() }),
        mediaUploadEnabled: false,
      }),
    );
  }

  return spanProcessors;
}

function createSdkConfig(serviceName: string): NonNullable<ConstructorParameters<typeof NodeSDK>[0]> {
  const spanProcessors = buildSpanProcessors();
  return {
    serviceName: process.env.OTEL_SERVICE_NAME ?? serviceName,
    ...(spanProcessors.length > 0 ? { spanProcessors } : {}),
  };
}

export async function startTelemetry(serviceName: string): Promise<TelemetryHandle> {
  if (!telemetryEnabled()) return noopHandle;

  const sdk = new NodeSDK(createSdkConfig(serviceName));
  sdk.start();
  return {
    async shutdown() {
      await sdk.shutdown();
    },
  };
}
