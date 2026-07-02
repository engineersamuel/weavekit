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

**Source artifact**:
An external knowledge object such as a blog post, article, or research paper that a Run interprets for lessons applicable to a target project.
_Avoid_: document, content, input

**Source access level**:
The handling classification for a Source artifact that determines whether adapters may use public web tools, local-only processing, or sanitized reporting.
_Avoid_: privacy flag

**Source ingestion**:
The normalization of a Source artifact into a typed Source analysis contract, regardless of whether the artifact starts as a URL, file, paper, or pasted text.
_Avoid_: fetch, parse (implementation details)

**Target project**:
The single repository or project context a Run evaluates against a Source artifact. A portfolio analysis is a fan-out of separate Runs, not one Run spanning many projects.
_Avoid_: repo (when the project context is broader than files), project set

**Project catalog**:
The configured set of named Target projects available for Runs to select by stable project identity instead of ad hoc filesystem paths.
_Avoid_: repo list, workspace list

**Source-to-project workflow**:
A named workflow that interprets one Source artifact against one Target project to produce ranked Opportunities, Plan artifacts, and optionally pull requests.
_Avoid_: blog workflow, research workflow

**Source analysis**:
A read-only interpretation of a Source artifact that extracts its claims, assumptions, evidence, and transferable lessons before considering a Target project.
_Avoid_: summary

**Corroboration**:
Bounded external research that checks a Source artifact's claims, competing views, and evidence quality before Opportunity mapping.
_Avoid_: deep research (too broad), web search

**Target project research**:
A read-only investigation of the Target project that identifies relevant architecture, constraints, goals, and change surfaces before considering a Source artifact.
_Avoid_: repo scan, code search

**Project brief**:
The typed result of Target project research: the project facts, constraints, goals, change surfaces, validation commands, and risk notes needed to judge Source artifact applicability.
_Avoid_: research transcript, repo summary

**Opportunity mapping**:
The join point that relates Source analysis to Target project research and identifies project-specific opportunities, non-applicable lessons, and open questions.
_Avoid_: insight extraction, improvement list

**Opportunity**:
A project-specific, source-grounded improvement candidate that can be ranked, planned, accepted as advisory, or rejected as not worth pursuing.
_Avoid_: insight, idea, recommendation (too broad)

**Non-applicable lesson**:
A Source artifact lesson that was considered against the Target project and rejected with a recorded reason.
_Avoid_: rejected idea, irrelevant insight

**Opportunity budget**:
The configured maximum number of ranked Opportunities that may proceed from council review into planning during one Run.
_Avoid_: max actions, task limit

**Opportunity threshold**:
The configured score criteria an Opportunity or Opportunity bundle must satisfy before it may produce a Plan artifact or enter Autonomous PR mode.
_Avoid_: quality bar, cutoff

**Plan artifact**:
The stored implementation plan produced for a selected Opportunity before any Target project changes are made.
_Avoid_: plan-mode transcript

**Opportunity bundle**:
One or more tightly related Opportunities that are planned and implemented together because they share the same change surface and review story. A valid bundle has an explicit rationale, shared value, separation risk, and scope statement.
_Avoid_: batch, task group

**Advisory mode**:
A Run mode that produces analysis, ranked opportunities, plans, and a report without modifying the Target project.
_Avoid_: read-only mode

**Autonomous PR mode**:
A Run mode that may modify the Target project and prepare a review-ready pull request after opportunities and plans pass automated Verification gates. It never merges or self-approves the pull request.
_Avoid_: autonomous mode, auto-implement (too vague)

**Worktree preparation**:
The required preflight that creates or selects an isolated Target project worktree, refreshes it from the configured mainline by rebasing, copies required environment files without recording their contents, and records the baseline before Autonomous PR mode may modify files.
_Avoid_: checkout setup, branch setup

**Reasoning step**:
An individual LLM/BAML call inside a Run (persona, normalize, judge, re-plan). Recorded as a Langfuse span; never durable beyond the Run.
_Avoid_: action, task

**Harness call**:
A coarse invocation of an external agent or harness (e.g. `copilot -p <prompt>`) inside a Run. May fan out into many internal tool calls and produce an artifact, but is still one Reasoning step — not a unit of queued work.
_Avoid_: action

**Initial router**:
A lightweight front-door classifier that inspects an incoming prompt and chooses the next workflow (for example plan, research, decision council, elicitation, or direct handling) before the main harness starts.
_Avoid_: orchestrator, dispatcher (those are implementation choices, not the concept)

**Route decision**:
The typed output of the Initial router: the selected route plus the scores and rationale that explain why it was chosen.
_Avoid_: routing policy (that is the implementation strategy, not the domain object)

**Verification gate**:
An automated check (types, lint, unit, eval, schema) interleaved with generation that must pass before a Run proceeds. Its control flow lives in code. The human as a *checkpoint on the council's output* (approval / sign-off) is eliminated and replaced by these automated checks.
_Avoid_: human approval gate, sign-off — and do not confuse with Elicitation, which is a distinct, sanctioned concept.

**Promotion decision**:
A human choice at a Run boundary that selects whether a completed recommendation should remain advisory or trigger a follow-on mode such as planning, implementation, or pull-request creation. It is not a Verification gate inside the Run.
_Avoid_: HILT review, approval gate, sign-off

**Knowledge export**:
An optional sanitized summary of a completed Run written outside Weavekit's run artifacts for durable reuse when Source access level and Target project policy allow it.
_Avoid_: memory dump, transcript export

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
