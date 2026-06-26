# PI + BAML vs Flueframework for WeaveKit Orchestration

Date: 2026-06-25

Research deciding whether WeaveKit could do **all** of its workflow / agent-harness
orchestration on **PI** (`earendil-works/pi`) **+ BAML**, or whether **Flue**
(flueframework.com) still makes sense. Companion to
[`2026-06-25-jetstream-vs-flueframework-async-connectors.md`](./2026-06-25-jetstream-vs-flueframework-async-connectors.md),
which reaches the same "PI is part of the Flue stack" reframing from the connector angle.

## TL;DR

**Keep Flue + BAML.** The question is a false dichotomy: **Flue is built _on top of_ PI**,
so WeaveKit already ships PI today (transitively, under `@flue/runtime`). The real choice is
"**bare PI + a hand-rolled production layer + BAML**" vs "**Flue (PI inside) + BAML**" — and
**BAML stays either way**. The capabilities WeaveKit's design brief calls for
(observability, external connections/notifications, managing multiple workflows) are exactly
the production layer Flue adds and bare PI lacks. Drop to PI + BAML only if scope shrinks to a
single, local, in-process agent.

## The key reframing: Flue is a framework on top of the PI harness

This is not "A or B." It is one stack with two entry points:

- **`@flue/runtime@1.0.0-beta.6`** depends **directly** on `@earendil-works/pi-agent-core`
  and `@earendil-works/pi-ai`. Verified two ways: `npm view @flue/runtime dependencies`
  **and** this repo's own `package-lock.json` (lines ~1169-1170, resolving
  `@earendil-works/pi-agent-core@0.79.10` + `@earendil-works/pi-ai@0.79.10`).
- Flue's own marketing confirms it: *"Powered by Pi, the open agent harness."*
- So **"PI" = the low-level harness** (agent loop, multi-provider model API, sessions);
  **"Flue" = the batteries-included framework** wrapping it (durability, HTTP, channels,
  deploy, SDK, observability).

**BAML is orthogonal to both.** BAML owns the *single typed LLM call*; PI/Flue own the
*orchestration around many calls*. BAML is not an alternative to Flue — it complements it,
and is in fact stronger than Flue's native structured outputs (see below). WeaveKit already
runs **Flue + BAML** together for this reason.

## Who owns which layer

| Layer | Tool | Owns | Does **not** own |
|---|---|---|---|
| Typed model call | **BAML** (`@boundaryml/baml`) | Prompt-as-typed-function, Schema-Aligned Parsing, retries/fallbacks, streaming partials, multi-lang codegen | Multi-step orchestration, durability, serving — "an agent is a while loop in your host language" |
| Agent harness | **PI** (`earendil-works/pi`) | Agent loop, ~30-provider model API (4 wire protocols), tool-calling (TypeBox), sessions/compaction, steering/HITL, parallel tools | Structured-output DSL, durable execution, HTTP server, channels, OTel, multi-workflow registry, MCP-in-core, sub-agents, permissions |
| Production framework | **Flue** (`withastro/flue`) | Everything in PI **plus** durable/resumable execution, persistence adapters, Hono routing/auth, `defineWorkflow`/`defineAgent`, channels, deploy targets, client SDK + React, MCP client, CLI, observability adapters | Constrained-decoding structured outputs (uses valibot + retries — weaker than BAML), multi-node Node.js scaling (yet), native HITL/scheduler/eval engine |

## Side-by-side for the orchestration decision

| | **Bare PI + BAML** | **Flue + BAML** (current) |
|---|---|---|
| **Typed outputs / BAML intermediate** | ✅ BAML (best-in-class) | ✅ BAML (best-in-class) |
| **Agent loop, tools, multi-provider** | ✅ PI | ✅ PI (inside Flue) |
| **Fan-out/fan-in (council rounds)** | App-level (already hand-rolled in `workflow.ts`) | App-level (same) |
| **Observability (OTel)** | ❌ none in PI — build it yourself | ✅ `@flue/opentelemetry` / OTel + Braintrust + Sentry adapters |
| **External connections / notifications** | ❌ build HTTP + webhook verify + dispatch | ✅ Channels (Slack/GitHub/Teams/Linear/Stripe…) + routing + schedules |
| **Create + manage multiple workflows** | ❌ build a registry/runner | ✅ `defineWorkflow`/`defineAgent` + file discovery + run records + SDK |
| **Durability / crash recovery** | ❌ JSONL transcripts only; no resumable execution | ✅ Durable Streams + persistence adapters (single-node on Node today) |
| **Deploy targets** | Embed the library yourself | ✅ Node / Cloudflare / CI / Vercel / Fly / Render |
| **Maturity** | MIT, ~v0.80.x, **fast breaking churn** (multiple releases/day) | Apache-2.0, **1.0-beta.6**, beta but more stable surface |
| **GitHub Copilot personas** | `@github/copilot-sdk` (orthogonal); PI has a Copilot provider | same |

## Mapping to WeaveKit's design brief (`examples/design-question.md`)

The constraints split cleanly into "app-level" (neither framework matters) and
"framework-level" (where PI vs Flue is decided):

- **App-level, already satisfied in WeaveKit code, framework-agnostic:** small public
  interface (`runCouncil()`), Markdown + JSON artifacts (`artifacts.ts`), stop in ≤3 rounds
  (`runCouncilLoop`), strongly typed outputs + BAML intermediate (`bamlAdapters.ts`).
- **Framework-level — the deciders, all on Flue's added layer, all absent from bare PI:**
  - **Observability** — Flue OTel adapters; PI has zero OTel.
  - **Ability to receive/process external connections + notifications** — Flue Channels +
    routing + schedules; bare PI has no HTTP/ingress (its `pi-chat` sibling is separate and
    limited).
  - **Easily create + manage multiple workflows** — Flue `defineWorkflow` + discovery + run
    records + SDK; bare PI is a single in-process agent loop with no workflow registry.

**Conclusion:** PI + BAML would force re-implementing precisely the three brief requirements
that distinguish a framework from a library — which is the entire reason Flue exists on PI.

## Recommendation by scope

### 1. WeaveKit as specified (most likely): keep Flue + BAML

WeaveKit's brief explicitly wants observability, external connections/notifications, and
multi-workflow management — Flue's production layer. Today the coupling is **thin** (only the
`createCouncilWorkflow` seam + planned `@flue/opentelemetry`), and the council loop is
hand-rolled TypeScript, so switching *cost* is low — but the *requirements* pull toward
Flue's layer as the project grows. Keep BAML for the typed fan-in contracts (it is stronger
than Flue's valibot + retries). **Net: Flue (PI inside) + BAML is the coherent stack.**

### 2. Minimalist single-agent CLI/library: PI + BAML, hand-roll the rest

Choose bare PI + BAML only if you deliberately shrink scope to one local, in-process
agent/CLI with **no** triggers/webhooks, **no** multi-workflow management, and **no**
deploy/durability — and you want PI's total-control, context-engineering-first minimalism.
Then PI + BAML is lighter and you own everything. You also accept rebuilding observability
yourself and tracking PI's faster breaking-change cadence.

## Maturity caveat

- **PI** (`earendil-works/pi`, Mario Zechner / "badlogic", MIT) is feature-mature and used in
  production by its author, but **pre-1.0 with frequent breaking changes** (often multiple
  releases per day through 0.80.x). Dropping to bare PI **increases** churn exposure.
- **Flue** (`withastro/flue`, Astro team / Fred K. Schott, Apache-2.0) is **1.0 Beta** with
  partially AI-generated docs "awaiting review"; **Node.js durability is single-node / opt-in
  today** (multi-node planned pre-1.0; strongest story on Cloudflare Durable Objects).
- **BAML** (`@boundaryml/baml`, pinned `0.220.0` here) is the most stable of the three and is
  the part of the stack least at risk regardless of the orchestration choice.

## Sources

- Flue: <https://flueframework.com/> ·
  [Concepts: Agents](https://flueframework.com/docs/concepts/agents/) ·
  [Durable Execution](https://flueframework.com/docs/concepts/durable-execution/) ·
  [Workflows](https://flueframework.com/docs/guide/workflows/) ·
  [Routing](https://flueframework.com/docs/guide/routing/) ·
  [1.0 Beta blog](https://flueframework.com/blog/flue-1-0-beta/) ·
  [`withastro/flue`](https://github.com/withastro/flue)
- PI: <https://pi.dev/> · [`earendil-works/pi`](https://github.com/earendil-works/pi) ·
  `pi-ai` and `pi-agent-core` package READMEs ·
  [Mario Zechner design blog](https://mariozechner.at/posts/2025-11-30-pi-coding-agent)
- BAML: <https://docs.boundaryml.com/> ·
  [What is BAML](https://docs.boundaryml.com/guide/introduction/what-is-baml) ·
  [`BoundaryML/baml`](https://github.com/BoundaryML/baml)
- Dependency verification: `npm view @flue/runtime dependencies` (shows
  `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`) and this repo's
  `package-lock.json` (`@flue/runtime` → same Pi packages).
- WeaveKit ground truth: `package.json` (`@flue/runtime`, `@boundaryml/baml`,
  `@github/copilot-sdk`), `src/decision-council/workflow.ts` (hand-rolled loop + Flue seam),
  `src/decision-council/bamlAdapters.ts` (BAML contracts), `examples/design-question.md`.
