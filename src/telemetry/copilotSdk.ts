import { context, propagation } from "@opentelemetry/api";

export type CopilotTelemetryOptions = {
  telemetry?: {
    otlpEndpoint?: string;
    otlpProtocol?: "http/json" | "http/protobuf";
    exporterType?: "otlp-http" | "file";
    sourceName?: string;
    captureContent?: boolean;
    filePath?: string;
  };
  env?: NodeJS.ProcessEnv;
  onGetTraceContext?: () => Record<string, string>;
};

function readOtlpConfiguration():
  | { endpoint: string; env?: NodeJS.ProcessEnv; protocol?: "http/protobuf" }
  | undefined {
  const fromEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (fromEndpoint) return { endpoint: fromEndpoint };
  const fromTracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (fromTracesEndpoint) return { endpoint: fromTracesEndpoint };

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) {
    return undefined;
  }
  const baseUrl = (process.env.LANGFUSE_BASE_URL?.trim() || "https://cloud.langfuse.com").replace(
    /\/+$/u,
    "",
  );
  const authorization = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  return {
    endpoint: `${baseUrl}/api/public/otel`,
    protocol: "http/protobuf",
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_HEADERS:
        process.env.OTEL_EXPORTER_OTLP_HEADERS ?? `Authorization=Basic ${authorization}`,
    },
  };
}

export function buildCopilotClientOptions(): CopilotTelemetryOptions | undefined {
  if (process.env.OTEL_SDK_DISABLED === "true") return undefined;

  const otlp = readOtlpConfiguration();
  if (!otlp) return undefined;

  return {
    telemetry: {
      otlpEndpoint: otlp.endpoint,
      ...(otlp.protocol ? { otlpProtocol: otlp.protocol } : {}),
      sourceName: process.env.OTEL_SERVICE_NAME ?? "weavekit",
      ...(process.env.OTEL_GENAI_CAPTURE_CONTENT === "true" ? { captureContent: true } : {}),
    },
    ...(otlp.env ? { env: otlp.env } : {}),
    onGetTraceContext: () => {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      return carrier;
    },
  };
}
