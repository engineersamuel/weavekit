# Glossary

Terms introduced by weavekit design work that aren't self-explanatory from code alone. See linked
ADRs for the full decision record behind each term.

## `rlm`

A Copilot SDK tool (see [ADR 0010](adr/0010-recursive-llm-tool-rlm.md)) that a running Copilot SDK
session can call to recursively spin up a _new_ Copilot SDK client/session, in-process, with `rlm`
itself registered on that new session so it can recurse again. Distinct from Herdr/Trellage-based
delegation (`src/submind-poc/`, `mastermind-submind`), which drives genuinely separate OS
processes/panes. `rlm` calls:

- Start a clean-slate nested session (no inherited parent conversation history).
- Resolve a `profile` to a local config bundle (model, system-message append-block, allowed
  tools/skills).
- Decrement an internal depth budget on every hop and consume one shared total-call budget across
  all siblings and descendants. Both are enforced by orchestration code, not exposed to the LLM,
  and fail closed when exhausted.
- Return completed `ask_user` question/answer exchanges structurally so ancestor sessions can
  synthesize them even when deeper work fails.
- Emit one Langfuse span per call, nested under the caller's span, so the recursion tree is
  observable.

## Profile (in the `rlm` sense)

A local, versioned entity config that `rlm`'s `profile` parameter resolves to: `{ description,
purpose, model, systemMessage append-block, availableTools/excludedTools, skillDirectories }`.
Built-ins separate restricted validation, general Submind work, and capability-restricted review.
Not the same concept as a **Trellage profile** (a container image/harness definition selected via
`trellage --profile <name>`, or a native launcher profile selected via `<launcher> <profile>`) —
these are unrelated namespaces that happen to share the word "profile." `rlm` resolves the former;
`invoke_trellage` resolves the latter.

## `invoke_trellage`

A Copilot SDK tool (see [ADR 0011](adr/0011-invoke-trellage.md)) registered alongside `rlm` on the
root Submind session and on recursive `rlm` sessions. It delegates a bounded task to a **different
harness** running under a Trellage profile — container mode (`trellage --profile <name>`) or a
native launcher (`cpx`/`grx`/`cdx`/`cldx`/`prx`/`jcx`) — driven through Herdr's socket API in a
real PTY. Named for what it delegates to; the broader `invoke_harness` over vendor SDKs remains
deferred (see below). `invoke_trellage` calls:

- Provision (or reuse) one Herdr-managed git worktree per repository and launch the harness inside
  it, so mutating work never touches the user's checkout.
- Drive the agent through `agent.prompt`/`agent.wait`/`agent.read`, answering permission prompts by
  approving and questions via the same root-conversation answerer `rlm` uses for `ask_user`.
- Treat a **result file**, not Herdr's lifecycle state, as the authority on completion — because
  Herdr's `blocked` fires only for structured UI, so a prose question is indistinguishable from
  `idle`, and `agent.wait` tracks lifecycle state rather than turns.
- Consume one depth hop and one shared `RlmExecutionBudget` unit. The spawned harness is a leaf and
  cannot call back into `rlm`.

## Run storyboard

The live picture of one Submind run (see [ADR 0014](adr/0014-rlm-run-storyboard.md)). Every
completed `rlm` and `invoke_trellage` call is reported to one run-owned recorder through the narrow
`RlmVisualizationObserver` interface, in completion order, with its parent call named explicitly.
The recorder keeps three files current under `<workingDirectory>/.weavekit/rlm-visualization/`:
`visualization.html`, `visualization.png`, and `visualization-state.json`. The picture itself is
drawn by a Gemini BAML function, and its SVG is sanitized before it is written. Storyboard failures
are recorded as diagnostics and never change the delegated work's own result. Under Mastermind, the
final HTML and PNG are uploaded to the ticket and embedded in the execution comment; a run with no
ticket stays local.

## `invoke_harness` (still deferred)

A prospective tool for delegating to other harnesses' own SDKs (Claude Agent SDK, Pi SDK) or a
unifying layer like Vercel's `@ai-sdk/harness`, as opposed to `invoke_trellage`'s PTY-driven
Trellage delegation or `rlm`'s pure Copilot-SDK-on-Copilot-SDK recursion. Would need a two-call
bidirectional pattern (`invoke_harness` → `harness_respond`) for harnesses with genuine mid-session
pause/ask semantics, since a Copilot SDK tool handler cannot hold the outer LLM's turn open
indefinitely. `invoke_trellage` avoids that pattern by answering in-handler instead.
