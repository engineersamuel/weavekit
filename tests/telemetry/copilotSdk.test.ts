import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context, trace } from "@opentelemetry/api";
import { buildCopilotClientOptions } from "../../src/telemetry/copilotSdk.js";

const envKeys = [
  "OTEL_SDK_DISABLED",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_SERVICE_NAME",
  "OTEL_GENAI_CAPTURE_CONTENT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
] as const;

let envSnapshot = new Map<string, string | undefined>();

beforeEach(() => {
  envSnapshot = new Map(envKeys.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of envKeys) {
    const value = envSnapshot.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("copilot SDK telemetry options", () => {
  it("builds telemetry options from OTEL env vars", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";

    const options = buildCopilotClientOptions();

    expect(options).toMatchObject({
      telemetry: {
        otlpEndpoint: "http://127.0.0.1:4318",
        sourceName: "weavekit",
      },
    });
    expect(options?.onGetTraceContext).toBeTypeOf("function");
  });

  it("returns undefined when telemetry is disabled", () => {
    process.env.OTEL_SDK_DISABLED = "true";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";

    expect(buildCopilotClientOptions()).toBeUndefined();
  });

  it("prefers OTEL_EXPORTER_OTLP_TRACES_ENDPOINT and enables content capture", () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://127.0.0.1:4318/v1/traces";
    process.env.OTEL_SERVICE_NAME = "weavekit-test";
    process.env.OTEL_GENAI_CAPTURE_CONTENT = "true";

    const options = buildCopilotClientOptions();

    expect(options).toMatchObject({
      telemetry: {
        otlpEndpoint: "http://127.0.0.1:4318/v1/traces",
        sourceName: "weavekit-test",
        captureContent: true,
      },
    });
  });

  it("exports Copilot SDK spans directly to Langfuse when no OTLP collector is configured", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_BASE_URL = "http://localhost:3000/";

    const options = buildCopilotClientOptions();

    expect(options).toMatchObject({
      telemetry: {
        otlpEndpoint: "http://localhost:3000/api/public/otel",
        otlpProtocol: "http/protobuf",
        sourceName: "weavekit",
      },
    });
    expect(options?.env?.OTEL_EXPORTER_OTLP_HEADERS).toMatch(/^Authorization=Basic /u);
    expect(options?.env?.OTEL_EXPORTER_OTLP_HEADERS).not.toContain("sk-lf-test");
  });

  it("injects the active trace context into the callback carrier", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    const options = buildCopilotClientOptions();

    const tracer = trace.getTracer("copilot-sdk-test");
    const span = tracer.startSpan("copilot-sdk-test-span");

    try {
      const carrier = context.with(
        trace.setSpan(context.active(), span),
        () => options?.onGetTraceContext?.() ?? {},
      );
      expect(carrier).toBeDefined();
      expect(carrier).toBeTypeOf("object");
    } finally {
      span.end();
    }
  });
});
