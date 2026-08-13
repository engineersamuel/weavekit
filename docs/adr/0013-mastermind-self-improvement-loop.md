# 0013 — Mastermind self-improvement loop over Submind Langfuse traces

Status: accepted

## Context

`DELEGATE_SUBMIND` ([ADR 0012](0012-mastermind-delegate-submind-to-rlm.md)) runs `rlm-poc`'s
recursive Copilot SDK meta-harness ("Submind") and already emits a Langfuse trace for every attempt
(`withRlmSpan`/`traceMastermindWork` tag every span; `RlmDirectExecutor` captures the resulting
`traceId` from `mastermind-rlm-output.json`). Nothing previously looked back at _how_ that work was
actually done: whether Submind picked reasonable profiles, whether it escalated to Trellage
unnecessarily, whether it retried or errored along the way, or whether the executed path actually
satisfied the original ticket's acceptance criteria and the Mastermind/Submind mission statements.
This ADR adds a secondary, best-effort feedback loop that mines that signal and turns it into
human-triaged Linear tickets, without ever affecting the primary Mastermind execution/decision
pipeline.

## Decision

- **Trace ID threading.** `DirectExecutionResult` gained an optional `submindTrace?:
SubmindTraceReference` field (`traceId`, `conversationId?`, `url?`). `RlmDirectExecutor.collect()`
  builds this from the captured RLM output payload and attaches it to both the successful-manifest
  result and the `needs-human` fallback result, so a trace reference is captured on _any_ terminal
  RLM outcome, not just clean successes. `HerdrDirectExecutor` never sets this field — it has no
  equivalent nested Submind trace, so `IMPLEMENT_DIRECTLY` attempts are naturally out of scope for
  this feature in v1. `ExecutionAttempt.result` already persists as an opaque JSON blob
  (`result_json` in `src/mastermind/store/sqlite.ts`), so no migration was needed.

- **Langfuse Public API client, not the SDK.** `src/mastermind/selfImprovement/langfuseClient.ts`
  hits Langfuse's Public API directly (`GET /api/public/traces/{traceId}`, falling back to
  `GET /api/public/observations?traceId=...` when a trace has no inline observations), rather than
  pulling in Langfuse's server SDK. Auth is HTTP Basic using the same `LANGFUSE_PUBLIC_KEY` /
  `LANGFUSE_SECRET_KEY` / base-URL env vars `telemetry/bootstrap.ts` already uses for export.
  Results are normalized into a bounded `SubmindTraceSummary` (truncated input/output previews,
  capped observation count) so the payload fits comfortably in a BAML prompt. The fetcher is fully
  best-effort: any missing config, network failure, or malformed response returns `undefined` and
  is never thrown — self-improvement analysis is always allowed to just silently not happen.

- **New BAML function, new file.** `baml_src/self_improvement.baml` (not `mastermind.baml`) defines
  `SubmindTraceObservation` / `SubmindTraceSummary` / `SelfImprovementFinding` /
  `SelfImprovementReport` and `AnalyzeSubmindTrace(ticket, missionStatements, trace) ->
SelfImprovementReport`. The prompt asks for concrete, evidenced deviations only — no vague
  "could be better" filler — categorized as `MISSION_DEVIATION` / `INEFFICIENT_ROUTING` /
  `ERROR_OR_RETRY` / `MISSED_REQUIREMENT` / `OTHER`, each with a severity
  (`BLOCKING`/`IMPORTANT`/`SUGGESTION`) and a ready-to-file `suggestedTicketBody`.

- **Mission statements are mostly-live text, not hand-copied docs.** Submind's system prompt
  (`RLM_SUBMIND_SYSTEM_PROMPT` in `src/rlm-poc/submindPrompt.ts`) is imported verbatim at runtime.
  Mastermind's own `DecideNextAction` BAML prompt text is not importable as a plain string (it only
  exists inside the `.baml` source, consumed through the generated client), so
  `src/mastermind/selfImprovement/missionStatements.ts` ships a hand-written, explicitly-labeled
  paraphrase of its DELEGATE_SUBMIND routing rule (`MASTERMIND_DECISION_MISSION_STATEMENT`) with an
  inline comment flagging that it must be kept in sync manually if that BAML prompt text changes.
  This is a known, accepted gap rather than a hidden one.

- **Coordinator triggers on both success and failure terminal states.** `SelfImprovementCoordinator`
  analyzes `COMPLETED`, `AWAITING_ACCEPTANCE`, `CHANGES_REQUESTED`, `NEEDS_HUMAN`, and `FAILED` —
  not just clean successes. Suboptimal-path findings (redundant delegation, wrong profile choice,
  unnecessary Trellage escalation) are valuable signal on failure/human-intervention paths too, so
  restricting analysis to successful runs would have thrown away exactly the outcomes most worth
  learning from.

- **Idempotency: one marker comment per attempt, not per finding.** Self-improvement tickets are
  filed into a separate Linear team/project from the originating ticket (so meta/process tickets
  don't pollute product backlogs), which means there is no single issue to search for a per-finding
  marker on. Instead, the coordinator posts one marker HTML comment
  (`<!-- weavekit-mastermind-self-improvement:{attemptId} -->`) on the _originating_ ticket the
  instant filing starts for a given attempt, using the same `findIssueCommentByMarker`/
  `createIssueComment` mechanism the `codeReview`/`accept` coordinators already use, and skips the
  entire attempt if that marker already exists. This trades fine-grained per-finding replay safety
  (a crash mid-filing could under- or duplicate-file across a re-entry) for a simple, robust
  "have we already run this for this attempt" check — acceptable for a secondary, human-triaged
  feedback loop where the cost of an occasional duplicate ticket is low.

- **Never blocks or fails the primary pipeline.** `SelfImprovementCoordinator.process()` wraps its
  entire body (Langfuse fetch, BAML call, Linear calls) in a single `withMastermindSpan` +
  try/catch that logs and swallows any error. `MastermindExecutionCoordinator.processPhase()` calls
  it unconditionally whenever a `selfImprovement` instance is configured, on every poll of an
  already-terminal work item — safe because the coordinator's own state/attempt/trace-presence
  checks and its marker-based idempotency make repeated invocations a cheap no-op once a given
  attempt has already been processed (or found ineligible).

- **New Linear capability: `createIssue`.** `LinearGateway` gained an optional `createIssue(input:
{ teamId, title, description, projectId?, labelIds? })` method (mirroring the existing
  `createIssueComment` pattern), implemented in `LinearGraphQlGateway` via a new `issueCreate`
  GraphQL mutation.

- **New config block:** `mastermind.self_improvement.{enabled, target_team_id,
target_project_id?, min_severity, ticket_label_id?}`. `min_severity` defaults callers toward
  filing only `BLOCKING`/`IMPORTANT` findings; `SUGGESTION`-level findings remain visible in the
  Langfuse trace itself but aren't filed as tickets unless the threshold is lowered.

## Consequences

- Only `DELEGATE_SUBMIND`/RLM-executed work items produce self-improvement tickets in v1;
  `IMPLEMENT_DIRECTLY` (Herdr) attempts have no equivalent nested trace to mine.
- This is strictly a feedback/triage mechanism — it files tickets for humans (or a future
  Mastermind run) to act on. It does not attempt to auto-resolve findings by kicking off another
  Mastermind/Submind run; that would be a separate, follow-up capability.
- `MASTERMIND_DECISION_MISSION_STATEMENT` is a manually-maintained paraphrase and can drift from the
  actual `DecideNextAction` BAML prompt if that prompt changes without a corresponding update here.
- A crash between posting the attempt marker comment and finishing filing all findings' tickets can
  leave some findings unfiled on a given attempt with no automatic retry, since the marker prevents
  re-processing that attempt. Considered acceptable given the secondary/best-effort nature of this
  loop.
