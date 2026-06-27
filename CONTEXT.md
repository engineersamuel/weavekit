# Weavekit

Weavekit runs multi-persona deliberation workflows (the Decision Council) that debate a question and emit a recommendation, with BAML-typed reasoning and Langfuse/OpenTelemetry observability.

## Language

**Decision Council**:
The core workflow — a multi-persona deliberation that debates a question over rounds and emits a recommendation report.
_Avoid_: panel, committee, board

**Persona**:
A named viewpoint (archetype plus prompt) that contributes one perspective to a Council run through an LLM call.
_Avoid_: agent, role, expert

**Run**:
A single isolated, single-machine execution of a workflow from start to completion. Owns ephemeral typed state and completes all of its work in-process.
_Avoid_: job, session, batch

**Reasoning step**:
An individual LLM/BAML call inside a Run (persona, normalize, judge, re-plan). Recorded as a Langfuse span; never durable beyond the Run.
_Avoid_: action, task

**Harness call**:
A coarse invocation of an external agent or harness (e.g. `copilot -p <prompt>`) inside a Run. May fan out into many internal tool calls and produce an artifact, but is still one Reasoning step — not a unit of queued work.
_Avoid_: action

**Verification gate**:
An automated check (types, lint, unit, eval, schema) interleaved with generation that must pass before a Run proceeds. Its control flow lives in code.
_Avoid_: human gate (that is HITL — a distinct concept the verifier workflow aims to eliminate)

**Work item (Bead)**:
A durable, independently-schedulable unit of work with status and typed dependencies, living in an external queue (Beads). Weavekit produces none — see Decisions.
_Avoid_: ticket, issue, task (inside a Run)

## Decisions

- **Beads (durable work queue) — extensively evaluated and deliberately rejected.** Weavekit does not use Beads, or any durable work queue, for workflow orchestration. Workflows are isolated single-machine Runs that complete all work in-process; there is no second actor, no cross-session resumption, and no cross-run backlog to coordinate. Dynamic action graphs are orchestrated in-process, Langfuse captures the execution DAG, and verification is in-process gated checks plus CI. See [ADR 0001](docs/adr/0001-no-durable-work-queue.md).
