# 0003 — Elicitation is sanctioned; verification/approval gates stay eliminated

Status: accepted

Weavekit is adding human-in-the-loop questions: an optional intake interview that sharpens an
ambiguous request before a Run, and optional in-loop clarifying questions during a Run. On its
face this conflicts with ADR 0001 and the glossary, which eliminate human gates in favour of
automated verification. The conflict dissolves once two different roles for the human are
separated.

- **Verification/approval gate** — the human as a _checkpoint on the council's output_ ("approve
  this before it proceeds/ships"). This is what ADR 0001's verifier thesis eliminates, replacing
  it with automated checks (types, lint, eval, schema) plus CI.
- **Elicitation** — the human as a _source of input the model cannot infer_ (requirements,
  preferences, decisions). This is not a checkpoint on the machine's work; it feeds the machine.

Decision: elicitation is sanctioned; verification/approval gates remain eliminated.

## Two elicitation mechanisms, by paradigm and phase

1. **Declarative, in-loop (default).** A BAML reasoning step (e.g. the round assessment) emits, as
   typed data, a flag that human input is needed plus a list of clarifying questions. The
   orchestrator decides whether to surface them and collects answers through the in-process
   elicitation port (e.g. a Telegram channel), folding answers back into Run state for the next
   step. BAML never asks the human itself — it is a pure typed function and cannot block for
   input; it emits questions as data and the orchestrator asks.
2. **Agentic, front door only.** A harness session (Copilot SDK) running an interview skill such
   as grill-me uses its own `ask_user` tool, surfaced to the human over the same channel via the
   SDK's `onUserInputRequest` handler. Its transcript is distilled by BAML into typed Council
   input. This is the only place weavekit uses agentic `ask_user`, because it is the only place
   that needs open-ended, adaptive, unbounded questioning.

## "Optional" is layered

- The model may emit no questions (the common case; elicitation adds nothing).
- The human may skip or time out; the Run still completes, recording the question as unanswered.
  This preserves ADR 0001's invariant that a Run completes all of its work in-process.
- A per-run flag enables or disables elicitation entirely; disabled is today's fully-automated Run.

## Answer source: human or automated resolver

An elicitation answer may be supplied by a **human** (interactive — Telegram or CLI) or by an
**automated resolver** that reads project context/goals (e.g. `CONTEXT.md`) and answers the
question via a BAML call. The source is selected per run, so the same question contract powers
both attended runs and fully unattended automation. The automated resolver abstains when the
document does not cover a question, falling back to a human or to "unanswered" per the run's
configured precedence. See ADR 0004 for the resolver and its CLI surface.

## Boundary with ADR 0001 / 0002

Elicitation stays in-process. In-loop clarifying questions pause at a clean orchestration
boundary (between BAML steps), so they are snapshot-friendly and trip only the in-process
elicitation axis, not durable execution or a second actor. The agentic intake interview holds a
live harness subprocess for its duration, which is acceptable because an interview is inherently
interactive and bounded to before the Run. Durable, out-of-band elicitation that must survive a
process restart — or durably resuming a persona's mid-turn `ask_user` — would reopen ADR 0001 and
ADR 0002 (Rivet territory) and is out of scope here.

ADR 0007 permits a macro-workflow Run to resume from a completed node-boundary snapshot. It does
not resume a live harness turn or an outstanding `ask_user`; those mid-interaction cases remain out
of scope under this decision.

## Considered options

1. **Distinguish elicitation from verification gates — chosen.** Lets weavekit gather missing
   human input without reintroducing the approval checkpoints the verifier thesis removes.
2. **Treat all human-in-the-loop as prohibited — rejected.** Conflates supplying input with
   approving output; it would block legitimate requirements gathering for no real benefit.
3. **Make agentic `ask_user` the general HITL mechanism — rejected.** It is unbounded, inverts
   control to the agent, holds a live subprocess for the whole wait, and cannot be durably
   resumed mid-turn. Reserve it for the bounded intake interview.
4. **Put the questions "inside BAML" — rejected (impossible).** BAML is a pure typed function over
   one model call; it cannot block for human input. It emits questions as data; the orchestrator
   performs the asking.

## Consequences

The glossary gains Elicitation, Clarifying question, and Intake interview, and the Verification
gate term points at the distinction. A BAML step (the assessment or a sibling) gains a
needs-human-input flag plus a typed questions list; the in-process loop gains an elicitation gate
with skip/timeout handling and a per-run enable flag; an optional front-door intake interview
(grill-me → BAML distill) produces typed Council input. Elicitation answers may come from a human
or an automated context/goals resolver (ADR 0004). No durable engine is added. Revisit ADR 0001
and ADR 0002 only if elicitation must survive process restarts.
