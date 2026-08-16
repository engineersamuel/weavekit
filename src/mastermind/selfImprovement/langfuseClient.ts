import type { SubmindTraceSummary } from "../../generated/baml_client/index.js";

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
const MAX_PREVIEW_LENGTH = 1200;
const MAX_OBSERVATIONS = 60;

type LangfuseObservationRecord = {
  id?: string;
  name?: string;
  type?: string;
  level?: string;
  statusMessage?: string;
  input?: unknown;
  output?: unknown;
  model?: string;
  startTime?: string;
  endTime?: string;
};

type LangfuseTraceRecord = {
  id?: string;
  input?: unknown;
  output?: unknown;
  observations?: LangfuseObservationRecord[];
};

/**
 * Fetches and normalizes a Submind Langfuse trace for the self-improvement analysis pipeline
 * (`SelfImprovementCoordinator`). This is a best-effort, read-only integration against Langfuse's
 * Public API (https://api.reference.langfuse.com/): it must never throw for "expected" failure
 * modes (export not configured, trace not found yet, network hiccup) - callers treat `undefined`
 * as "skip self-improvement analysis for this attempt", not as an error.
 */
export type LangfuseTraceFetcher = {
  fetchSubmindTraceSummary(traceId: string): Promise<SubmindTraceSummary | undefined>;
};

export class LangfusePublicApiTraceFetcher implements LangfuseTraceFetcher {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async fetchSubmindTraceSummary(traceId: string): Promise<SubmindTraceSummary | undefined> {
    const publicKey = this.env.LANGFUSE_PUBLIC_KEY?.trim();
    const secretKey = this.env.LANGFUSE_SECRET_KEY?.trim();
    if (!publicKey || !secretKey) {
      return undefined;
    }
    const baseUrl = (this.env.LANGFUSE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/u, "");
    const authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;

    try {
      const trace = await this.getJson<LangfuseTraceRecord>(
        `${baseUrl}/api/public/traces/${encodeURIComponent(traceId)}`,
        authorization,
      );
      if (!trace) {
        return undefined;
      }
      const observations =
        trace.observations && trace.observations.length > 0
          ? trace.observations
          : await this.fetchObservations(baseUrl, authorization, traceId);
      return {
        traceId,
        url: this.buildTraceUrl(baseUrl, traceId),
        rootInput: previewValue(trace.input),
        rootOutput: previewValue(trace.output),
        observations: observations.slice(0, MAX_OBSERVATIONS).map(normalizeObservation),
      };
    } catch {
      // Best-effort integration: any fetch/parse failure just means no analysis for this attempt.
      return undefined;
    }
  }

  /** Mirrors `mastermind/telemetry.ts`'s `buildLangfuseTraceUrl`, but against this instance's own
   * injected `env` (rather than the ambient `process.env`) so it stays testable/consistent with
   * whichever Langfuse project the trace was actually fetched from. */
  private buildTraceUrl(baseUrl: string, traceId: string): string | undefined {
    const projectId = this.env.LANGFUSE_PROJECT_ID?.trim();
    if (!projectId) {
      return undefined;
    }
    return `${baseUrl}/project/${encodeURIComponent(projectId)}/traces/${traceId}`;
  }

  private async fetchObservations(
    baseUrl: string,
    authorization: string,
    traceId: string,
  ): Promise<LangfuseObservationRecord[]> {
    const page = await this.getJson<{ data?: LangfuseObservationRecord[] }>(
      `${baseUrl}/api/public/observations?traceId=${encodeURIComponent(traceId)}&limit=${MAX_OBSERVATIONS}`,
      authorization,
    );
    return page?.data ?? [];
  }

  private async getJson<T>(url: string, authorization: string): Promise<T | undefined> {
    const response = await this.fetcher(url, {
      headers: { authorization, accept: "application/json" },
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as T;
  }
}

function normalizeObservation(
  observation: LangfuseObservationRecord,
): SubmindTraceSummary["observations"][number] {
  const durationMs =
    observation.startTime && observation.endTime
      ? Math.max(
          0,
          Math.round(
            new Date(observation.endTime).getTime() - new Date(observation.startTime).getTime(),
          ),
        )
      : undefined;
  const status = observation.level
    ? observation.level.toUpperCase() === "ERROR"
      ? "error"
      : "ok"
    : "ok";
  const summary = [
    observation.statusMessage,
    previewValue(observation.output) ?? previewValue(observation.input),
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" — ");
  return {
    name: observation.name ?? observation.id ?? "unnamed",
    type: observation.type ?? "unknown",
    status,
    summary: summary || "(no captured input/output)",
    ...(observation.model ? { model: observation.model } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function previewValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) {
    return undefined;
  }
  return text.length > MAX_PREVIEW_LENGTH ? `${text.slice(0, MAX_PREVIEW_LENGTH)}…` : text;
}
