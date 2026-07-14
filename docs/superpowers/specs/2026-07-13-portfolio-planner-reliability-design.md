# Portfolio Planner Reliability Design

## Problem

The first two live `eslint-to-oxlint` Weavekit generations did not produce canonical
portfolio plans. Their Copilot Plan sessions reached the configured 300-second timeout
after receiving 103,537- and 101,730-character prompts. The generic SDK fallback then
returned the last non-empty assistant message as success. Those messages were only 419
and 531 characters and ended with preparatory statements such as "Now writing the
canonical plan" and "Let me write the plan."

The downstream BAML distiller expanded each preamble into a structurally valid draft.
The semantic audit correctly rejected the resulting plan after one bounded repair. This
means the audit is working; the generation/completion boundary is fail-open.

The latest 101,730-character prompt also repeats canonical data. Source analysis,
discovered opportunities, full opportunity decisions, and corroboration consume 57,180
characters even though the practice ledger, applicability matrix, required coverage,
accepted coverage, and specialized obligations already normalize the information needed
by the portfolio planner.

## Goals

- Never treat a timed-out, unfinished `plan-portfolio` assistant message as a completed
  canonical plan.
- Reduce the portfolio prompt to canonical compiler inputs without losing required
  behavior, proof, evidence, layer, migration, or compatibility coverage.
- Persist prompt-size evidence so future regressions are visible in workflow artifacts.
- Preserve the existing semantic audit and one-repair limit.
- Keep timeout-partial behavior unchanged for existing research and other harness calls.

## Non-goals

- Raising the global Copilot timeout.
- Weakening portfolio audit requirements.
- Adding more repair attempts or asking the audit model to recreate a missing plan.
- Splitting portfolio generation into additional LLM calls before the compact single-call
  path has been measured live.
- Changing Promptfoo generation/judge lineage or score aggregation.

## Considered approaches

### Raise the timeout only

This may allow a large prompt to finish, but it preserves prompt inflation and the
fail-open correctness bug. A future timeout could still convert preparatory prose into a
plan. Rejected.

### Compact the prompt only

Removing duplicated sections should improve latency, but any timeout would still accept
arbitrary non-empty assistant text. This improves the trigger without fixing the invalid
completion boundary. Rejected as incomplete.

### Compact canonical context and fail closed at the portfolio boundary

This is the selected approach. The generic harness gains a per-call timeout-partial
policy. Existing calls retain their current default; `plan-portfolio` explicitly forbids
timeout partials. Portfolio prompt construction accepts only the canonical compiler
projection. Prompt diagnostics record the route, total characters, and section sizes.

## Design

### Completion policy

`CopilotHarnessClient.run()` gains `acceptPartialOnTimeout?: boolean`. The default remains
`true` to avoid changing existing research and plan surfaces. The value is forwarded
through `sendCopilotPromptAndWait()` to `sendWithPartialAssistantFallback()`.

When a session times out:

- if `acceptPartialOnTimeout !== false` and non-empty assistant content exists, preserve
  the existing `timeout-partial` behavior;
- otherwise emit a `timeout-rejected-partial` diagnostic and throw the existing timeout
  error;
- never send rejected content to plan persistence or BAML distillation.

The `plan-portfolio` call sets `acceptPartialOnTimeout: false`. Other calls remain
unchanged.

### Canonical portfolio context

`PortfolioPromptInput` contains only:

- original objective;
- target-project brief;
- canonical source-practice ledger;
- project-applicability matrix;
- required coverage;
- accepted-opportunity coverage;
- specialized obligations.

The compiler prompt does not include the full source-analysis envelope, corroboration
envelope, discovered-opportunity set, or full acceptance-decision set. Evidence needed by
planning is already attached to the canonical ledger, matrix, and accepted coverage.
Opportunity-review findings and child plans remain available only on the synthesis route,
where they are not duplicates of the compiler projection.

### Prompt diagnostics

Portfolio prompt construction returns the prompt plus deterministic diagnostics:

```ts
type PortfolioPromptDiagnostics = {
  route: "direct" | "synthesis";
  totalChars: number;
  sections: Record<string, number>;
};
```

Section sizes are measured from the exact rendered strings, not estimated token counts.
The `plan-portfolio` payload persists these diagnostics as `portfolioPromptDiagnostics`,
and execution metadata includes the same object. Prompt text remains in the existing
execution metadata for full traceability.

### Data flow

The resulting path is:

1. Source/project research is distilled into the practice ledger and applicability
   matrix.
2. Council output is compiled into required and accepted coverage.
3. The portfolio prompt renderer receives only that canonical projection.
4. Copilot Plan must reach `session.idle`; a timeout partial is rejected.
5. Only completed output reaches `DistillPlanArtifact` and
   `DistillPortfolioPlanDraft`.
6. The existing semantic audit and at-most-one repair remain authoritative.

## Testing

- A Copilot SDK unit test proves research calls still accept timeout partials.
- A new unit test proves a call with `acceptPartialOnTimeout: false` rejects the same
  partial and logs `timeout-rejected-partial`.
- A portfolio harness test proves `plan-portfolio` passes the fail-closed policy.
- Prompt tests prove redundant envelopes are absent while canonical ledger,
  applicability, coverage, obligations, review findings, and child plans remain.
- A captured-size regression fixture proves the compact prompt is materially smaller
  than the prior 101,730-character prompt and below a 60,000-character ceiling.
- Existing portfolio audit/repair tests remain unchanged and green.
- Live acceptance requires a persisted Promptfoo generation ID, a non-empty Weavekit
  canonical plan, a passed portfolio audit, and linked judge evaluation output.

## Acceptance criteria

1. `plan-portfolio` cannot return a timeout partial as success.
2. Research timeout partial behavior remains backward compatible.
3. The captured ESLint portfolio prompt is below 60,000 characters.
4. Prompt diagnostics are persisted in the workflow state.
5. All existing static and unit verification passes.
6. A live `eslint-to-oxlint` run produces a valid audited Weavekit plan before the full
   matrix is attempted.
