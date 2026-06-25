# Client Router: Per-Call Model + Effort Selection for BAML and Copilot SDK

Date: 2026-06-25
Status: Research (handoff to planning)
Topic: A fast "intent router" that chooses the right **model** and **reasoning effort**
for each BAML function call and each Copilot SDK session call, with a **sub-5-second**
routing decision.

## TL;DR

- **The plumbing already exists.** BAML lets you override the client per call by name
  (`b.Fn(args, { client: "CopilotProxyGpt5Mini" })`) or fully customize a client at
  runtime (`ClientRegistry.addLlmClient(name, provider, { model, reasoning_effort, ... })`
  + `setPrimary`). The Copilot SDK takes `model` **and** a first-class
  `reasoningEffort: "low" | "medium" | "high" | "xhigh"` in `createSession(...)`. No
  forking or low-level work is needed — routing is a thin layer that *selects* these
  values and passes them in.
- **The router model must be NON-reasoning (or minimum effort).** The single biggest
  latency trap: for reasoning models, time-to-first-token (TTFT) includes "thinking"
  time. GPT-5 mini at `high` effort measures **61–79 s** TTFT; Claude Haiku 4.5 in
  **non-reasoning** mode measures **~0.7 s**. A router that itself thinks will blow the
  5 s budget.
- **Recommended router client: `CopilotProxyClaudeHaiku45`** (claude-haiku-4-5,
  non-reasoning) — sub-second TTFT, ~95–120 tok/s, enough intelligence to classify.
  Backups: `CopilotProxyGrokCodeFast1` (speed/cost-tuned) and
  `CopilotProxyGemini3FlashPreview` (highest raw throughput). All three already exist in
  `baml_src/clients.baml`.
- **Recommended architecture: hybrid.** A deterministic policy table covers the known
  internal call sites instantly; a fast-LLM `RouteModelCall` BAML function handles
  dynamic/ambiguous intent, guarded by an `AbortSignal` hard timeout (~3.5 s) that falls
  back to the policy default. This guarantees < 5 s and keeps known calls deterministic.
- **Two caveats to verify in planning:** (1) every model here is reached through the
  **local Copilot proxy at `127.0.0.1:8080`**, not the public API, so the published
  TTFT/TPS numbers below are *relative* guidance — confirm with a local micro-benchmark;
  (2) the `safe-gale` branch is **mid-rename and does not currently build** — establish a
  green baseline before layering the router.

---

## 1. Goal (from the request)

> Implement a client router so the correct model and effort can be chosen for the
> specific BAML call or Copilot SDK model call. The intent router itself must be very
> fast — choose a client in `clients.baml` with fast time-to-first-token and very high
> tokens-per-second. Target a **sub-5-second** routing decision, then use the chosen
> model accordingly.

Two distinct concerns:

1. **Which fast model runs the router itself?** (latency-critical; answered in §5)
2. **How does the router apply its decision to a BAML call vs a Copilot SDK call?**
   (answered in §3–§4, §7)

---

## 2. Current architecture — the call sites that need routing

### 2.1 BAML calls (all currently pinned to `DefaultClient`)

`baml_src/council.baml` defines three functions, each hardcoded to `client DefaultClient`:

| Function | Job | Natural model tier |
| --- | --- | --- |
| `NormalizePersonaCritique` | Structured extraction of one persona's text into a schema | Fast / cheap, low effort |
| `AssessCouncilRound` (Judge) | Decide continue/stop from the round's critiques | Mid reasoning |
| `CreateCouncilReport` | Synthesize the final decision-ready report + Markdown | Strong model, higher effort |

They are invoked in `src/decision-council/bamlAdapters.ts` via the generated client `b`:

```ts
// src/decision-council/bamlAdapters.ts (today)
const result = await b.NormalizePersonaCritique({ personaId: raw.personaId, text: raw.text });
const result = await b.AssessCouncilRound(args.roundNumber, args.critiques, args.failures);
const result = await b.CreateCouncilReport(args.critiques, args.assessments, args.failures);
```

`DefaultClient` reads `env.BAML_MODEL` / `env.COPILOT_PROXY_BASE_URL` / `env.COPILOT_PROXY_API_KEY`
(`baml_src/clients.baml:9-16`). Everything else in `clients.baml` is a fixed
`CopilotProxy*` client hardcoded to `http://127.0.0.1:8080/v1` with a fixed `model`.

### 2.2 Copilot SDK calls (persona workers, hardcoded `claude-sonnet-4.5`)

`src/decision-council/personaWorker.ts` runs each debating persona through the Copilot
SDK. The model is a constructor default and is the same for every persona/round:

```ts
// src/decision-council/personaWorker.ts:126, 140-152
this.model = args.model ?? "claude-sonnet-4.5";
...
const session = await client.createSession({
  model: this.model,
  agent: persona.id,
  customAgents: [{ name: persona.id, displayName: persona.name, description: persona.description, prompt: persona.prompt }],
  onPermissionRequest: this.onPermissionRequest,
});
const response = await session.sendAndWait({ prompt: buildPersonaPrompt(persona, brief) }, this.timeoutMs);
```

There is **no per-persona model/effort selection today** — `runner.ts` constructs one
`new CopilotPersonaWorker()` for all personas (`src/decision-council/runner.ts:33`).

### 2.3 The model catalog (`baml_src/clients.baml`)

~45 `CopilotProxy*` clients are already defined, all pointing at the local proxy. The
fast-tier candidates relevant to the **router model** decision:

| Client name (clients.baml) | Model id | Class |
| --- | --- | --- |
| `CopilotProxyClaudeHaiku45` | `claude-haiku-4-5` | Anthropic Haiku (fast) |
| `CopilotProxyClaude35Haiku` | `claude-3-5-haiku` | Anthropic Haiku (older, fast) |
| `CopilotProxyGrokCodeFast1` | `grok-code-fast-1` | xAI speed-tuned coder |
| `CopilotProxyGemini3FlashPreview` | `gemini-3-flash-preview` | Google Flash |
| `CopilotProxyGpt5Mini` | `gpt-5-mini` | OpenAI mini (reasoning) |
| `CopilotProxyRaptorMini` | `raptor-mini` | MS fine-tuned GPT-5 mini |

Stronger tiers also available for the *target* of routing: `CopilotProxyClaudeSonnet46`,
`CopilotProxyClaudeOpus48`, `CopilotProxyGpt55`, `CopilotProxyGpt53Codex`,
`CopilotProxyGemini3ProPreview`, etc.

---

## 3. How BAML supports runtime client + effort selection (verified)

The generated client already exposes everything needed. Every function takes a trailing
`__baml_options__` (`src/generated/baml_client/async_client.ts:100-102, 212-214`) and the
generated body resolves it:

```ts
// src/generated/baml_client/async_client.ts:129-134
// Resolve client option to clientRegistry (client takes precedence)
let __clientRegistry__ = __options__.clientRegistry;
if (__options__.client) {
  __clientRegistry__ = __clientRegistry__ || new ClientRegistry();
  __clientRegistry__.setPrimary(__options__.client);
}
```

`BamlCallOptions` includes `client?: string`, `clientRegistry?: ClientRegistry`, `tb`,
`collector`, `env`, `tags`, and `signal?: AbortSignal`
(`src/generated/baml_client/async_client.ts:42-52`).

Two ways to route:

**(a) Override by client name — pick an existing `clients.baml` client (no effort change):**

```ts
const critique = await b.NormalizePersonaCritique(
  { personaId, text },
  { client: "CopilotProxyGrokCodeFast1" },   // any client name, or "openai/gpt-5-mini" shorthand
);
```

**(b) Dynamic client — also set model/effort/params at runtime:**

```ts
import { ClientRegistry } from "@boundaryml/baml";

const cr = new ClientRegistry();
cr.addLlmClient("RoutedReport", "openai-generic", {
  base_url: "http://127.0.0.1:8080/v1",
  api_key: process.env.COPILOT_PROXY_API_KEY,
  model: "gpt-5.5",
  reasoning_effort: "high",            // passthrough option (see caveat §8)
});
cr.setPrimary("RoutedReport");
const report = await b.CreateCouncilReport(critiques, assessments, failures, { clientRegistry: cr });
```

`client` takes precedence over `clientRegistry` if both are supplied. `b.withOptions({ client })`
applies a default client across many calls. (Sources: BAML docs — client-option,
client-registry, with_options; native `ClientRegistry.addLlmClient(name, provider, options)`.)

**Implication:** effort control on the BAML path = use a `ClientRegistry` dynamic client
with a `reasoning_effort` option (passthrough), *or* pre-declare effort-specific clients
in `clients.baml`. The simple `{ client: name }` form only swaps the model, not effort.

---

## 4. How the Copilot SDK supports model + effort selection (verified)

The SDK has **first-class effort support** — no passthrough hacks required.
`createSession(config)` accepts:

- `model?: string` — e.g. `"gpt-5"`, `"claude-sonnet-4.5"`. **Required** when using a
  custom provider.
- `reasoningEffort?: "low" | "medium" | "high" | "xhigh"` — "Reasoning effort level for
  models that support it. Use `listModels()` to check which models support this option."

```ts
const session = await client.createSession({
  model: decision.model,                 // routed
  reasoningEffort: decision.reasoningEffort, // routed (omit for non-reasoning models)
  agent: persona.id,
  customAgents: [...],
  onPermissionRequest,
});
```

`client.listModels()` (and the `onListModels` hook) enumerate the models actually
available at runtime and which support `reasoningEffort` — the router should call this
once at startup to (1) constrain choices to what's installed and (2) know where effort is
valid. (Source: `@github/copilot-sdk` README — `createSession` config and `listModels`.)

**Implication:** the Copilot persona path can route both model and effort cleanly; the
only change is threading routed values into `CopilotPersonaWorker`.

---

## 5. Choosing the router model (the latency-critical decision)

### 5.1 The decisive constraint: avoid "thinking" before the answer

Artificial Analysis (AA) and others define TTFT as *seconds to first token after the
request is sent*, and **for reasoning models this includes the model's thinking time.**
That single fact dominates the router-model choice:

| Candidate | Mode | Output speed (tok/s) | TTFT | Notes |
| --- | --- | --- | --- | --- |
| **claude-haiku-4-5** | **non-reasoning** | ~94–123 | **~0.5–0.84 s** | Best TTFT; "fastest, most efficient" Anthropic model |
| claude-haiku-4-5 | reasoning | ~110–133 | 14–17 s | Effort kills TTFT — do **not** use for router |
| claude-3-5-haiku | non-reasoning | ~45–65 | sub-second | Older, lower TPS; viable fallback |
| **grok-code-fast-1** | speed-tuned | ~92–195 (src-dependent) | 3.65–7.48 s @10k in | Cheap, agentic, strong structured output; TTFT figures are at 10k input |
| **gemini-3-flash-preview** | non-reasoning | **~163** | 1.42 s (provider) / 34.8 s (model-page @10k) | Highest raw TPS; TTFT inconsistent across sources — verify |
| gemini-3-flash-preview | reasoning | ~174–185 | 7.36 s | Avoid for router |
| gpt-5-mini | high effort | ~95–115 | **61–79 s** | Reasoning — unusable as router at high effort |
| gpt-5-mini | medium effort | ~90–100 | 13–17 s | Still too slow for a router |
| gpt-5-mini | low/minimal | ~72–180 | ~0.15–1 s (cited) | Only acceptable if effort forced to minimum |
| raptor-mini | fine-tuned GPT-5 mini | (fast completions) | low (unverified) | GA, "fast accurate inline suggestions/explanations"; verify JSON + latency |

Numbers are public-API measurements (AA, OpenRouter, xAI, vendor docs) and are **relative
guidance only** — see §8 proxy caveat.

### 5.2 Why TTFT matters more than TPS *for a router*

The router output is tiny — a small JSON like `{ clientName, model, reasoningEffort }`,
~30–50 tokens. At ~100 tok/s that is ~0.3–0.5 s of generation. So:

```
router latency ≈ TTFT + (output_tokens / TPS)
              ≈ TTFT + ~0.4 s
```

TTFT therefore dominates. A non-reasoning model with sub-second TTFT yields a router that
returns in **~1–1.5 s** end-to-end through a healthy proxy. A reasoning model adds its
entire thinking window to TTFT and can exceed 60 s.

### 5.3 Recommendation (ranked)

1. **`CopilotProxyClaudeHaiku45` (claude-haiku-4-5), non-reasoning — PRIMARY.**
   Best TTFT (~0.7 s), solid throughput, enough intelligence to classify intent and emit
   structured JSON. Available on Copilot CLI surface.
2. **`CopilotProxyGrokCodeFast1` (grok-code-fast-1) — SECONDARY.** Purpose-built for fast
   agentic decisions, very cheap ($0.20/$1.50 per 1M), reliable structured output. Good if
   Haiku is unavailable or slower on the proxy.
3. **`CopilotProxyGemini3FlashPreview` (gemini-3-flash-preview), non-reasoning —
   THROUGHPUT PICK.** Highest raw TPS (~163); choose it if a local benchmark shows low
   TTFT on the proxy.
4. **`CopilotProxyRaptorMini` (raptor-mini) — CANDIDATE, verify.** Fine-tuned GPT-5 mini
   optimized for fast completions; confirm it doesn't inherit GPT-5-mini reasoning latency
   and that it reliably emits the router schema.

**Final selection should be the winner of a local micro-benchmark** (§8) among #1–#4. For
the router *call itself*, force the cheapest/fastest setting: non-reasoning (or
`reasoningEffort: "low"`) and a small max-output cap.

---

## 6. Routing architecture — options and recommendation

### Option A — Pure fast-LLM router (what the request literally describes)
One BAML function `RouteModelCall(taskKind, summary, candidates) -> RoutingDecision` on a
fast client, called before every routed call.
*Pros:* flexible, handles any dynamic intent. *Cons:* adds an LLM round-trip to *every*
call; non-deterministic for fixed internal tasks; needs a timeout/fallback to be safe.

### Option B — Deterministic policy table only
A static map: call-site/task-kind → `{ model, effort }`. *Pros:* ~0 ms, deterministic,
trivially testable. *Cons:* no adaptivity for novel/dynamic intents.

### Option C — Hybrid (RECOMMENDED)
A single `ModelRouter` interface backed by:

1. **Deterministic policy table** for the known call sites (the 3 BAML functions +
   persona tiers). Instant, deterministic, unit-testable. This is the default and the
   fallback.
2. **Fast-LLM `RouteModelCall`** (Option A) for *dynamic/ambiguous* intent only, running
   on the §5 router client, guarded by an **`AbortSignal` hard timeout (~3.5 s)**. On
   timeout/parse-failure/error it returns the policy default.
3. **Decision cache** keyed by `(taskKind, coarse input shape)` to avoid repeat LLM
   routing within a run.

Rationale: the council's internal calls are *fixed* tasks — an LLM router adds latency and
nondeterminism with little benefit there, so route them by policy. Reserve the fast LLM for
genuinely dynamic decisions, and never let it threaten the 5 s budget because the
deterministic default is always available underneath.

### 6.1 Suggested capability/cost policy (starting defaults)

| Call site / task kind | Default client | Effort |
| --- | --- | --- |
| `NormalizePersonaCritique` | `CopilotProxyClaudeHaiku45` or `CopilotProxyGpt5Mini` | low / none |
| `AssessCouncilRound` (Judge) | `CopilotProxyClaudeSonnet46` or `CopilotProxyGpt54` | medium |
| `CreateCouncilReport` | `CopilotProxyClaudeSonnet46` / `CopilotProxyClaudeOpus48` | high |
| Persona debate (Copilot SDK) | persona-tier (e.g. `claude-sonnet-4.6` / `gpt-5.4`) | medium |
| Router itself | `CopilotProxyClaudeHaiku45` | low / non-reasoning |

(Defaults are a starting point; tune after a quality/latency pass.)

---

## 7. The sub-5-second budget

```
Hybrid path budget (worst case, LLM router engaged):
  deterministic pre-check ............. ~0 ms
  fast router LLM call ................ TTFT (~0.7–2 s) + ~0.4 s gen  ≈ 1.1–2.4 s
  AbortSignal hard cap ................ 3.5 s → fallback to policy default
  apply decision (build CR / config) .. <5 ms
  => routing decision well under 5 s, guaranteed by the hard cap + default
```

Mechanisms to enforce it:
- BAML: pass `signal` (AbortSignal) in `__baml_options__`
  (`src/generated/baml_client/async_client.ts:49`); on abort, use policy default.
- Copilot SDK: `sendAndWait(message, timeoutMs)` already supports a timeout
  (`personaWorker.ts:156`).
- Always keep the deterministic default as the fallback so a slow/failed router never
  blocks the actual work.

---

## 8. Open questions / verification steps (for planning)

1. **Local proxy latency (highest priority).** Public TTFT/TPS are *relative* — every
   client here hits `http://127.0.0.1:8080/v1`. Write a tiny benchmark that sends one
   fixed ~50-token routing prompt to each §5 candidate via the proxy and records
   wall-clock TTFT + total. Pick the router client from *measured* results.
2. **BAML `reasoning_effort` passthrough.** Confirm the local proxy forwards
   `reasoning_effort` for `openai-generic` clients. If it doesn't, BAML-side effort control
   reduces to "choose a different model client," while the Copilot SDK path keeps native
   `reasoningEffort`.
3. **`raptor-mini` behavior.** Verify it is exposed by the proxy, returns valid router
   JSON, and is genuinely low-latency (not inheriting GPT-5-mini thinking).
4. **SDK effort support per model.** Call `listModels()` to confirm which models accept
   `reasoningEffort` before sending it (sending it to a non-supporting model may error).
5. **Build precondition (blocker).** The `safe-gale` branch is mid-rename and will not
   compile as-is — fix or rebase onto green before adding the router:
   - `src/cli.ts:4-7` imports `./council/runner.js` etc., but only `src/decision-council/`
     exists (no `src/council/`).
   - `src/decision-council/runner.ts:9-11,26,29` imports/uses `CouncilInputSchema` /
     `CouncilReport`, but `types.ts` now exports `DecisionCouncilInputSchema` /
     `DecisionCouncilReport`.
   - `src/decision-council/bamlAdapters.ts:3-6` imports `CouncilReportSchema`,
     `PersonaCritiqueSchema`, `RoundAssessmentSchema`, `CouncilReport`, etc., which were
     renamed to `DecisionCouncil*` / `DecisionPersona*` in `types.ts`.
   - `src/index.ts:11-12` imports `runDecisionCouncil` / `createDecisionCouncilWorkflow`,
     but `runner.ts` / `workflow.ts` still export `runCouncil` / `createCouncilWorkflow`.

---

## 9. Recommended approach (summary for the plan)

Build a thin, well-tested routing layer; do not modify BAML/SDK internals.

1. **New `src/decision-council/modelRouter.ts`:** a `ModelRouter` interface returning
   `{ clientName?: string; model: string; reasoningEffort?: "low"|"medium"|"high"|"xhigh"; rationale: string }`.
   Implementations: `PolicyModelRouter` (table from §6.1) and `LlmModelRouter`
   (calls a new `RouteModelCall` BAML fn on the §5 router client, with AbortSignal timeout
   + fallback to `PolicyModelRouter`). Compose as `HybridModelRouter`.
2. **New `baml_src/router.baml`:** `RouteModelCall(...) -> RoutingDecision` pinned to the
   fast router client (start with `CopilotProxyClaudeHaiku45`). Add an effort-tuned or
   dynamic client only if the proxy honors `reasoning_effort`.
3. **Thread routing into `bamlAdapters.ts`:** have `GeneratedBamlAdapters` consult the
   router per function and pass `{ client }` (simple) or `{ clientRegistry }` (effort) into
   `b.NormalizePersonaCritique` / `b.AssessCouncilRound` / `b.CreateCouncilReport`.
4. **Thread routing into `personaWorker.ts` / `runner.ts`:** select `model` +
   `reasoningEffort` per persona/round from the router instead of the hardcoded
   `claude-sonnet-4.5`; validate via `listModels()` at startup.
5. **Add a proxy micro-benchmark** (§8.1) to pick/justify the router client from measured
   numbers, and unit tests for the policy table + the timeout-fallback path.
6. **Precondition:** land the council→decision-council rename to a green build first.

---

## Sources

Codebase: `baml_src/clients.baml`, `baml_src/council.baml`,
`src/decision-council/bamlAdapters.ts`, `src/decision-council/personaWorker.ts`,
`src/decision-council/runner.ts`, `src/generated/baml_client/async_client.ts`
(lines `42-52`, `100-134`, `212-214`).

BAML runtime client selection: BAML docs — *Client Registry*
(`docs.boundaryml.com/ref/baml_client/client-registry`), *client option* and
*with_options* (BoundaryML/baml `fern/03-reference/baml_client/*`); native
`ClientRegistry.addLlmClient(name, provider, options)`.

Copilot SDK: `@github/copilot-sdk` README (`createSession` config —
`reasoningEffort: "low"|"medium"|"high"|"xhigh"`, `listModels()`); npm
`@github/copilot-sdk` (published 2026-01-08).

Model speeds: Artificial Analysis (Claude 4.5 Haiku, Gemini 3 Flash, GPT-5 mini,
Grok Code Fast 1 providers/model pages); xAI Grok Code Fast 1 announcement; OpenRouter
model pages; GitHub Docs — *Supported AI models in Copilot* and *AI model comparison*
(raptor-mini = "Fine-tuned GPT-5 mini", GA); GitHub Changelog (raptor-mini preview,
2025-11-10).
