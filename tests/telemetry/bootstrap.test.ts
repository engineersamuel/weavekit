import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeSDK } from "@opentelemetry/sdk-node";

type NodeSDKConfig = NonNullable<ConstructorParameters<typeof NodeSDK>[0]>;

const nodeSdkConstructors: Array<{
  config: NodeSDKConfig;
  start: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
}> = [];
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
  isDefaultExportSpan: vi.fn(
    (span: { instrumentationScope?: { name?: string } }) =>
      span.instrumentationScope?.name !== "skip",
  ),
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

import {
  loadTelemetryEnvironment,
  startTelemetry,
  telemetryEnabled,
} from "../../src/telemetry/bootstrap.js";

const envKeys = [
  "OTEL_SDK_DISABLED",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_TRACES_EXPORTER",
  "OTEL_SERVICE_NAME",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_EXPORT_RAW",
  "LANGFUSE_MEDIA_UPLOAD_ENABLED",
] as const;

let envSnapshot = new Map<string, string | undefined>();
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  envSnapshot = new Map(envKeys.map((key) => [key, process.env[key]]));
  nodeSdkConstructors.length = 0;
  batchSpanProcessorConstructors.length = 0;
  otlpExporterConstructors.length = 0;
  langfuseProcessorConstructors.length = 0;
  // Every startTelemetry call with Langfuse keys probes the credentials; keep that off the network.
  fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
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
  vi.unstubAllGlobals();
});

describe("telemetry bootstrap", () => {
  it("loads only telemetry variables from a home env file without overriding the process", () => {
    const directory = mkdtempSync(join(tmpdir(), "weavekit-telemetry-env-"));
    const env: NodeJS.ProcessEnv = { LANGFUSE_BASE_URL: "http://already-configured" };
    try {
      writeFileSync(
        join(directory, ".env"),
        [
          "LANGFUSE_PUBLIC_KEY=pk-home",
          "LANGFUSE_SECRET_KEY=sk-home",
          "LANGFUSE_BASE_URL=http://from-file",
          "OTEL_SERVICE_NAME=weavekit-home",
          "UNRELATED_SECRET=do-not-load",
        ].join("\n"),
      );

      expect(loadTelemetryEnvironment(directory, env).sort()).toEqual([
        "LANGFUSE_PUBLIC_KEY",
        "LANGFUSE_SECRET_KEY",
        "OTEL_SERVICE_NAME",
      ]);
      expect(env).toMatchObject({
        LANGFUSE_PUBLIC_KEY: "pk-home",
        LANGFUSE_SECRET_KEY: "sk-home",
        LANGFUSE_BASE_URL: "http://already-configured",
        OTEL_SERVICE_NAME: "weavekit-home",
      });
      expect(env.UNRELATED_SECRET).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("disables telemetry when OTEL_SDK_DISABLED=true", async () => {
    process.env.OTEL_SDK_DISABLED = "true";

    expect(telemetryEnabled()).toBe(false);

    const handle = await startTelemetry("weavekit-test");
    await expect(handle.shutdown()).resolves.toBeUndefined();
    expect(nodeSdkConstructors).toHaveLength(0);
  });

  it("preserves NodeSDK environment exporter fallback by default", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_TRACES_EXPORTER;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    await startTelemetry("weavekit-test");

    expect(nodeSdkConstructors).toHaveLength(1);
    expect(nodeSdkConstructors[0]?.config).not.toHaveProperty("spanProcessors");
  });

  it("can skip startup for an entry point that requires explicit exporter configuration", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_TRACES_EXPORTER;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    const handle = await startTelemetry("weavekit-test", {
      skipWhenUnconfigured: true,
    });
    await handle.shutdown();

    expect(nodeSdkConstructors).toHaveLength(0);
  });

  it("does not skip an explicitly configured environment exporter", async () => {
    process.env.OTEL_TRACES_EXPORTER = "console";

    await startTelemetry("weavekit-test", { skipWhenUnconfigured: true });

    expect(nodeSdkConstructors).toHaveLength(1);
  });

  it("redacts Langfuse exports when explicitly disabled", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    process.env.OTEL_SERVICE_NAME = "weavekit-env";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.LANGFUSE_BASE_URL = "https://example.langfuse.test";
    process.env.LANGFUSE_EXPORT_RAW = "false";
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

    const mask = (
      langfuseProcessorConstructors[0] as { mask?: (params: { data: unknown }) => unknown }
    )?.mask;
    expect(mask?.({ data: "hello" })).toBe("<redacted because LANGFUSE_EXPORT_RAW=false>");
    expect(mask?.({ data: { nested: ["secret", { keep: true }] } })).toBe(
      "<redacted because LANGFUSE_EXPORT_RAW=false>",
    );

    await handle.shutdown();
    expect(nodeSdkConstructors[0]?.start).toHaveBeenCalledTimes(1);
    expect(nodeSdkConstructors[0]?.shutdown).toHaveBeenCalledTimes(1);
  });

  it("warns at startup when Langfuse rejects the configured credentials", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.LANGFUSE_BASE_URL = "http://localhost:3000/";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    await startTelemetry("weavekit-test");

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3000/api/public/projects", {
      headers: { authorization: `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}` },
      signal: expect.anything(),
    });
    const warning = String(stderr.mock.calls[0]?.[0] ?? "");
    expect(warning).toContain("HTTP 401");
    expect(warning).toContain("every trace for this run will be dropped");
    expect(warning).not.toContain("sk-test");
  });

  it("warns at startup when Langfuse cannot be reached at all", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fetchMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    await expect(startTelemetry("weavekit-test")).resolves.toBeDefined();

    expect(String(stderr.mock.calls[0]?.[0] ?? "")).toContain("connect ECONNREFUSED");
  });

  it("stays silent for usable credentials and never probes without them", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";

    await startTelemetry("weavekit-test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stderr).not.toHaveBeenCalled();

    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    await startTelemetry("weavekit-test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("exports raw Langfuse content by default", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    delete process.env.LANGFUSE_EXPORT_RAW;

    await startTelemetry("weavekit-test");

    expect(langfuseProcessorConstructors).toHaveLength(1);
    expect(langfuseProcessorConstructors[0]).toMatchObject({
      publicKey: "pk-test",
      secretKey: "sk-test",
      mediaUploadEnabled: false,
    });
    expect(langfuseProcessorConstructors[0]).not.toHaveProperty("mask");
  });

  it("guards shouldExportSpan against missing span objects", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";

    await startTelemetry("weavekit-test");

    const shouldExportSpan = (
      langfuseProcessorConstructors[0] as {
        shouldExportSpan?: (args: { otelSpan?: unknown }) => boolean;
      }
    )?.shouldExportSpan;
    expect(shouldExportSpan).toBeTypeOf("function");
    expect(() => shouldExportSpan?.({})).not.toThrow();
    expect(shouldExportSpan?.({})).toBe(false);
  });

  it("backfills instrumentationScope from instrumentationLibrary", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";

    await startTelemetry("weavekit-test");

    const shouldExportSpan = (
      langfuseProcessorConstructors[0] as {
        shouldExportSpan?: (args: { otelSpan?: Record<string, unknown> }) => boolean;
      }
    )?.shouldExportSpan;
    const legacySpan: Record<string, unknown> = {
      name: "run.council.baml.assess",
      attributes: {},
      instrumentationLibrary: { name: "weavekit", version: "1.0.0" },
    };

    expect(shouldExportSpan?.({ otelSpan: legacySpan })).toBe(true);
    expect(legacySpan).toMatchObject({
      instrumentationScope: { name: "weavekit", version: "1.0.0" },
    });
  });
});
