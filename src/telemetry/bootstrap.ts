import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";

export type TelemetryHandle = { shutdown(): Promise<void> };

const noopHandle: TelemetryHandle = { async shutdown() {} };

export function telemetryEnabled(): boolean {
  return process.env.OTEL_SDK_DISABLED !== "true";
}

function hasLangfuseConfig(): boolean {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}

export async function startTelemetry(serviceName: string): Promise<TelemetryHandle> {
  if (!telemetryEnabled()) return noopHandle;

  const spanProcessors: any[] = [];
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }
  if (hasLangfuseConfig()) {
    spanProcessors.push(
      new LangfuseSpanProcessor({
        shouldExportSpan: ({ otelSpan }: any) =>
          isDefaultExportSpan(otelSpan) || otelSpan.instrumentationScope?.name === "weavekit",
      }),
    );
  }

  const sdk = new NodeSDK({
    serviceName,
    spanProcessors,
  } as any);

  await sdk.start();
  return {
    async shutdown() {
      await sdk.shutdown();
    },
  };
}
