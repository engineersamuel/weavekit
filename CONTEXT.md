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
An automated check (types, lint, unit, eval, schema) interleaved with generation that must pass before a Run proceeds. Its control flow lives in code. The human as a *checkpoint on the council's output* (approval / sign-off) is eliminated and replaced by these automated checks.
_Avoid_: human approval gate, sign-off — and do not confuse with Elicitation, which is a distinct, sanctioned concept.

**Elicitation**:
The human as a *source of input* — supplying requirements or decisions a Run cannot infer — via an Intake interview (front door) or Clarifying questions (in-loop). Sanctioned and deliberately distinct from a Verification gate (the human as a checkpoint on output, which is eliminated). Elicitation never blocks a Run indefinitely: the human may skip or time out, the Run completes with the question recorded as unanswered, and it is enabled or disabled per run.
_Avoid_: approval, sign-off (those are Verification gates, which weavekit eliminates)

**Clarifying question**:
A typed question a Reasoning step emits *as data* (a step flags that human input is needed and emits a list of questions); the orchestrator decides whether to surface it, and the human may answer or skip. Declarative, in-loop Elicitation. The BAML step emits the question; the orchestrator asks — BAML never asks the human itself.
_Avoid_: ask_user (that is the agentic mechanism, used only at intake)

**Intake interview**:
An agentic, open-ended interview that sharpens an ambiguous request *before* a Run, driven by a harness session's own ask_user tool (e.g. the grill-me skill) and distilled into typed Council input. Bounded to the front door; the only place weavekit uses agentic ask_user.
_Avoid_: clarifying question (that is the in-loop, declarative form)

**Work item (Bead)**:
A durable, independently-schedulable unit of work with status and typed dependencies, living in an external queue (Beads). Weavekit produces none — see Decisions.
_Avoid_: ticket, issue, task (inside a Run)

## Decisions

- **Beads (durable work queue) — extensively evaluated and deliberately rejected.** Weavekit does not use Beads, or any durable work queue, for workflow orchestration. Workflows are isolated single-machine Runs that complete all work in-process; there is no second actor, no cross-session resumption, and no cross-run backlog to coordinate. Dynamic action graphs are orchestrated in-process, Langfuse captures the execution DAG, and verification is in-process gated checks plus CI. See [ADR 0001](docs/adr/0001-no-durable-work-queue.md).
- **Rivet (durable actor runtime) — evaluated and deferred.** Rivet has the strongest orchestration control-flow DSL of the options (steps, join/race, rollback, durable HITL, replay), but adopting it would reverse ADR 0001 (it reintroduces a second actor, work outliving the process, and human gates) and is inert for in-process Runs. Keep in-process Runs; bank control-flow wins in-process (fan-out/fan-in, in-process compensation, a thin auto-approve `HumanDecision` seam). Rivet is the named candidate — over Flue — only if the reopen triggers fire. See [ADR 0002](docs/adr/0002-defer-rivet-keep-in-process-runs.md).
- **Human-in-the-loop split — elicitation is sanctioned, verification/approval gates are not.** Weavekit may *elicit* input it cannot infer (an agentic Intake interview at the front door, and declarative in-loop Clarifying questions emitted by BAML and surfaced by the orchestrator), but does not reintroduce human *verification/approval* gates on the council's output (still eliminated per ADR 0001). Elicitation is in-process, per-run toggleable, and never blocks a Run: the human may skip/time out (unanswered recorded), and answers may instead be supplied by an automated resolver reading project context/goals, so a Run can be fully unattended. BAML emits questions as data; the orchestrator asks. See [ADR 0003](docs/adr/0003-elicitation-vs-verification-gates.md).
