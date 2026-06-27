import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeSDK } from "@opentelemetry/sdk-node";

type NodeSDKConfig = NonNullable<ConstructorParameters<typeof NodeSDK>[0]>;

const nodeSdkConstructors: Array<{ config: NodeSDKConfig; start: ReturnType<typeof vi.fn>; shutdown: ReturnType<typeof vi.fn> }> = [];
const batchSpanProcessorConstructors: unknown[] = [];
const otlpExporterConstructors: unknown[] = [];
const langfuseProcessorConstructors: unknown[] = [];

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class MockOTLPTraceExporter {
    constructor(config: unknown) {
      otlpExporterConstructors.push(config);
    }
  },
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: class MockBatchSpanProcessor {
    constructor(exporter: unknown) {
      batchSpanProcessorConstructors.push({ exporter });
    }
  },
}));

vi.mock("@langfuse/otel", () => ({
  LangfuseSpanProcessor: class MockLangfuseSpanProcessor {
    constructor(params: unknown) {
      langfuseProcessorConstructors.push(params);
    }
  },
  isDefaultExportSpan: vi.fn((span: { instrumentationScope?: { name?: string } }) => span.instrumentationScope?.name !== "skip"),
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class MockNodeSDK {
    start = vi.fn();
    shutdown = vi.fn(async () => undefined);

    constructor(config: NodeSDKConfig) {
      nodeSdkConstructors.push({ config, start: this.start, shutdown: this.shutdown });
    }
  },
}));

import { startTelemetry, telemetryEnabled } from "../../src/telemetry/bootstrap.js";

const envKeys = [
  "OTEL_SDK_DISABLED",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_SERVICE_NAME",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_EXPORT_RAW",
  "LANGFUSE_MEDIA_UPLOAD_ENABLED",
] as const;

let envSnapshot = new Map<string, string | undefined>();

beforeEach(() => {
  envSnapshot = new Map(envKeys.map((key) => [key, process.env[key]]));
  nodeSdkConstructors.length = 0;
  batchSpanProcessorConstructors.length = 0;
  otlpExporterConstructors.length = 0;
  langfuseProcessorConstructors.length = 0;
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("telemetry bootstrap", () => {
  it("disables telemetry when OTEL_SDK_DISABLED=true", async () => {
    process.env.OTEL_SDK_DISABLED = "true";

    expect(telemetryEnabled()).toBe(false);

    const handle = await startTelemetry("weavekit-test");
    await expect(handle.shutdown()).resolves.toBeUndefined();
    expect(nodeSdkConstructors).toHaveLength(0);
  });

  it("passes Langfuse credentials explicitly and redacts raw exports by default", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    process.env.OTEL_SERVICE_NAME = "weavekit-env";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.LANGFUSE_BASE_URL = "https://example.langfuse.test";
    expect(process.env.LANGFUSE_PUBLIC_KEY).toBe("pk-test");

    const handle = await startTelemetry("weavekit-test");

    expect(nodeSdkConstructors).toHaveLength(1);
    expect(batchSpanProcessorConstructors).toHaveLength(1);
    expect(otlpExporterConstructors).toHaveLength(1);
    expect(langfuseProcessorConstructors).toHaveLength(1);

    expect(nodeSdkConstructors[0]?.config).toMatchObject({
      serviceName: "weavekit-env",
    });
    expect(nodeSdkConstructors[0]?.config.spanProcessors).toHaveLength(2);
    expect(langfuseProcessorConstructors[0]).toMatchObject({
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: "https://example.langfuse.test",
      mediaUploadEnabled: false,
    });
    expect(langfuseProcessorConstructors[0]).toHaveProperty("mask");
    expect(langfuseProcessorConstructors[0]).toHaveProperty("shouldExportSpan");

    await handle.shutdown();
    expect(nodeSdkConstructors[0]?.start).toHaveBeenCalledTimes(1);
    expect(nodeSdkConstructors[0]?.shutdown).toHaveBeenCalledTimes(1);
  });

  it("allows raw Langfuse export only with explicit opt-in", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.LANGFUSE_EXPORT_RAW = "true";

    await startTelemetry("weavekit-test");

    expect(langfuseProcessorConstructors).toHaveLength(1);
    expect(langfuseProcessorConstructors[0]).toMatchObject({
      publicKey: "pk-test",
      secretKey: "sk-test",
      mediaUploadEnabled: true,
    });
    expect(langfuseProcessorConstructors[0]).not.toHaveProperty("mask");
  });
});
