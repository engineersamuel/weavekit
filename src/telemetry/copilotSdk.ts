import { context, propagation } from "@opentelemetry/api";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

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
      captureContent:
        process.env.LANGFUSE_EXPORT_RAW !== "false" &&
        process.env.OTEL_GENAI_CAPTURE_CONTENT !== "false",
    },
    ...(otlp.env ? { env: otlp.env } : {}),
    onGetTraceContext: () => {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      return carrier;
    },
  };
}

/**
 * Resolves an absolute path for a configured CLI command name, used to construct a
 * `CopilotClient`'s `connection` option.
 *
 * An explicit `COPILOT_CLI_PATH` always wins (matches an operator-level override regardless of
 * per-harness configuration). Otherwise, if `commandName` already looks like a path (contains a
 * separator), it is validated directly with `existsSync`. Otherwise it is resolved against `PATH`
 * ourselves, because the SDK checks `existsSync(cliPath)` directly rather than resolving it
 * against `PATH` the way a shell/`child_process.spawn` invocation would. When nothing resolves,
 * returns `undefined` so `CopilotClient` can fall back to auto-resolving its bundled platform
 * runtime.
 */
export function resolveCopilotCliPath(commandName = "copilot"): string | undefined {
  const override = process.env.COPILOT_CLI_PATH?.trim();
  if (override) return override;

  const candidateName =
    process.platform === "win32" && !commandName.toLowerCase().endsWith(".cmd")
      ? `${commandName}.cmd`
      : commandName;
  if (candidateName.includes("/") || candidateName.includes("\\")) {
    return existsSync(candidateName) ? candidateName : undefined;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, candidateName);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** @deprecated Use `resolveCopilotCliPath()` (accepts an optional configured command name). */
export function resolveDefaultCopilotCliPath(): string | undefined {
  return resolveCopilotCliPath("copilot");
}

/**
 * Builds telemetry plus an explicit runtime connection for a configured harness command/args. If
 * no runtime URL or existing CLI path is found, omits `connection` so the SDK keeps native
 * platform package auto-resolution as a last resort.
 *
 * `CopilotClient` (as of `@github/copilot-sdk@1.0.4`) only reads a `connection` option - it has no
 * `cliPath`/`cliArgs` fields, so those must never be passed directly.
 */
export async function buildCopilotClientConnectionOptions(
  command?: string,
  args?: string[],
): Promise<Record<string, unknown>> {
  const { RuntimeConnection } = await import("@github/copilot-sdk");
  const options: Record<string, unknown> = { ...buildCopilotClientOptions() };
  const runtimeUrl = process.env.COPILOT_RUNTIME_URL?.trim() || process.env.COPILOT_CLI_URL?.trim();
  if (runtimeUrl) {
    options.connection = RuntimeConnection.forUri(runtimeUrl);
    return options;
  }

  const cliPath = resolveCopilotCliPath(command ?? "copilot");
  if (cliPath) {
    options.connection = RuntimeConnection.forStdio({
      path: cliPath,
      ...(args?.length ? { args } : {}),
    });
  }
  return options;
}

/**
 * Builds telemetry plus an explicit runtime connection when configured or discoverable. If no
 * runtime URL or existing CLI path is found, omits `connection` so the SDK keeps native platform
 * package auto-resolution.
 */
export async function buildDefaultCopilotClientOptions(): Promise<Record<string, unknown>> {
  return buildCopilotClientConnectionOptions();
}
