import type { SubmindTraceSummary } from "../../generated/baml_client/index.js";
import type { RlmRunRecord } from "../../rlm-poc/runState.js";
import type { ExecutionAttempt } from "../store/store.js";

const MAX_OBSERVATIONS = 60;

/**
 * Supplies the executed Submind path to the self-improvement analysis pipeline
 * (`SelfImprovementCoordinator`). It must never throw for an "expected" failure mode (no run
 * record captured, a non-RLM executor, an attempt from before the record existed) - callers treat
 * `undefined` as "skip self-improvement analysis for this attempt", not as an error.
 */
export type SubmindTraceSource = {
  fetchSubmindTraceSummary(attempt: ExecutionAttempt): Promise<SubmindTraceSummary | undefined>;
};

/**
 * Reads the run record persisted with the execution result. This replaces an earlier HTTP client
 * against the Langfuse Public API: the runtime already holds every call in memory, and Langfuse v4
 * deployments running in events-only mode removed the read endpoints that client depended on, so
 * the data was exported and then unreachable.
 */
export class RunRecordSubmindTraceSource implements SubmindTraceSource {
  async fetchSubmindTraceSummary(
    attempt: ExecutionAttempt,
  ): Promise<SubmindTraceSummary | undefined> {
    const record = attempt.result?.runRecord;
    if (!record) {
      return undefined;
    }
    const trace = attempt.result?.submindTrace;
    return {
      traceId: trace?.traceId ?? record.runId,
      ...(trace?.url ? { url: trace.url } : {}),
      ...(attempt.result?.summary ? { rootOutput: attempt.result.summary } : {}),
      observations: record.calls.slice(0, MAX_OBSERVATIONS).map(toObservation),
    };
  }
}

function toObservation(
  call: RlmRunRecord["calls"][number],
): SubmindTraceSummary["observations"][number] {
  const started = Date.parse(call.startedAt);
  const completed = call.completedAt ? Date.parse(call.completedAt) : Number.NaN;
  const durationMs =
    Number.isFinite(started) && Number.isFinite(completed)
      ? Math.max(0, completed - started)
      : undefined;
  return {
    name: `${call.profile} call ${call.callNumber}`,
    type: "rlm-call",
    status: call.status === "failed" ? "error" : "ok",
    summary: call.summary || "(no captured summary)",
    ...(call.model ? { model: call.model } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}
