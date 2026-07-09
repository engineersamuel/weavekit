# 0004 — Elicitation answer source: human, automated context/goals resolver, or skip

Status: accepted

Builds on [ADR 0003](0003-elicitation-vs-verification-gates.md), which sanctions elicitation
(the human as a source of input). Every clarifying question still needs an answer, and the
_source_ of that answer should be selectable per run so a Run can be attended (a human answers),
fully unattended (project context/goals answer), or strictly non-interactive (no answering at
all). The goal is to automate decision making — let the council resolve its own clarifying
questions against documented goals without a human present — while never reintroducing a hard
human gate.

## Decision

A single `ElicitationSource` port with a **configurable precedence chain: context → human →
skip**. Each tier may answer or defer to the next:

1. **ContextSource (automated)** — a BAML reasoning step that reads project context/goals
   (default `CONTEXT.md`) and answers each clarifying question, **abstaining** below a confidence
   threshold. Abstention falls through to the next tier.
2. **HumanSource (attended)** — surfaces the question over the in-process elicitation channel
   (Telegram or CLI) per ADR 0003. A skip or timeout falls through.
3. **SkipSource (terminal)** — records the question as `unanswered`; the Run proceeds and still
   completes (ADR 0001 invariant).

Named modes are presets over this chain:

| Mode            | Chain                  | Use                            |
| --------------- | ---------------------- | ------------------------------ |
| `off` (default) | skip                   | today's fully-automated Run    |
| `human`         | human → skip           | attended                       |
| `auto`          | context → skip         | unattended automation          |
| `auto+human`    | context → human → skip | unattended with human fallback |

## CLI surface

```
--elicit <off|human|auto|auto+human>   default: off
--elicit-context <path...>             default: CONTEXT.md
--elicit-channel <telegram|cli>        default: cli
--elicit-min-confidence <0..1>         default: 0.6
```

`--elicit auto --elicit-context CONTEXT.md` runs the council unattended, resolving its own
clarifying questions against the project's documented goals.

## Provenance

Every answer records `answeredBy` (`context` | `human` | `unanswered`), the confidence, and a
short rationale into Run state, the Langfuse trace, and the report, so an automated decision is
auditable after the fact.

## Considered options

1. **Configurable precedence chain (context → human → skip) — chosen.** One mechanism subsumes
   attended, unattended, and hybrid runs, and degrades safely to `unanswered` so Runs always
   complete.
2. **Context-only automation with no human tier — rejected as the sole design.** It is a preset
   (`auto`) of the chain, not a separate mechanism.
3. **Load the doc as standing context only, no resolver — rejected as insufficient.** Feeding the
   doc into run context reduces but does not _answer_ questions. Still allowed as an orthogonal
   convenience (`--elicit-context` may also be appended to run context).
4. **Human-only — rejected as the default.** Keeps every Run attended, defeating the automation
   goal; available as the `human` preset.

## Boundary with ADR 0001 / 0002 / 0003

`ContextSource` is in-process BAML — a Reasoning step at a clean orchestration boundary,
snapshot-friendly, no durable engine and no second actor. The human tier reuses the in-process
elicitation port from ADR 0003. Nothing here reopens ADR 0001 or 0002.

## Consequences

A new `ElicitationSource` abstraction (`HumanSource`, `ContextSource`, `SkipSource`) composed by
precedence; a new BAML function `answerClarifyingQuestion(question, projectContext) ->
ResolvedAnswer { answer?, confidence, abstained, rationale }`; CLI flags `--elicit`,
`--elicit-context`, `--elicit-channel`, `--elicit-min-confidence`; answer provenance recorded in
run state, Langfuse, and the report. The default `--elicit off` preserves current fully-automated
behaviour.
