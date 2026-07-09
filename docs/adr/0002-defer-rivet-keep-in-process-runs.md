# 0002 — Defer Rivet (durable orchestration); keep in-process Runs

Status: accepted

We evaluated replacing weavekit's in-process workflow engine with Rivet (an open-source,
self-hostable Durable-Objects-style actor runtime). The driver was richer orchestration
control: human-in-the-loop (HITL) pauses, fan-out/fan-in, compensation/rollback, and parallel
sub-workflows.

On the merits of control flow, Rivet's `workflow()` is the strongest option available. It
provides an explicit durable control-flow DSL — `step` (per-step timeout + retry), `join`/`race`,
`tryStep`/`try`, rollback checkpoints with compensating actions, durable queue-waits (durable
HITL), durable sleeps, and replay-from-step. This is materially richer than Flue (whose
durability is agent-session/turn recovery plus finite-run inspection, with no step/join/race/
rollback DSL and no native HITL pause-resume) and richer than our current in-process loop.

We still rejected adopting it now. Rivet is a durable _actor_ runtime, so adopting it for the
control we described would reintroduce the three things [ADR 0001](0001-no-durable-work-queue.md)
deliberately removed: a second actor, work that outlives the orchestrator process, and human
gates. It also fights the product thesis that automated verification gates _eliminate_ HITL.
For isolated, single-machine Runs, most of Rivet's value is inert — durable suspension and
replay-from-step buy nothing in a process meant to finish in one sitting, and crash-resume is
already served by on-disk run-state snapshots plus the Langfuse execution DAG. Finally, the
deployment trajectory (whether weavekit becomes a hosted, async, multi-user service) is
undecided, so adopting Rivet now would bet on a direction we have not chosen.

Instead: keep in-process Runs and obtain the orchestration-control wins in-process —
fan-out/fan-in already exists (`Promise.all` over persona workers), add in-process compensation
(try/finally cleanup of persona sessions and partial artifacts), and add a thin `HumanDecision`
seam behind `DecisionCouncilWorkflowDeps` with an auto-approve default so Runs stay fully
automated unless explicitly gated. Flue remains an optional in-process host for a Run; it is not
stacked with a second durable engine.

## Reopen triggers

Revisit this ADR together with ADR 0001 if **any** of the following becomes real:

1. weavekit becomes a hosted/shared service with **async multi-user reviews**;
2. **durable HITL** that outlives a process becomes a product requirement;
3. runs must **survive process/host crashes mid-flight** beyond what on-disk snapshots cover;
4. **many concurrent long-lived runs** need scheduling and realtime progress.

At that point Rivet is the leading candidate — over Flue — specifically for the control-flow
axis. BAML (typed calls) and the Copilot SDK (persona workers) stay regardless of the substrate.

## Considered options

1. **In-process Runs + thin `HumanDecision` seam — chosen.** Keeps ADR 0001 intact, no new
   runtime, no durability tax; the seam preserves optionality so the same port can later be
   backed by a durable engine without rewriting council logic.
2. **Replace the engine with Rivet now — rejected.** Reverses ADR 0001 (second actor, work
   outliving the process, human gates); most value is inert for in-process Runs; real
   operational weight (run a runtime, model Runs as actors, version/deploy); bets on an
   undecided hosted pivot.
3. **Adopt Rivet alongside Flue — rejected.** Both are durable/hosting substrates (Flue on
   Cloudflare _is_ Durable Objects; Rivet is a DO alternative). Stacking them is two durability
   layers — redundant and confusing. Coherent coexistence is only "alternative backends behind a
   seam," never both running together.
4. **Lean harder on Flue's durability for control — rejected.** Flue has no step/join/race/
   rollback DSL and no native HITL pause-resume, so it does not satisfy the control-flow goal.

## Consequences

Council orchestration stays in `src/decision-council/` as in-process TypeScript. A
`HumanDecision` port may be added behind `DecisionCouncilWorkflowDeps` with an auto-approve
default. No Rivet dependency is added. Any future durable-execution work must revisit ADR 0001
and this ADR together.
