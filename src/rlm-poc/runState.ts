import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RlmWorkerOutcome } from "../generated/baml_client/types.js";
import type {
  RlmDependencyReport,
  RlmRunBrief,
  RlmWorkerReport,
} from "../generated/baml_client/types.js";

export const RLM_RUN_STATE_SCHEMA_VERSION = 1;

export const RlmCallExecutionStatus = {
  Running: "running",
  Succeeded: "succeeded",
  Failed: "failed",
} as const;
export type RlmCallExecutionStatus =
  (typeof RlmCallExecutionStatus)[keyof typeof RlmCallExecutionStatus];

type RlmCallRecordBase = {
  callId: string;
  callNumber: number;
  parentCallId?: string;
  dependencyCallIds: string[];
  profile: string;
  depthUsed: number;
  startedAt: string;
};

export type RlmRunningCallRecord = RlmCallRecordBase & {
  status: typeof RlmCallExecutionStatus.Running;
};

export type RlmSucceededCallRecord = RlmCallRecordBase & {
  status: typeof RlmCallExecutionStatus.Succeeded;
  model: string;
  completedAt: string;
  report: RlmWorkerReport;
};

export type RlmFailedCallRecord = RlmCallRecordBase & {
  status: typeof RlmCallExecutionStatus.Failed;
  completedAt: string;
  error: string;
};

export type RlmCallRecord = RlmRunningCallRecord | RlmSucceededCallRecord | RlmFailedCallRecord;

export type RlmRunStateSnapshot = {
  schemaVersion: typeof RLM_RUN_STATE_SCHEMA_VERSION;
  runId: string;
  revision: number;
  nextCallNumber: number;
  brief: RlmRunBrief;
  calls: RlmCallRecord[];
};

export type RlmRunState = {
  runId: string;
  brief: RlmRunBrief;
  revision: number;
  nextCallNumber: number;
  readonly calls: Map<string, RlmCallRecord>;
  readonly now: () => Date;
};

export class RlmRunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RlmRunStateError";
  }
}

const StoredBriefSchema = z
  .object({
    objective: z.string().min(1),
    constraints: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
    validationCommands: z.array(z.string()),
  })
  .strict();

const StoredCallBaseSchema = z.object({
  callId: z.string().min(1),
  callNumber: z.number().int().positive(),
  parentCallId: z.string().min(1).optional(),
  dependencyCallIds: z
    .array(z.string().min(1))
    .refine((callIds) => new Set(callIds).size === callIds.length, {
      message: "Dependency call IDs must be unique.",
    }),
  profile: z.string().min(1),
  depthUsed: z.number().int().positive(),
  startedAt: z.string().datetime(),
});

const StoredCallSchema = z.discriminatedUnion("status", [
  StoredCallBaseSchema.extend({
    status: z.literal(RlmCallExecutionStatus.Running),
  }).strict(),
  StoredCallBaseSchema.extend({
    status: z.literal(RlmCallExecutionStatus.Succeeded),
    model: z.string().min(1),
    completedAt: z.string().datetime(),
    report: z.unknown(),
  }).strict(),
  StoredCallBaseSchema.extend({
    status: z.literal(RlmCallExecutionStatus.Failed),
    completedAt: z.string().datetime(),
    error: z.string().min(1),
  }).strict(),
]);

const StoredRunStateSnapshotSchema = z
  .object({
    schemaVersion: z.literal(RLM_RUN_STATE_SCHEMA_VERSION),
    runId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    nextCallNumber: z.number().int().positive(),
    brief: StoredBriefSchema,
    calls: z.array(StoredCallSchema),
  })
  .strict();

export function createRlmRunState(
  brief: RlmRunBrief,
  options: {
    runId?: string;
    now?: () => Date;
  } = {},
): RlmRunState {
  const runId = options.runId?.trim() || randomUUID();
  return {
    runId,
    brief: cloneBrief(brief),
    revision: 0,
    nextCallNumber: 1,
    calls: new Map(),
    now: options.now ?? (() => new Date()),
  };
}

export function setRlmRunIdentity(state: RlmRunState, runId: string): void {
  const normalized = runId.trim();
  if (!normalized) {
    throw new RlmRunStateError("RLM run ID cannot be empty.");
  }
  if (state.calls.size > 0 || state.revision > 0) {
    throw new RlmRunStateError("RLM run identity cannot change after calls begin.");
  }
  state.runId = normalized;
}

export function setRlmRunBrief(state: RlmRunState, brief: RlmRunBrief): void {
  if (state.calls.size > 0 || state.revision > 0) {
    throw new RlmRunStateError("RLM run brief cannot change after calls begin.");
  }
  state.brief = cloneBrief(brief);
}

export function beginRlmCall(
  state: RlmRunState,
  input: {
    parentCallId?: string;
    dependencyCallIds?: readonly string[];
    profile: string;
    depthUsed: number;
  },
): RlmRunningCallRecord {
  if (input.parentCallId) {
    const parent = state.calls.get(input.parentCallId);
    if (!parent) {
      throw new RlmRunStateError(`RLM parent call "${input.parentCallId}" does not exist.`);
    }
    if (parent.status !== RlmCallExecutionStatus.Running) {
      throw new RlmRunStateError(
        `RLM parent call "${input.parentCallId}" is ${parent.status}; nested calls require a running parent.`,
      );
    }
  }
  const callNumber = state.nextCallNumber;
  state.nextCallNumber += 1;
  const callId = `${state.runId}:call-${callNumber}`;
  const record: RlmRunningCallRecord = {
    callId,
    callNumber,
    ...(input.parentCallId ? { parentCallId: input.parentCallId } : {}),
    dependencyCallIds: [...(input.dependencyCallIds ?? [])],
    profile: input.profile,
    depthUsed: input.depthUsed,
    startedAt: state.now().toISOString(),
    status: RlmCallExecutionStatus.Running,
  };
  state.calls.set(callId, record);
  state.revision += 1;
  return cloneCallRecord(record);
}

export function succeedRlmCall(
  state: RlmRunState,
  callId: string,
  input: { model: string; report: RlmWorkerReport },
): RlmSucceededCallRecord {
  const current = requireRunningCall(state, callId);
  const record: RlmSucceededCallRecord = {
    ...current,
    status: RlmCallExecutionStatus.Succeeded,
    model: input.model,
    completedAt: state.now().toISOString(),
    report: structuredClone(input.report),
  };
  state.calls.set(callId, record);
  state.revision += 1;
  return cloneCallRecord(record);
}

export function failRlmCall(
  state: RlmRunState,
  callId: string,
  error: string,
): RlmFailedCallRecord {
  const current = requireRunningCall(state, callId);
  const message = error.trim();
  if (!message) {
    throw new RlmRunStateError(`RLM call ${callId} cannot fail with an empty error.`);
  }
  const record: RlmFailedCallRecord = {
    ...current,
    status: RlmCallExecutionStatus.Failed,
    completedAt: state.now().toISOString(),
    error: message,
  };
  state.calls.set(callId, record);
  state.revision += 1;
  return cloneCallRecord(record);
}

export function resolveRlmDependencies(
  state: RlmRunState,
  dependencyCallIds: readonly string[],
): RlmDependencyReport[] {
  const seen = new Set<string>();
  return dependencyCallIds.map((callId) => {
    if (seen.has(callId)) {
      throw new RlmRunStateError(`RLM dependency "${callId}" is listed more than once.`);
    }
    seen.add(callId);
    const record = state.calls.get(callId);
    if (!record) {
      throw new RlmRunStateError(`RLM dependency "${callId}" does not exist in this run.`);
    }
    if (record.status !== RlmCallExecutionStatus.Succeeded) {
      throw new RlmRunStateError(
        `RLM dependency "${callId}" is ${record.status}; only succeeded calls can be used.`,
      );
    }
    if (record.report.outcome !== RlmWorkerOutcome.COMPLETED) {
      throw new RlmRunStateError(
        `RLM dependency "${callId}" has worker outcome ${record.report.outcome}; only COMPLETED reports can be used.`,
      );
    }
    return {
      callId: record.callId,
      profile: record.profile,
      report: structuredClone(record.report),
    };
  });
}

export function snapshotRlmRunState(state: RlmRunState): RlmRunStateSnapshot {
  return {
    schemaVersion: RLM_RUN_STATE_SCHEMA_VERSION,
    runId: state.runId,
    revision: state.revision,
    nextCallNumber: state.nextCallNumber,
    brief: cloneBrief(state.brief),
    calls: [...state.calls.values()]
      .sort((left, right) => left.callNumber - right.callNumber)
      .map(cloneCallRecord),
  };
}

export function restoreRlmRunState(
  snapshot: RlmRunStateSnapshot,
  options: { now?: () => Date } = {},
): RlmRunState {
  if (snapshot.schemaVersion !== RLM_RUN_STATE_SCHEMA_VERSION) {
    throw new RlmRunStateError(
      `Unsupported RLM run-state schema version ${snapshot.schemaVersion}.`,
    );
  }

  const calls = new Map<string, RlmCallRecord>();
  let previousCallNumber = 0;
  for (const source of snapshot.calls) {
    const record = cloneCallRecord(source);
    if (record.callNumber !== previousCallNumber + 1) {
      throw new RlmRunStateError("RLM run-state call numbers must be contiguous and increasing.");
    }
    if (record.callId !== `${snapshot.runId}:call-${record.callNumber}`) {
      throw new RlmRunStateError(`RLM run-state call ID "${record.callId}" is invalid.`);
    }
    if (calls.has(record.callId)) {
      throw new RlmRunStateError(`RLM run-state call ID "${record.callId}" is duplicated.`);
    }
    calls.set(record.callId, record);
    previousCallNumber = record.callNumber;
  }
  if (snapshot.nextCallNumber !== previousCallNumber + 1) {
    throw new RlmRunStateError("RLM run-state next call number does not follow existing calls.");
  }
  for (const record of calls.values()) {
    if (record.parentCallId) {
      const parent = calls.get(record.parentCallId);
      if (!parent || parent.callNumber >= record.callNumber) {
        throw new RlmRunStateError(
          `RLM run-state parent call "${record.parentCallId}" is invalid for "${record.callId}".`,
        );
      }
    }
    if (record.status === RlmCallExecutionStatus.Failed) continue;
    for (const dependencyCallId of record.dependencyCallIds) {
      const dependency = calls.get(dependencyCallId);
      if (
        !dependency ||
        dependency.status !== RlmCallExecutionStatus.Succeeded ||
        dependency.callNumber >= record.callNumber
      ) {
        throw new RlmRunStateError(
          `RLM run-state dependency "${dependencyCallId}" is invalid for "${record.callId}".`,
        );
      }
    }
  }
  return {
    runId: snapshot.runId,
    brief: cloneBrief(snapshot.brief),
    revision: snapshot.revision,
    nextCallNumber: snapshot.nextCallNumber,
    calls,
    now: options.now ?? (() => new Date()),
  };
}

export function parseRlmRunStateSnapshot(
  value: unknown,
  parseReport: (raw: string) => RlmWorkerReport,
): RlmRunStateSnapshot {
  const parsed = StoredRunStateSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new RlmRunStateError(`Invalid RLM run-state checkpoint: ${detail}`);
  }
  return {
    ...parsed.data,
    brief: cloneBrief(parsed.data.brief),
    calls: parsed.data.calls.map((record): RlmCallRecord => {
      if (record.status !== RlmCallExecutionStatus.Succeeded) {
        return cloneCallRecord(record);
      }
      return {
        ...record,
        report: parseReport(JSON.stringify(record.report)),
      };
    }),
  };
}

export function hydrateRlmRunState(state: RlmRunState, snapshot: RlmRunStateSnapshot): void {
  if (state.calls.size > 0 || state.revision > 0) {
    throw new RlmRunStateError("Cannot hydrate RLM run state after new calls begin.");
  }
  if (state.runId !== snapshot.runId) {
    throw new RlmRunStateError(
      `Cannot hydrate RLM run "${state.runId}" from checkpoint "${snapshot.runId}".`,
    );
  }
  const restored = restoreRlmRunState(snapshot, { now: state.now });
  state.runId = restored.runId;
  state.brief = restored.brief;
  state.revision = restored.revision;
  state.nextCallNumber = restored.nextCallNumber;
  state.calls.clear();
  for (const [callId, record] of restored.calls) {
    state.calls.set(callId, record);
  }
}

export function interruptRunningRlmCalls(
  state: RlmRunState,
  message = "The prior process ended before this call completed.",
): void {
  const runningIds = [...state.calls.values()]
    .filter(
      (record): record is RlmRunningCallRecord => record.status === RlmCallExecutionStatus.Running,
    )
    .map(({ callId }) => callId);
  for (const callId of runningIds) {
    failRlmCall(state, callId, message);
  }
}

function requireRunningCall(state: RlmRunState, callId: string): RlmRunningCallRecord {
  const current = state.calls.get(callId);
  if (!current) {
    throw new RlmRunStateError(`RLM call "${callId}" does not exist.`);
  }
  if (current.status !== RlmCallExecutionStatus.Running) {
    throw new RlmRunStateError(
      `RLM call "${callId}" is already ${current.status} and cannot transition again.`,
    );
  }
  return current;
}

function cloneBrief(brief: RlmRunBrief): RlmRunBrief {
  return {
    objective: brief.objective,
    constraints: [...brief.constraints],
    acceptanceCriteria: [...brief.acceptanceCriteria],
    validationCommands: [...brief.validationCommands],
  };
}

function cloneCallRecord<T extends RlmCallRecord>(record: T): T {
  return structuredClone(record);
}

/**
 * One spawn, reduced to the fields measurement needs. The full `RlmWorkerReport` per call carries
 * evidence, artifacts, verification, decisions, risks, open questions and remaining work; that is
 * the bulk of a run's payload and no consumer of this record reads past the summary. A 236-call run
 * stays small at this width.
 */
export type RlmRunCallRecord = {
  callId: string;
  callNumber: number;
  parentCallId?: string;
  profile: string;
  depthUsed: number;
  status: RlmCallExecutionStatus;
  model?: string;
  startedAt: string;
  completedAt?: string;
  /** Report summary when succeeded, error text when failed, absent while still running. */
  summary?: string;
};

/** Durable, trimmed view of a finished run. Persisted with the execution result. */
export type RlmRunRecord = {
  schemaVersion: typeof RLM_RUN_STATE_SCHEMA_VERSION;
  runId: string;
  calls: RlmRunCallRecord[];
};

export function toRlmRunRecord(snapshot: RlmRunStateSnapshot): RlmRunRecord {
  return {
    schemaVersion: snapshot.schemaVersion,
    runId: snapshot.runId,
    calls: snapshot.calls.map((call) => ({
      callId: call.callId,
      callNumber: call.callNumber,
      ...(call.parentCallId ? { parentCallId: call.parentCallId } : {}),
      profile: call.profile,
      depthUsed: call.depthUsed,
      status: call.status,
      ...(call.status === RlmCallExecutionStatus.Succeeded ? { model: call.model } : {}),
      startedAt: call.startedAt,
      ...(call.status === RlmCallExecutionStatus.Running ? {} : { completedAt: call.completedAt }),
      ...(call.status === RlmCallExecutionStatus.Succeeded
        ? { summary: call.report.summary }
        : call.status === RlmCallExecutionStatus.Failed
          ? { summary: call.error }
          : {}),
    })),
  };
}
