import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";

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
        shouldExportSpan: ({ otelSpan }) => isDefaultExportSpan(otelSpan),
        ...(isRawExportEnabled() ? {} : { mask: buildLangfuseMask() }),
        mediaUploadEnabled: isRawExportEnabled(),
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
