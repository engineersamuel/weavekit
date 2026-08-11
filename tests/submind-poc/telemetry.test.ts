import { describe, expect, it, vi } from "vitest";
import { shutdownTelemetry } from "../../src/submind-poc/telemetry.js";

describe("submind telemetry", () => {
  it("reports exporter shutdown failure without rejecting the CLI", async () => {
    const write = vi.fn();

    await expect(
      shutdownTelemetry(
        { shutdown: async () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:4318")) },
        write,
      ),
    ).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledWith(
      "Telemetry shutdown failed: connect ECONNREFUSED 127.0.0.1:4318\n",
    );
  });
});
