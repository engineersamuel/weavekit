# 0007 — Agent Loop policy

Status: accepted

In-repository automation such as Autonomous PR, the Template Optimizer, and future agent loops should follow a common operating policy. These are recommended defaults, not hard requirements: an automation may adopt a different design when its context warrants one, but the deviation should be explicit and reviewable.

Each loop starts from a defined trigger or schedule and runs for a bounded cadence; it does not continuously prompt a model without an end condition. The recommended experiment model is one change per round so that each round isolates one variable and its outcome is comparable with earlier rounds. This is a default, not an absolute rule: tightly coupled changes may be grouped when separating them would make the experiment misleading.

Every round runs the same repeatable check. For weavekit repository changes, that check includes `nub run typecheck` and `nub run test`. A loop may add checks required by its change surface, but it should not silently weaken or substitute the baseline between rounds. Completion is proof-based: command outcomes and other supporting evidence must be visible in the run artifacts rather than inferred from an agent's claim.

The loop persists a run ledger or state file alongside the existing `runs/` artifacts. The ledger records completed work, queued work, decisions, blockers, and verification evidence, and the next round reads it before selecting another change. This follows [ADR 0001](0001-no-durable-work-queue.md)'s on-disk run-state snapshot model. It does not create a durable work queue, a second orchestration actor, or a cross-Run backlog; execution remains in-process within an isolated Run.

Each loop defines explicit stop rules: a hard iteration cap plus terminal conditions for done and blocked outcomes. Automation-specific bounds compose with the Template Optimizer caps in [ADR 0005](0005-reusable-dag-planner-optimizer.md) and the admission control in [ADR 0006](0006-pre-run-budget-gate.md); this policy does not duplicate their iteration, candidate, or budget mechanisms.

Actions use a green/yellow/red approval model:

- **Green:** bounded local reads and writes to run artifacts and repository files, including repeatable checks. These actions may run unattended.
- **Yellow:** preparation of externally consequential changes for human review, such as opening a pull request. A loop may prepare and publish the review request, but it never merges or self-approves it. Yellow is a publication and authorization boundary, not an in-Run Verification gate; automated verification continues to compose with [ADR 0003](0003-elicitation-vs-verification-gates.md).
- **Red:** actions that commit money, affect production, or are outbound or customer-visible. These actions never run unattended and require explicit human authorization.

## Considered options

1. **No formal policy — rejected.** Each automation would independently rediscover cadence, evidence, persistence, stopping, and authorization boundaries, making behavior inconsistent and harder to review.
2. **Mandatory hard rules — rejected.** A single enforced loop shape would be over-rigid for automations with different experiment units, validation surfaces, and risk profiles.
3. **Recommended defaults in an ADR — chosen.** Shared defaults make automation behavior predictable while allowing an explicit, reviewable deviation when a use case warrants one.

## Consequences

Future in-repository automation should reference this ADR when defining its cadence, round state, checks, stop rules, and authorization boundaries. The approval tiers and other defaults remain advisory; this ADR adds no policy-enforcement code. This documentation-only change adds no runtime or cloud cost, so its budget impact is zero under the configured $500 warn ceiling.
