import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";
import { loadLocalEnvFiles } from "../config.js";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

export type TelemetryHandle = { shutdown(): Promise<void> };

const noopHandle: TelemetryHandle = { async shutdown() {} };
const defaultLangfuseBaseUrl = "https://cloud.langfuse.com";
const rawContentRedactionMessage = "<redacted because LANGFUSE_EXPORT_RAW=false>";
/** Short enough that a hung Langfuse cannot stall a CLI start; localhost answers in milliseconds. */
const langfuseCredentialProbeTimeoutMs = 2_000;

export function loadTelemetryEnvironment(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const fileEnv: NodeJS.ProcessEnv = {};
  loadLocalEnvFiles(directory, fileEnv);
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(fileEnv)) {
    if (
      value !== undefined &&
      env[key] === undefined &&
      (key.startsWith("LANGFUSE_") || key.startsWith("OTEL_"))
    ) {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

export function telemetryEnabled(): boolean {
  return process.env.OTEL_SDK_DISABLED !== "true";
}

type LangfuseConfig = {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
};

function readLangfuseConfig(): LangfuseConfig | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return null;

  return {
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL ?? defaultLangfuseBaseUrl,
  };
}

function isRawExportEnabled(): boolean {
  return process.env.LANGFUSE_EXPORT_RAW !== "false";
}

function redactLangfuseValue(data: unknown): unknown {
  if (isRawExportEnabled()) return data;

  if (data === null || data === undefined) return data;
  if (typeof data === "string") return rawContentRedactionMessage;
  if (typeof data === "number" || typeof data === "boolean" || typeof data === "bigint")
    return data;
  if (typeof data === "symbol" || typeof data === "function") return rawContentRedactionMessage;
  return rawContentRedactionMessage;
}

function buildLangfuseMask(): ((params: { data: unknown }) => unknown) | undefined {
  if (isRawExportEnabled()) return undefined;

  return ({ data }) => redactLangfuseValue(data);
}

function hasGenAiAttributes(span: ReadableSpan | null | undefined): boolean {
  if (!span?.attributes) return false;
  return Object.keys(span.attributes).some((key) => key.startsWith("gen_ai."));
}

function ensureInstrumentationScope(span: ReadableSpan | null | undefined): void {
  if (!span || typeof span !== "object") return;

  const currentScope = (
    span as ReadableSpan & { instrumentationScope?: { name?: string; version?: string } }
  ).instrumentationScope;
  if (currentScope?.name) return;

  const library = (
    span as ReadableSpan & { instrumentationLibrary?: { name?: string; version?: string } }
  ).instrumentationLibrary;
  const name = library?.name || "unknown";
  const version = library?.version;
  (
    span as ReadableSpan & { instrumentationScope?: { name: string; version?: string } }
  ).instrumentationScope = {
    name,
    ...(version ? { version } : {}),
  };
}

function isWeavekitSpan(span: ReadableSpan | null | undefined): boolean {
  if (!span) return false;
  const scope = (span as ReadableSpan & { instrumentationScope?: { name?: string } })
    .instrumentationScope;
  return span.instrumentationLibrary?.name === "weavekit" || scope?.name === "weavekit";
}

function isCouncilSpan(span: ReadableSpan | null | undefined): boolean {
  if (!span?.name) return false;
  return span.name === "council-run" || span.name.startsWith("run.council.");
}

function shouldExportToLangfuse(otelSpan: ReadableSpan | null | undefined): boolean {
  if (!otelSpan) return false;
  ensureInstrumentationScope(otelSpan);
  if (isWeavekitSpan(otelSpan) || isCouncilSpan(otelSpan)) return true;
  if (hasGenAiAttributes(otelSpan)) return true;
  try {
    return isDefaultExportSpan(otelSpan);
  } catch {
    return false;
  }
}

function buildSpanProcessors(): SpanProcessor[] {
  const spanProcessors: SpanProcessor[] = [];
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }

  const langfuseConfig = readLangfuseConfig();
  if (langfuseConfig) {
    spanProcessors.push(
      new LangfuseSpanProcessor({
        ...langfuseConfig,
        shouldExportSpan: ({ otelSpan }) =>
          shouldExportToLangfuse(otelSpan as ReadableSpan | null | undefined),
        ...(isRawExportEnabled() ? {} : { mask: buildLangfuseMask() }),
        mediaUploadEnabled: false,
      }),
    );
  }

  return spanProcessors;
}

function createSdkConfig(
  serviceName: string,
): NonNullable<ConstructorParameters<typeof NodeSDK>[0]> {
  const spanProcessors = buildSpanProcessors();
  return {
    serviceName: process.env.OTEL_SERVICE_NAME ?? serviceName,
    ...(spanProcessors.length > 0 ? { spanProcessors } : {}),
  };
}

function hasExplicitTelemetryExporter(): boolean {
  const hasLangfuse = Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
  return Boolean(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    process.env.OTEL_TRACES_EXPORTER ||
    hasLangfuse,
  );
}

/**
 * Checks the Langfuse credentials once, at startup. Without this a rejected key pair stays
 * invisible until a single swallowed stderr line at shutdown - which looks the same as a
 * successful export, while every span of the run was silently dropped. Never throws and never
 * prints the keys: telemetry must not stop or leak into the actual work.
 */
async function warnOnUnusableLangfuseCredentials(config: LangfuseConfig): Promise<void> {
  const baseUrl = config.baseUrl.replace(/\/+$/u, "");
  const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/public/projects`, {
      headers: { authorization },
      signal: AbortSignal.timeout(langfuseCredentialProbeTimeoutMs),
    });
  } catch (error) {
    process.stderr.write(
      `[telemetry] Langfuse at ${baseUrl} did not answer; traces for this run will be dropped: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return;
  }
  if (response.ok) return;
  process.stderr.write(
    `[telemetry] Langfuse rejected LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY with HTTP ` +
      `${response.status}; every trace for this run will be dropped. Create a new key pair in the ` +
      `Langfuse instance at ${baseUrl} and update your config. Note that LANGFUSE_PROJECT_ID only ` +
      "builds the printed trace URL - it does not authenticate.\n",
  );
}

export async function startTelemetry(
  serviceName: string,
  options: { skipWhenUnconfigured?: boolean } = {},
): Promise<TelemetryHandle> {
  if (!telemetryEnabled()) return noopHandle;
  if (options.skipWhenUnconfigured && !hasExplicitTelemetryExporter()) return noopHandle;

  const sdk = new NodeSDK(createSdkConfig(serviceName));
  sdk.start();
  const langfuseConfig = readLangfuseConfig();
  if (langfuseConfig) {
    await warnOnUnusableLangfuseCredentials(langfuseConfig);
  }
  return {
    async shutdown() {
      // Best-effort: telemetry export failures (e.g. misconfigured/expired Langfuse
      // credentials returning 401) must never crash the process during shutdown.
      try {
        await sdk.shutdown();
      } catch (error) {
        process.stderr.write(
          `[telemetry] shutdown export failed (ignored): ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    },
  };
}
