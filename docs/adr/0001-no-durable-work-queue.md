# 0001 — No durable work queue (Beads) for workflow orchestration

Status: accepted

Weavekit workflows run as isolated, single-machine Runs that complete all work within the Run. We evaluated Beads — a durable, Dolt-backed, CLI-driven work queue — extensively, including using it as a dynamic, BAML-generated DAG of harness-call "actions," and rejected it. None of Beads' distinctive value applies: there is no second actor or shared queue (multi-actor coordination), no work that outlives the orchestrator process (durable handoff/resumption — crash-resume is served instead by on-disk run-state snapshots), and no cross-run backlog (we accumulate no follow-up work between Runs). Beads also cannot pass payloads between steps (a work item carries no output field) and spawns a subprocess per operation, so as an in-run scheduler it is only a slow, payload-less shadow of an in-process scheduler.

Instead: dynamic action graphs are orchestrated in-process; Langfuse captures the execution DAG; verification is in-process gated checks plus CI, not queue dependencies or human gates.

## Considered options

1. **In-process scheduler + Langfuse + on-disk run state — chosen.** Passes real payloads, no per-op subprocess, no durability tax, and the execution DAG is already observable in Langfuse.
2. **Beads as an in-run dynamic DAG engine — rejected.** Substrate mismatch: subprocess per op, and a work item cannot carry the output the next step needs, so real state stays in-process anyway.
3. **Beads as a run-boundary follow-up backlog — rejected.** No cross-run accumulation of work; each Run completes its own follow-ups, and the run report already enumerates next steps.

## Consequences

The `src/work-queue/` module, the `--work-item` / `--create-beads-workflow` CLI surface, the `weavekit work` subcommand, and `docs/beads.md` are removed. Future workflow designs must not reintroduce a durable work queue without revisiting this decision.
