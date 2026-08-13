# 0012 — Wire Mastermind's DELEGATE_SUBMIND action to the RLM executor

Status: accepted

## Context

Mastermind ([ADR 0009](0009-mastermind-durable-control-plane.md)) pulls a Linear ticket, reviews
it, and calls `DecideNextAction` to choose exactly one `MastermindAction`:
`REVIEW_TICKET` / `IMPLEMENT_DIRECTLY` / `DELEGATE_SUBMIND` / `WAIT` / `NEEDS_HUMAN` / `IGNORE`.
`DELEGATE_SUBMIND` already existed end-to-end in the decision model, the durable state machine,
and project policy's allowed-actions list, but `MastermindExecutionCoordinator.beginExecution()`
only ever created an execution attempt for `IMPLEMENT_DIRECTLY`. A ticket planned as
`DELEGATE_SUBMIND` never executed anything — the coordinator silently no-opped it.

Separately, `rlm-poc` ([ADR 0010](0010-recursive-llm-tool-rlm.md)) implements "Submind": a
recursive Copilot SDK meta-harness that can plan, fan out to nested profile sessions, and
optionally delegate real repository work into Trellage-managed Herdr worktrees
([ADR 0011](0011-invoke-trellage.md)). `DELEGATE_SUBMIND`'s name and intent ("planning, fan-out,
synthesis, or multiple workers are likely needed" per the BAML prompt) map directly onto what RLM
is for. This ADR closes the gap by making `DELEGATE_SUBMIND` actually invoke RLM.

## Decision

- **Executor duality, not replacement.** `MastermindExecutionCoordinator` now holds a
  `DirectExecutorResolver` (`Partial<Record<ExecutorKind, DirectExecutor>>`) instead of one fixed
  `DirectExecutor`. `IMPLEMENT_DIRECTLY` continues to resolve to `HerdrDirectExecutor` (shells out
  to `herdr agent` running the plain `copilot` CLI); `DELEGATE_SUBMIND` resolves to the new
  `RlmDirectExecutor`. Both are constructed by `createMastermindExecutionCoordinator()`
  (`src/mastermind/execution/factory.ts`) whenever their respective config block
  (`mastermind.execution` / `mastermind.rlmExecution`) is present, and both stay gated by each
  project's `directExecution.allowedExecutorKinds`.
- **Config split.** `mastermind.rlmExecution` is a sibling block to `mastermind.execution`, with
  its own `maxAttempts` / `unknownStatusThreshold` / `cancellationGraceMs` (read via
  `requireExecutionConfig(kind)`), plus RLM-specific knobs: profile fixed to `general` (not
  `superpowers`), `enableTrellage` defaulting to `true`, `maxDepth`, `maxTotalCalls`.
- **Store-level fix.** `beginExecution()`'s action→executor mapping
  (`resolveExecutionSelectionForAction`) was necessary but not sufficient: the SQLite store's
  `createExecutionAttempt()` unconditionally hardcoded `action: MastermindAction.IMPLEMENT_DIRECTLY`
  in its eligibility check, INSERT, and row-mapping, so it rejected (or silently mislabeled) any
  attempt not for that action. `ExecutionAttempt.action` was widened from the literal
  `IMPLEMENT_DIRECTLY` to the full `MastermindAction` union, and `createExecutionAttempt()` now
  takes and threads through an explicit `action` argument end to end.
- **Detached process, not in-process `await`.** `runRlmSubmind()` is a plain async SDK call, not an
  external pane like Herdr's `herdr agent`. But Mastermind's coordinator must survive a restart
  mid-run (ADR 0009's durable-control-plane design), and RLM sessions can run for well over an
  hour. `RlmDirectExecutor.start()` therefore spawns `node scripts/rlm-poc.ts` as a **detached**
  child process (`--prompt-file`, `--cwd` pointed at the already-provisioned ticket worktree,
  `--output-json`, `--trellage` when enabled) rather than awaiting the call directly, matching the
  existing `start`/`status`/`collect`/`cancel` executor contract.
- **Result contract: manifest first, fallback second.** The RLM child process always writes its
  raw `runRlmSubmind()` return value (`finalText`/`conversationId`/`traceId`) to
  `--output-json` the instant the call resolves — this is Submind's literal final answer, captured
  for a separate coordinator poll cycle to read back, not a synthesized guess.
  `RlmDirectExecutor.collect()` consults, in order: (a) `.weavekit/mastermind-result.json` — the
  same transport-agnostic manifest contract (`buildDirectExecutionPrompt`) already used by Herdr —
  if the delegated implementation session honored it, using the shared `resultManifest.ts` parsing
  (extracted so both executors validate identically); (b) if absent, the captured RLM output is
  wrapped into a `needs-human` result rather than auto-synthesizing a `succeeded` outcome from
  unstructured text. Treating "no manifest" as a `NEEDS_HUMAN` signal — not a parse-and-guess
  opportunity — is the conservative default given real-world RLM report shapes haven't been
  observed yet; a future BAML-based extraction/normalization step could revisit this.
- **Trellage stays enabled by default** for this path so the RLM session can itself provision
  additional nested Herdr worktrees if it decides that's the right shape for the ticket, at the
  cost of possible worktree/pane sprawl worth watching in practice.

## Consequences

- `DELEGATE_SUBMIND`-planned work items now actually execute instead of silently stalling in
  `ACTION_PLANNED`.
- `DirectExecutor.collect()`'s signature grew a second `request: DirectExecutionRequest` parameter
  (previously `handle`-only) because the RLM fallback path needs the attempt's authoritative
  `workId`/`attemptId`/`attemptNumber` to build a valid `needs-human` result — it cannot be
  reliably recovered from `ExecutorHandle.agentName` alone. Both executors and their call sites
  were updated; this was a clean break with only one production call site.
- `cancel()` semantics for RLM are weaker than Herdr's graceful `agent send-keys ctrl-c` +
  `agent wait --until idle`: a `SIGTERM`/`SIGKILL` to the detached wrapper process may not cleanly
  unwind an in-flight Copilot SDK session. This remains an open spike item, not blocking for this
  change since cancellation is already a rare path.
- README's existing `DELEGATE_SUBMIND` prose (describing a different, previously-unimplemented
  Herdr-skill-staging design) should be treated as superseded by this ADR going forward.
