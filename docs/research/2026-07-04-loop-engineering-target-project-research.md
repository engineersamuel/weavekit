# Target project research — loop-engineering vs. weavekit

Source: https://github.com/cobusgreyling/loop-engineering
Objective: adapt loop-engineering's control-loop primitives to weavekit's static DAG templates and dynamic (replanned) workflows.

## Project brief

**Architecture (confirmed by inspection):**

- Weavekit's workflow engine lives in `src/macro-workflow/`. A `RuntimeWorkflowPlan` (`src/macro-workflow/types.ts`) is a **static, acyclic DAG** of `RuntimeWorkflowNode`s with `dependsOn`, `gates` (`output-contract` / `review-accepted` / `verification`), `writeMode` (`read-only` | `single-writer`), and a per-node `replanPolicy`.
- Concrete templates (`src/macro-workflow/templates.ts`) — e.g. `implementation-review`, `source-to-project` — hard-code the node sequence: research → deliberation/council → implementation (single writer) → verification → report.
- **Dynamic behavior is bounded, not open-ended**: `runner.ts` executes the static plan and, on gate failure, may request a `WorkflowReplanPatch` (`replaceRemainingNodeIds` + `newNodes`) up to `plan.maxReplans` times (`runner.ts:102`, `verifier.ts:166`). `verifyWorkflowReplanPatch` re-validates the patched plan against the same grammar (`grammar.ts`) before it is allowed to run. There is no unbounded loop construct anywhere in the engine — `verifyWorkflowPlan` explicitly rejects cycles (`detectCycle`, `verifier.ts:206-208`).
- **Maker/checker separation already exists**, implemented differently than loop-engineering's worktree-per-attempt model: `writeMode: "single-writer"` plus the grammar's parallel-writer check (`verifier.ts:210-223`) and mandatory downstream verification for any `IMPLEMENTATION` node (`missing-verification`, `verifier.ts:225-233`) enforce that only one node writes and every write is gated by a deterministic `VERIFICATION` node (`src/macro-workflow/verifier.ts` top-level, distinct from the plan-level `verifier.ts`) before a `report` node runs.
- **Worktree isolation already exists** for Autonomous PR mode: `src/macro-workflow/sourceToProject/worktree.ts` (`prepareAutonomousWorktree`) creates/rebases an isolated git worktree, copies `.env*` files, and records a baseline commit before any file mutation — conceptually identical to loop-engineering's "isolated worktrees for edits," but scoped to one Run, not a recurring scheduled loop.
- **Cost/usage tracking already exists**: `src/macro-workflow/usage.ts` defines `WorkflowUsageRecord` / `WorkflowUsageSummary` with per-model USD pricing tables and an `estimatedCostUsd` rollup — functionally the same shape as loop-engineering's `tools/loop-cost/src/estimator.ts`, but computed post-hoc per Run rather than as a pre-run budget gate.
- **Iteration capping already exists**: `plan.maxReplans` (checked in `verifier.ts:166`, consumed in `runner.ts:102`) is the direct analog of loop-engineering's max-iteration / circuit-breaker guard — it is per-Run, not per-scheduled-loop.
- Grammar constraints (`grammar.ts`) — `allowedNodeKinds`, `allowedHarnesses`, `allowedTransitions`, `maxReplans` — are the closest existing equivalent to loop-engineering's "constraints file loaded before triage/action" pattern, but they gate DAG shape/transitions, not file-path denylists or connector scopes.

**Explicit architectural decisions that constrain applicability** (docs/adr, cited verbatim):

- **ADR 0001 — "No durable work queue"** (`docs/adr/0001-no-durable-work-queue.md`): weavekit "workflows are isolated single-machine Runs that complete all work within the Run." It rejects any second actor, any work that outlives the orchestrator process, and any cross-run backlog. This is a direct, deliberate rejection of loop-engineering's core premise — a **scheduler that runs recurring, cross-session loops against durable state** — when read literally as "run scheduled cron loops with persistent cross-run state."
- **ADR 0002 — "Defer Rivet; keep in-process Runs"** (`docs/adr/0002-defer-rivet-keep-in-process-runs.md`): explicitly rejects durable HITL pause/resume and durable suspend/replay-from-step "for isolated, single-machine Runs." Reopen triggers are named: hosted/async multi-user service, durable HITL, crash survival beyond on-disk snapshots, many concurrent long-lived runs. None of these are currently true of weavekit.
- **CONTEXT.md** vocabulary section defines "Run" as "a single isolated, single-machine execution... completes all of its work in-process," and explicitly opposes "job, session, batch." It also defines "Verification gate" as replacing human sign-off with automated checks — i.e., weavekit already implemented the maker/checker idea loop-engineering calls out, but via automated gates in one Run rather than a separate scheduled verifier loop.
- Repo-level custom instructions (visible in this session) state directly: **"Do not add a durable work queue (e.g. Beads) for workflow orchestration... orchestrate dynamic action graphs in-process, record the execution DAG in Langfuse, and snapshot run state to disk for resume."** This is a standing, explicit constraint on any adaptation work.

**Goals inferred from templates/ADRs:** deterministic, auditable, single-Run DAGs with bounded (not unbounded) dynamism; typed BAML contracts for LLM outputs; Langfuse/OTel spans as the execution-DAG record (replacing loop-engineering's run logs); automated verification gates replacing human approval.

**Validation commands (from `package.json`, confirmed present):**

- `nub run typecheck` (`tsc --noEmit`)
- `nub run test` (`vitest run`) — relevant existing suites: `tests/macro-workflow/verifier.test.ts`, `tests/macro-workflow/templates.test.ts`, `tests/macro-workflow/runner.test.ts`, `tests/macro-workflow/replanning.test.ts`, `tests/macro-workflow/replay.test.ts`
- `mise run doctor` (per repo custom instructions) after editing `entities/**/*.yaml` or BAML-referenced schemas — not directly relevant unless a change touches entity manifests.
- No lint script found in `package.json`; only `test`, `typecheck`, `build`, `baml-generate`, `baml-health`, `council`, `eval*`, `bench:router`, `repro:*`, `smoke:*`.

## Source-relevant change surfaces (where lessons could land)

1. **Iteration/circuit-breaker hardening** — `plan.maxReplans` + `grammar.maxReplans` (`verifier.ts:166`, `grammar.ts`, `runner.ts:102`) is the natural landing spot for loop-engineering's "retry caps, normalized error signatures, stagnation detection" lesson. Concretely: `runner.ts`'s replan loop currently just decrements a counter — it does not appear to detect a _repeated identical failure reason_ (stagnation) before spending replans, which is the strongest transferable, low-risk lesson.
2. **Budget/cost as a pre-run gate, not just post-hoc reporting** — `usage.ts` computes `estimatedCostUsd` after the fact. Loop-engineering's `templates/SKILL.md.loop-budget` + `tools/loop-cost/src/estimator.ts` pattern (budget declared _before_ the run, checked as an early-exit condition) could be adapted as a new `WorkflowGateKind` (e.g., a budget-ceiling check) evaluated between nodes, without adding any new durable/queued component — this stays entirely in-process and is consistent with ADR 0001/0002.
3. **Constraints-file-before-action pattern** → weavekit's `grammar.ts` (`allowedNodeKinds`, `allowedHarnesses`, `allowedTransitions`) is structurally similar to loop-engineering's `loop-constraints.md` pre-check, but only constrains DAG _shape_. A file-path denylist / connector-scope check (loop-engineering's `docs/safety.md` idea) is not currently modeled anywhere in `grammar.ts` or `verifier.ts` and would be a genuinely new, additive gate rather than a duplicate of something that already exists.
4. **Readiness auditing** — loop-engineering's `tools/loop-audit/src/auditor.ts` scores presence of loop artifacts. Weavekit's `verifyWorkflowPlan`/`verifyWorkflowReplanPatch` already function as a structural auditor for DAG shape; extending it to check for the _presence_ of a downstream budget/verification/report node per template (beyond the existing `missing-verification` check) is incremental, not new.
5. **Failure-mode catalog** — loop-engineering's `docs/failure-modes.md` documents named failure modes (infinite fix loops, state rot, token burn, collisions) with mitigations. Weavekit has `WorkflowReplanReason` (`contract-failure`, `review-rejection`, `verification-failure`, `unsupported-shape`) as a partial analog but no equivalent named catalog doc; a documentation-only addition (a `docs/` failure-mode reference tied to existing `WorkflowReplanReason` values) is low-risk and directly transferable.

## Non-applicability notes (do not force these)

- **Scheduler / cron-triggered recurring loop against durable cross-run state** — directly conflicts with ADR 0001 ("no second actor," "no work outliving the orchestrator process," "no cross-run backlog") and ADR 0002 (rejects durable HITL/suspend-resume "for isolated, single-machine Runs"). Do not introduce a scheduler, external queue, or persistent cross-Run state file. If a periodic-trigger need is real, it belongs _outside_ weavekit's Run boundary (e.g., an external cron invoking a fresh Run), not inside `src/macro-workflow/`.
- **Beads-style durable work-item queue** — ADR 0001 rejects this by name, including the specific "dynamic BAML-generated DAG of harness-call actions" framing loop-engineering uses. Any adaptation must stay in-process (`runner.ts` + `Promise.all` fan-out + Langfuse spans), not reintroduce a queue.
- **Worktree-per-scheduled-attempt with long-lived state across runs** — weavekit's `prepareAutonomousWorktree` already does per-Run worktree isolation; extending it to _persist and reuse_ worktree state across independent Runs (loop-engineering's model) would reintroduce the "second actor / work outliving the process" pattern ADR 0001/0002 reject. Keep worktree lifecycle scoped to one Run.
- **Kill-switch / pause-resume as a durable primitive** — loop-engineering's kill-switch assumes a long-running external loop that can be paused between iterations. Weavekit Runs are meant to complete in one sitting; the applicable analog is a hard `maxReplans`/budget ceiling that aborts _within_ the current Run, not a resumable pause state.
- **Auditor tool as a separate standing service** — loop-engineering's auditor operates across a repo's committed loop artifacts over time. Weavekit's structural verification (`verifier.ts`) already runs synchronously as part of each Run's plan validation; a separate persistent "readiness scoring service" would be new infrastructure outside the Run boundary and is not warranted by current goals.

## Risks / open questions

- The strongest, safest transferable change (stagnation/repeated-failure detection before exhausting `maxReplans`) requires reading `runner.ts` in full (currently only lines around 102 inspected) to confirm whether `WorkflowReplanEvent.reason` history is retained per node/replan — needed before designing a stagnation check.
- A new budget-ceiling `WorkflowGateKind` would touch `types.ts`, `grammar.ts`, `verifier.ts`, and every template in `templates.ts`, plus their tests (`templates.test.ts`, `verifier.test.ts`) — moderate blast radius, should be scoped as its own planning task rather than bundled with the failure-mode-catalog documentation task.
- No lint command exists in this repo; only `typecheck` and `test` gate correctness for `src/macro-workflow/` changes.

## Citations

- `CONTEXT.md` (Run, Verification gate, Worktree preparation, Work item/Bead definitions; ADR summaries)
- `docs/adr/0001-no-durable-work-queue.md`
- `docs/adr/0002-defer-rivet-keep-in-process-runs.md`
- `src/macro-workflow/types.ts` (RuntimeWorkflowPlan/Node, WorkflowReplanReason, WorkflowGateKind)
- `src/macro-workflow/templates.ts` (implementation-review template, lines 1-90)
- `src/macro-workflow/verifier.ts` (full file — cycle detection, single-writer/parallel-writer check, missing-verification check, maxReplans bound, replan-patch re-validation)
- `src/macro-workflow/runner.ts:102` (`remainingReplans = remainingPlan.maxReplans`)
- `src/macro-workflow/grammar.ts` (allowedNodeKinds/Harnesses/Transitions, maxReplans)
- `src/macro-workflow/usage.ts` (WorkflowUsageRecord/Summary, per-model USD pricing)
- `src/macro-workflow/sourceToProject/worktree.ts` (`prepareAutonomousWorktree`)
- `package.json` (scripts: test, typecheck, build, etc.)
- Repo custom instructions (session context): "Do not add a durable work queue... orchestrate dynamic action graphs in-process... snapshot run state to disk for resume."
