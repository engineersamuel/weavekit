# Orchestration strategy question

Should WeaveKit's meta-orchestration layer be a **pre-planned, BAML-typed DAG workflow planner**
that emits a verifiable graph of harness calls up front, or an **agentic meta-harness loop** that
chooses the next harness/tool dynamically at each step?

Concretely, for a prompt like _"Choose and implement rich logging for my Python project acme"_,
WeaveKit may want to run a multi-stage workflow: deep research → Decision Council deliberates on
that research → Copilot SDK writes a plan → Decision Council reviews and refines the plan → Copilot
SDK implements → a visualizer renders a rich HTML artifact for human (HITL) review.

Two designs are on the table:

- **Option A — DAG planner.** A planner (implementable in BAML) emits a typed Directed Acyclic
  Graph of harness calls before execution. The whole workflow can be verified and tested at a top
  level; workflows become reusable, inspectable artifacts. Risk: a one-shot plan is only valid for
  the first prompt and may go stale as reality diverges.
- **Option B — Meta-harness loop.** A loop-based meta-harness that, at each step, asks "what should
  happen next" and selects the next harness/tool. Significantly easier to build and more flexible.
  Risk: it re-invents the inner harness loop, is harder to verify, and is non-deterministic.

The author explicitly does **not** want to re-invent the inner harness ("What should happen next"
in a raw loop). The intent is a loop-based **meta-harness orchestrating harnesses** — a harness on
top of a harness either way; the open question is whether to **pre-plan it as a verifiable DAG** or
**choose the next tool in a loop**.

Constraints:

- Keep the public interface small; reuse the existing Initial Router and re-plan concepts.
- Workflows must be verifiable/testable at a top level where possible (a stated benefit of Option A).
- Stay in-process and single-machine per Run (no durable work queue — see ADR 0001/0002).
- Strongly typed intermediate contracts via BAML.
- Langfuse/OpenTelemetry observability of the execution DAG.
- Human-in-the-loop is elicitation + a final visualized review, not an approval gate (ADR 0003).
- Extensibility: easy to add and manage multiple workflows.

Deliverable:

- Compare and contrast the two options with deep research and a pro/con + cost analysis.
- Emit a rich HTML report to help a human visualize and make the decision.

References:

- https://www.anthropic.com/engineering/building-effective-agents
- https://www.langchain.com/blog/planning-agents
- https://cognition.ai/blog/dont-build-multi-agents
- https://bair.berkeley.edu/blog/2024/02/18/compound-ai-systems/
