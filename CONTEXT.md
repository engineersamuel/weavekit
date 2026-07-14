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
A single isolated, single-machine execution of a workflow. It owns typed state, completes all work in-process, and may be explicitly resumed at node boundaries from its own canonical snapshot after interruption.
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
An Opportunity may also preserve optional, evidence-grounded rival explanations, a disconfirming or negative signal, and negative cases for downstream automation and review.
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

**Template candidate**:
A proposed reusable workflow template shape evaluated outside a live Run. A Template candidate may be compared against other candidates before the project adopts it as a source for future Runs.
_Avoid_: runtime continuation, run patch

**Static template**:
A reusable workflow entry point that can be invoked to create an initial DAG for a future Run. It may define fixed initial nodes and rules for later dynamic expansion.
_Avoid_: one-off run plan, generated run state

**Dynamic DAG expansion**:
The in-Run addition of workflow nodes after earlier nodes produce evidence or decisions that the Static template could not know upfront.
_Avoid_: static template generation, template optimization

**Incumbent template**:
The best Template candidate found so far during bounded self-improvement. A challenger may replace it only when the judge concludes that the challenger is a genuine improvement.
_Avoid_: current winner, global best

**Challenger template**:
A revised Template candidate generated from judge critique of the Incumbent template. It is discarded unless it improves on the incumbent under the same judging contract.
_Avoid_: retry, replan patch

**Template quality**:
The judged strength of a Template candidate's workflow structure and expected source-to-project reasoning outcome, independent of execution cost. Cost and risk may still be checked by later acceptance gates, but they do not determine whether a Challenger template replaces the Incumbent template.
_Avoid_: cost-adjusted score, cheapest template

**Adoptable template**:
A Template candidate that is structurally valid, improves across representative evaluation scenarios, and includes clear implementation touchpoints and tests. Adoption is a separate implementation step after offline optimization.
_Avoid_: auto-applied template, interesting idea

**Template judge**:
An LLM-backed judging step that grades Template candidates against explicit criteria and the workflow objective. It decides whether a Challenger template replaces the Incumbent template; deterministic workflow validation only decides whether a candidate is structurally admissible.
_Avoid_: verifier, acceptance gate

**Template optimizer**:
A bounded planner loop that improves reusable workflow templates outside live Runs. It may generate, judge, and replace Template candidates, but it does not execute a user's real-world workflow while searching.
_Avoid_: runtime planner, source analyzer, workflow executor

**Workflow grammar**:
The caller-supplied structural rules that define which workflow node kinds, harnesses, gates, and transitions are admissible for a generated or optimized plan. The Template optimizer consumes the grammar as a constraint instead of hard-coding today's allowed workflow entities.
_Avoid_: fixed node list, hidden DSL

**Actionable source-to-project outcome**:
The intended result of a Source-to-project workflow: a source-grounded, project-specific improvement path whose expected value justifies its cost, risk, and verification burden.
_Avoid_: best DAG, most complete plan

**Opportunity bundle**:
One or more tightly related Opportunities that are planned and implemented together because they share the same change surface and review story. A valid bundle has an explicit rationale, shared value, separation risk, and scope statement.
_Avoid_: batch, task group

**Advisory mode**:
A Run mode that produces analysis, ranked opportunities, plans, and a report without modifying the Target project.
_Avoid_: read-only mode

**Autonomous PR mode**:
A Run mode that may modify the Target project and prepare a review-ready pull request after opportunities and plans pass automated Verification gates. It never merges or self-approves the pull request.
_Avoid_: autonomous mode, auto-implement (too vague)

**Autonomous PR eligibility**:
The Source-to-project condition that allows an Opportunity or Opportunity bundle to proceed toward Autonomous PR mode: the mode is explicitly enabled and every included Opportunity has confidence of at least 0.95. Eligibility still requires worktree preparation, final recommendation review, and Verification gates before code changes are considered acceptable.
_Avoid_: auto-merge readiness, high score only

**Eligible autonomous PR candidate**:
An Opportunity or Opportunity bundle that satisfies Autonomous PR eligibility and may enter the Autonomous PR expansion path. In Autonomous PR mode, all eligible candidates may be pursued, not only the highest-ranked candidate.
_Avoid_: top pick only, winner

**Parallel autonomous worktrees**:
Separate Target project worktrees prepared for eligible autonomous PR candidates so candidate implementations can proceed independently. Worktree creation is controlled by configured local tooling rather than hard-coded Git commands.
_Avoid_: shared implementation worktree, sequential candidate implementation

**Worktree creation provider**:
The configured local command or integration responsible for creating Target project worktrees for Autonomous PR mode. It is read from Weavekit configuration so projects can use tools such as Herdr instead of Weavekit assuming a fixed worktree mechanism.
_Avoid_: hard-coded git worktree

**Final recommendation acceptance**:
An automated BAML review result that accepts a Source-to-project recommendation as actionable, project-improving, and worth its complexity. It is not a human approval or HITL gate.
_Avoid_: human sign-off, approval

**Worktree preparation**:
The required preflight that creates or selects an isolated Target project worktree, refreshes it from the configured mainline by rebasing, copies required environment files without recording their contents, and records the baseline before Autonomous PR mode may modify files.
_Avoid_: checkout setup, branch setup

**Workflow entity manifest**:
A file-backed, author-facing definition for a reusable workflow participant or contract, such as a Persona, Source-to-project Artifact contract, or Elicitation contract. It names metadata, prompts, model/harness policy, capability scope, and BAML contract references; BAML owns typed LLM schemas and TypeScript owns Run control flow.
_Avoid_: agent manifest, workflow DSL, entity registry

**Reasoning step**:
An individual LLM/BAML call inside a Run (persona, normalize, judge, re-plan). Recorded as a Langfuse span; never durable beyond the Run.
_Avoid_: action, task

**Harness call**:
A coarse invocation of an external agent or harness (e.g. `copilot -p <prompt>`) inside a Run. May fan out into many internal tool calls and produce an artifact, but is still one Reasoning step — not a unit of queued work.
_Avoid_: action

**Initial router**:
A lightweight front-door classifier that inspects an incoming prompt and chooses the next workflow (for example plan, research, decision council, elicitation, or direct handling) before the main harness starts.
_Avoid_: orchestrator, dispatcher (those are implementation choices, not the concept)

**Router workflow**:
A workflow that evaluates an incoming prompt and recommends how it should be handled across available harnesses, harness abilities, and Weavekit workflows. It may produce rewritten prompts and routing rationale, but it is advisory rather than the execution path itself.
_Avoid_: prompt handler, prompt analyzer

**Router reasoning**:
The single typed reasoning step in a Router workflow that classifies the prompt, ranks candidate handling paths, and produces the primary Route-specific prompt rewrite.
_Avoid_: multi-stage router, hidden deliberation

**Router dashboard**:
The UI surface for reviewing Router workflow outputs, including the primary Next action recommendation, alternatives, Route-specific prompt rewrite, and manual Create Worktree action when handoff requirements are satisfied.
_Avoid_: prompt router page, hidden launcher

**Next action recommendation**:
The primary output of a Router workflow: the recommended immediate handling path for the user's prompt, including the target harness, ability, workflow, model, and handoff shape when applicable.
_Avoid_: advice, suggestion

**Prompt route score**:
The evidence-backed score for a candidate handling path, based on task fit, context availability, mutation risk, parallelizability, automation or handoff fit, model specialty, and Routing preference overlay match.
_Avoid_: confidence only, vibe check

**Router eval corpus**:
A representative set of prompts used to validate the Router workflow across the full Route taxonomy. V1 success requires expected primary routes, plausible harness/model/ability recommendations, primary Route-specific prompt rewrites, and Create Worktree eligibility only when handoff requirements are complete.
_Avoid_: smoke prompt, manual-only check

**Route-specific prompt rewrite**:
A harness-native rewrite of the incoming prompt for the selected Next action recommendation, such as a goal prompt, fleet prompt, command-line harness prompt, or Herdr handoff prompt.
_Avoid_: polished prompt, generic rewrite

**Capability catalog**:
A modifiable knowledge base of harnesses, harness abilities, workflows, models, and known-good task fits that the Router workflow uses as evidence for recommendations.
_Avoid_: static docs dump, tool list

**Routing preference overlay**:
User- or project-specific guidance layered over the Capability catalog, used to encode known personal preferences such as preferred models, harnesses, worktree handoff behavior, and task-specific routing taste. Overlay entries are weighted preferences by default and become hard requirements only when explicitly forced.
_Avoid_: personal flavor, hidden defaults

**Capability configuration**:
The typed Weavekit configuration surface that owns Capability catalog entries and Routing preference overlays. It is the source of truth for known-good harness, ability, model, workflow, and handoff fits.
_Avoid_: generated catalog, entity manifest

**Capability refresh**:
An explicit maintenance path that researches current harness, ability, model, and workflow documentation and proposes cited updates to Capability configuration. It is separate from per-prompt recommendation so normal advisory runs stay fast and deterministic, and its output requires manual apply before changing routing behavior.
_Avoid_: live lookup, background docs scrape

**Route taxonomy**:
The stable set of prompt handling categories that a Router workflow classifies into before ranking catalog-backed harnesses, abilities, workflows, models, and handoffs. The v1 taxonomy is direct-answer, refine-prompt, goal-prompt, plan, grill-with-docs, research, local-code-change, fleet-parallel, remote-delegate-pr, decision-council, source-to-project, and manual-herdr-worktree.
_Avoid_: freeform route labels, ad hoc categories

**Ambiguity resolution route**:
The Route taxonomy category for prompts that lack enough context to recommend a safe next action. Its preferred handling is a grill-with-docs intake session that sharpens requirements, domain language, and decisions before another recommendation is made.
_Avoid_: generic clarification, assumption-only fallback

**Prompt handoff execution**:
A manual Router workflow follow-on action that performs the recommended local handoff, such as creating a worktree and starting a selected harness, only after the user chooses the Create Worktree control. It is separate from advisory output so prompt evaluation remains read-only by default.
_Avoid_: auto-run, implicit launch, automatic handoff

**Prompt handoff requirements**:
The minimum data required before Prompt handoff execution can create a worktree and start a harness: target project, branch or worktree name, chosen harness or agent, and Route-specific prompt rewrite. Defaults may come from Capability configuration only when unambiguous.
_Avoid_: best-effort launch, inferred everything

**Route decision**:
The typed output of the Initial router: the selected route plus the scores and rationale that explain why it was chosen.
_Avoid_: routing policy (that is the implementation strategy, not the domain object)

**Verification gate**:
An automated check (types, lint, unit, eval, schema) interleaved with generation that must pass before a Run proceeds. Its control flow lives in code. The human as a _checkpoint on the council's output_ (approval / sign-off) is eliminated and replaced by these automated checks.
_Avoid_: human approval gate, sign-off — and do not confuse with Elicitation, which is a distinct, sanctioned concept.

**Promotion decision**:
A human choice at a Run boundary that selects whether a completed recommendation should remain advisory or trigger a follow-on mode such as planning, implementation, or pull-request creation. It is not a Verification gate inside the Run.
_Avoid_: HILT review, approval gate, sign-off

**Knowledge export**:
An optional sanitized summary of a completed Run written outside Weavekit's run artifacts for durable reuse when Source access level and Target project policy allow it.
_Avoid_: memory dump, transcript export

**Elicitation**:
The human as a _source of input_ — supplying requirements or decisions a Run cannot infer — via an Intake interview (front door) or Clarifying questions (in-loop). Sanctioned and deliberately distinct from a Verification gate (the human as a checkpoint on output, which is eliminated). Elicitation never blocks a Run indefinitely: the human may skip or time out, the Run completes with the question recorded as unanswered, and it is enabled or disabled per run.
_Avoid_: approval, sign-off (those are Verification gates, which weavekit eliminates)

**Clarifying question**:
A typed question a Reasoning step emits _as data_ (a step flags that human input is needed and emits a list of questions); the orchestrator decides whether to surface it, and the human may answer or skip. Declarative, in-loop Elicitation. The BAML step emits the question; the orchestrator asks — BAML never asks the human itself.
_Avoid_: ask_user (that is the agentic mechanism, used only at intake)

**Intake interview**:
An agentic, open-ended interview that sharpens an ambiguous request _before_ a Run, driven by a harness session's own ask_user tool (e.g. the grill-me skill) and distilled into typed Council input. Bounded to the front door; the only place weavekit uses agentic ask_user.
_Avoid_: clarifying question (that is the in-loop, declarative form)

**Work item (Bead)**:
A durable, independently-schedulable unit of work with status and typed dependencies, living in an external queue (Beads). Weavekit produces none — see Decisions.
_Avoid_: ticket, issue, task (inside a Run)

## Decisions

- **Beads (durable work queue) — extensively evaluated and deliberately rejected.** Weavekit does not use Beads, or any durable work queue, for workflow orchestration. Workflows are isolated single-machine Runs that complete all work in-process; there is no second actor, independently schedulable work, or cross-run backlog to coordinate. Dynamic action graphs are orchestrated in-process, Langfuse captures the execution DAG, and verification is in-process gated checks plus CI. See [ADR 0001](docs/adr/0001-no-durable-work-queue.md).
- **Durable Run snapshots — accepted.** A macro-workflow Run writes versioned state atomically to `runs/<run-id>/workflow-state.json` and may be explicitly resumed with `workflow run --resume <run-id>`. Passed/skipped nodes stay completed; interrupted work runs again in the same in-process scheduler. This is node-boundary recovery, not a queue, background worker, or mid-harness continuation. See [ADR 0007](docs/adr/0007-durable-run-state-resume.md).
- **Rivet (durable actor runtime) — evaluated and deferred.** Rivet has the strongest orchestration control-flow DSL of the options (steps, join/race, rollback, durable HITL, replay), but adopting it would reverse ADR 0001 (it reintroduces a second actor, work outliving the process, and human gates) and is inert for in-process Runs. Keep in-process Runs; bank control-flow wins in-process (fan-out/fan-in, in-process compensation, a thin auto-approve `HumanDecision` seam). Rivet is the named candidate — over Flue — only if the reopen triggers fire. See [ADR 0002](docs/adr/0002-defer-rivet-keep-in-process-runs.md).
- **Human-in-the-loop split — elicitation is sanctioned, verification/approval gates are not.** Weavekit may _elicit_ input it cannot infer (an agentic Intake interview at the front door, and declarative in-loop Clarifying questions emitted by BAML and surfaced by the orchestrator), but does not reintroduce human _verification/approval_ gates on the council's output (still eliminated per ADR 0001). Elicitation is in-process, per-run toggleable, and never blocks a Run: the human may skip/time out (unanswered recorded), and answers may instead be supplied by an automated resolver reading project context/goals, so a Run can be fully unattended. BAML emits questions as data; the orchestrator asks. See [ADR 0003](docs/adr/0003-elicitation-vs-verification-gates.md).
- **Agent Loop policy — accepted as recommended defaults, not hard requirements.** In-repository automation uses bounded triggers, comparable rounds, repeatable proof-based checks, in-Run ledger state, explicit stop rules, and green/yellow/red authorization boundaries. See [ADR 0007](docs/adr/0007-agent-loop-policy.md).
