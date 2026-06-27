import { describe, expect, it, vi } from "vitest";
import { startTelemetry, telemetryEnabled } from "../../src/telemetry/bootstrap.js";

describe("telemetry bootstrap", () => {
  it("disables telemetry when OTEL_SDK_DISABLED=true", async () => {
    process.env.OTEL_SDK_DISABLED = "true";
    expect(telemetryEnabled()).toBe(false);
    const handle = await startTelemetry("weavekit-test");
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("returns a shutdown handle when enabled", async () => {
    delete process.env.OTEL_SDK_DISABLED;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    const handle = await startTelemetry("weavekit-test");
    expect(handle.shutdown).toBeTypeOf("function");
    await handle.shutdown();
  });
});
