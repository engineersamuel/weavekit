import { context, propagation } from "@opentelemetry/api";

export type CopilotTelemetryOptions = {
  telemetry?: {
    otlpEndpoint?: string;
    exporterType?: "otlp-http" | "file";
    sourceName?: string;
    captureContent?: boolean;
    filePath?: string;
  };
  onGetTraceContext?: () => Record<string, string>;
};

function readOtlpEndpoint(): string | undefined {
  const fromEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (fromEndpoint) return fromEndpoint;
  return process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
}

export function buildCopilotClientOptions(): CopilotTelemetryOptions | undefined {
  if (process.env.OTEL_SDK_DISABLED === "true") return undefined;

  const otlpEndpoint = readOtlpEndpoint();
  if (!otlpEndpoint) return undefined;

  return {
    telemetry: {
      otlpEndpoint,
      sourceName: process.env.OTEL_SERVICE_NAME ?? "weavekit",
      ...(process.env.OTEL_GENAI_CAPTURE_CONTENT === "true" ? { captureContent: true } : {}),
    },
    onGetTraceContext: () => {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      return carrier;
    },
  };
}
