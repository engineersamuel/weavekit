# 0007 — Agent Loop policy

Status: accepted

In-repository automation such as Autonomous PR, the Template Optimizer, and future agent loops should follow a common operating policy. These are recommended defaults, not hard requirements: an automation may adopt a different design when its context warrants one, but the deviation should be explicit and reviewable.

Each loop begins only when invoked by a defined trigger or schedule; it does not continuously prompt a model. Within that invocation, rounds follow a defined cadence for selecting, changing, and checking work. The recommended experiment model is one change per round so that each round isolates one variable and its outcome is comparable with earlier rounds. This is a default, not an absolute rule: tightly coupled changes may be grouped when separating them would make the experiment misleading. A separate hard iteration cap, described below, bounds how many rounds the invocation may run.

Every round runs the same repeatable check. For weavekit repository changes, that check includes `nub run typecheck` and `nub run test`. A loop may add checks required by its change surface, but it should not silently weaken or substitute the baseline between rounds. Completion is proof-based: command outcomes and other supporting evidence must be visible in the run artifacts rather than inferred from an agent's claim.

The loop persists a run ledger or state file alongside the existing `runs/` artifacts. The ledger records completed work, remaining candidate changes within the current Run, decisions, blockers, and verification evidence; the next round in that Run reads it before selecting another change. This follows [ADR 0001](0001-no-durable-work-queue.md)'s on-disk run-state snapshot model. The ledger's lifecycle closes with its Run: it is not independently consumed or carried into later Runs. It does not create a durable work queue, a second orchestration actor, or a cross-Run backlog; execution remains in-process within an isolated Run.

Each loop defines explicit stop rules: a hard iteration cap plus terminal conditions for done and blocked outcomes. Automation-specific bounds compose with the Template Optimizer caps in [ADR 0005](0005-reusable-dag-planner-optimizer.md) and the admission control in [ADR 0006](0006-pre-run-budget-gate.md); this policy does not duplicate their iteration, candidate, or budget mechanisms.

Actions use a green/yellow/red authorization model:

- **Green:** bounded local reads and writes to run artifacts and repository files, including repeatable checks. These actions may run unattended.
- **Yellow:** preparation of externally consequential changes for human review. A loop may publish a review-only artifact, such as opening a pull request, but it never merges or self-approves it.
- **Red:** actions touching **money**, meaning an explicit financial transaction or LLM spend that neither [ADR 0006](0006-pre-run-budget-gate.md)'s active budget-gate policy nor a valid override admits; **production**, by mutating it; or **outbound or customer-visible surfaces**, by directly executing or communicating beyond a review-only artifact. Red actions never run unattended and require explicit human authorization. Normal metered model use admitted by the active budget-gate policy—including advisory warn-mode admission—or by a valid override is not Red solely because it incurs usage cost.

The tiers are authorization boundaries, not Verification checkpoints. An in-process Run never pauses for approval: it may publish a Yellow review-only artifact during the Run, but a Red action must be pre-authorized or the Run stops at a draft or plan for later human execution. Automated in-Run verification therefore continues to compose with [ADR 0003](0003-elicitation-vs-verification-gates.md).

## Considered options

1. **No formal policy — rejected.** Each automation would independently rediscover cadence, evidence, persistence, stopping, and authorization boundaries, making behavior inconsistent and harder to review.
2. **Mandatory hard rules — rejected.** A single enforced loop shape would be over-rigid for automations with different experiment units, validation surfaces, and risk profiles.
3. **Recommended defaults in an ADR — chosen.** Shared defaults make automation behavior predictable while allowing an explicit, reviewable deviation when a use case warrants one.

## Consequences

Future in-repository automation should reference this ADR when defining its cadence, round state, checks, stop rules, and authorization boundaries. The authorization tiers and other defaults remain advisory; this ADR adds no policy-enforcement code. This documentation-only change dispatches no model or runtime work and adds zero projected runtime or cloud cost. [ADR 0006](0006-pre-run-budget-gate.md) and typed configuration remain the source of truth for budget policy and values.
