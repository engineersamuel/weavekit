# 0007 — Durable run-state snapshots and explicit resume

Status: accepted

Macro-workflow Runs persist enough orchestration state to continue after the process is
interrupted. This is snapshot-and-resume for one isolated Run, not a durable work queue: no work
is dispatched while weavekit is stopped, no second actor claims nodes, and all resumed execution
still happens in one CLI process through the in-process scheduler.

## State contract and canonical path

The canonical snapshot is `<runs-root>/<run-id>/workflow-state.json`. The JSON keeps the existing
top-level dashboard shape and adds `schemaVersion`, `runId`, and `lastUpdatedAt`; it does not wrap
state in another object. Schema version 1 persists plan metadata, the current plan including dynamic
nodes and replans, node results, active-node metadata, usage, Run timestamps, and a versioned
`resumeContext`.

`resumeContext` records non-secret template execution identity rather than relying on whatever live
configuration happens to exist later. It includes the template id, Source identity, project
selector and resolved project snapshot, mode, the effective Source-to-project expansion settings,
Verification-optimizer settings, and effective Deep-research provider/iteration/retry/visualization
settings where those templates use them. X-article context stores only the Source URL/path identity,
not prefetched article content.

Reads revive `startedAt`, `completedAt`, `lastUpdatedAt`, and replan `timestamp` values as `Date`
objects. An unversioned snapshot is treated as legacy version 0: its existing fields are loaded,
missing `runId` is inferred from the Run directory, and missing `lastUpdatedAt` uses the snapshot
mtime. Versions newer than the reader supports are rejected instead of being guessed at.

`src/macro-workflow/stateStore.ts` owns this contract. Artifact generation delegates all
`workflow-state.json` writes to the store so dashboards, intermediate snapshots, and final reports
observe one path and serialization policy.

## Atomicity, locking, and sensitive data

Writes acquire an adjacent `workflow-state.json.lock` with exclusive create. Acquisition retries
for a bounded period, and the lock handle and file are released in a `finally` path. While holding
the lock, the store writes a temporary file in the Run directory and renames it over the canonical
snapshot. This provides conservative single-machine writer serialization and prevents readers
from observing partial JSON without introducing a database or distributed lock.

One recursive validator rejects objects containing common sensitive key names: `token`, `secret`,
`password`, `apiKey`/`api_key`, `authorization`, and `accessToken`/`access_token`. The validator
runs before replay emission and before any state snapshot, JSONL event, typed payload, or report is
created, so a rejected value cannot leave partial derived artifacts. The write fails with the
offending property path; secrets are never silently serialized. `runs/` remains gitignored, but
ignore rules are defense in depth rather than the secret policy.

## Resume semantics

`weavekit workflow run --resume <run-id> --output <runs-root>` reads
`<runs-root>/<run-id>/workflow-state.json`. `--output` defaults to `runs`. Resume does not accept a
replacement `--input` or `--prompt`: the persisted objective, template, Run identity, start time,
and current plan are authoritative. New snapshots reconstruct Source-to-project,
Verification-optimizer, X-article-summary, and Deep-research harness/expander inputs from
`resumeContext`. A supplied template-specific flag must exactly match the persisted value or resume
fails with a conflict error.

Legacy snapshots without `resumeContext` fail with an actionable list of required reconstruction
flags. Source-to-project requires Source, project selector, and mode; Verification-optimizer
requires project selector and mode; X-article-summary requires Source identity; and Deep-research
requires every effective provider/iteration/result/retry/visualization setting. A successful legacy
resume writes the reconstructed version-1 context into subsequent snapshots.

The runner validates that the supplied resume plan exactly matches the persisted current plan.
It seeds payload and artifact maps from passed/skipped results, treats those nodes as completed,
and does not execute them again. Failed, running, and pending work is eligible to run again;
interrupted result records and active-node metadata are cleared before dispatch. Replan budget is
reduced by persisted replan events, the original `startedAt` is preserved, and completion produces
the normal final state and artifacts.

## Consequences

- A Run can recover at node boundaries from its latest canonical snapshot.
- Mid-harness continuation, background dispatch, work claiming, cross-Run backlogs, and durable
  human waits remain unsupported.
- Schema evolution must preserve or explicitly migrate the top-level dashboard contract.
- Any future multi-actor execution or independently schedulable work would still require revisiting
  ADR 0001 and ADR 0002.
