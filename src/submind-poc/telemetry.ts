import type { TelemetryHandle } from "../telemetry/bootstrap.js";

export async function shutdownTelemetry(
  telemetry: TelemetryHandle,
  write: (message: string) => unknown = (message) => process.stderr.write(message),
): Promise<void> {
  try {
    await telemetry.shutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write(`Telemetry shutdown failed: ${message}\n`);
  }
}
