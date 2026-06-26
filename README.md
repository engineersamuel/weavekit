# Weavekit

Weavekit is a TypeScript-first playground for orchestrating GitHub Copilot SDK agents through explicit, typed workflows.

The v0 workflow is a Design Council. It runs four debating personas, normalizes their critiques through BAML, asks a Judge reducer whether to continue, and writes:

- `DecisionCouncilReport.md`
- `DecisionCouncilRunState.json`
- raw transcript debug files

## Setup

```bash
npm install
npm run baml-generate
```

Run the local Copilot proxy on port 8080 before running the real workflow. The BAML clients use the proxy's OpenAI-compatible `/v1/chat/completions` endpoint. Set `BAML_MODEL` for the fallback `DefaultClient` (e.g., `gpt-5-mini`); note the decision council routes its BAML calls to fixed policy clients by default, so `BAML_MODEL` does not drive them (see [Model + effort routing](#model--effort-routing)).

```bash
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/v1/models
export COPILOT_PROXY_BASE_URL="http://127.0.0.1:8080/v1"
export COPILOT_PROXY_API_KEY="anything"
export BAML_MODEL="gpt-5-mini"
```

`COPILOT_PROXY_BASE_URL` is the base URL for the `DefaultClient` (the BAML fallback client, used only when no model router is injected). Set it to your proxy's OpenAI-compatible endpoint. The hardcoded `CopilotProxy*` model clients — including the ones the decision council routes to by default — always use `http://127.0.0.1:8080/v1`.

`COPILOT_PROXY_API_KEY` can be any non-empty value unless your proxy is configured to require a specific inbound API key. The proxy uses your local Copilot credentials; keep it bound to loopback.

`BAML_MODEL` sets the model for `DefaultClient`, the fallback used when no model router is injected. By default the decision council routes `normalize`/`assess`/`report` to fixed policy clients (see [Model + effort routing](#model--effort-routing)), so `BAML_MODEL` does not affect those calls. Defaults to `gpt-5-mini` in prior versions; must now be set explicitly.

> **Migration note (from ≤ aa829d9):** The BAML `DefaultClient` env variables were renamed when client definitions were extracted to `baml_src/clients.baml`. Rename your environment variables:
> - `BAML_OPENAI_BASE_URL` → `COPILOT_PROXY_BASE_URL`
> - `BAML_OPENAI_API_KEY` → `COPILOT_PROXY_API_KEY`

GitHub Copilot SDK authentication for persona workers follows the SDK's local authentication behavior.

## Run the Design Council

```bash
npm run council -- decision-council run --input examples/design-question.md --output runs/example
```

With nub:

```bash
nub run council decision-council run --input examples/design-question.md --output runs/example
```

The CLI prints compact rich progress to stderr while the council runs: run start, round start, persona start/finish/failure, BAML normalization/Judge/report phases, artifact paths, and final stop reason. After each successful BAML normalization, pretty logs include one indented summary of that persona's normalized stance:

```text
[2026-06-24T19:42:21.962Z] baml completed round=1 persona=pragmatic operation=normalize duration=4.5s
    -> Pragmatic persona recommends a minimal validation spike before adopting Flue/BAML.
```

Rounds use a shared fan-out/fan-in model. Round 1 sends the initial brief to every persona. Round 2+ sends one shared Judge brief, produced from the previous round's full set of normalized critiques, to every persona; the Judge then assesses the current round's full critique set together.

The final stdout includes the recommendation plus a link to the Markdown report:

```text
Markdown report: runs/example/DecisionCouncilReport.md
```

Use `--log-format` to control progress output:

```bash
nub run council decision-council run --input examples/design-question.md --output runs/example --log-format pretty
nub run council decision-council run --input examples/design-question.md --output runs/example --log-format json
nub run council decision-council run --input examples/design-question.md --output runs/example --log-format silent
```

`pretty` is colored human-readable progress. `json` emits newline-delimited structured events such as `council.run.started`, `council.persona.completed`, and `council.baml.completed`. `silent` suppresses Weavekit progress logs.

BAML can print large raw prompts/responses. Use `BAML_LOG=warn` when you want Weavekit's progress logs without BAML's verbose prompt dump:

```bash
BAML_LOG=warn COPILOT_PROXY_API_KEY="anything" nub run council decision-council run --input examples/design-question.md --output runs/example
```

## Personas and persona sets

The council debates a **persona set**. Select one with `--persona-set <name>`; omitting it uses `default`.

```bash
nub run council decision-council run --input examples/design-question.md --persona-set strategic
```

| Set | Personas | Use for |
| --- | --- | --- |
| `default` | Socratic Questioner, Deep Module/DRY Architect, Pragmatic Builder, Skeptic | General design critique |
| `strategic` | the four defaults **+ Strategic Game Theorist + Sun Tzu Strategist** | Decisions with competition, incentives, timing, or positioning |
| `dialectic` | Dialectic Advocate, Dialectic Adversary, Hostile Auditor | Thesis/antithesis stress test of a single proposal |

### Sun Tzu Strategist

`sun-tzu` reads a decision as terrain. It names the real battlefield and the actual opposing force (not the surface rival), finds the undefended gap, prescribes the exact next move, and names the trap to avoid — then closes on the one governing principle that makes the move win. It is cold and prescriptive ("give the move, not the wisdom"); in-council it ends every critique with the four claims/risks/questions/recommendations lists so BAML normalization stays lossless. The full standalone form lives in the canonical spec [`personas/sun-tzu.md`](personas/sun-tzu.md).

### Reusing personas in other workflows

Personas live in a workflow-agnostic registry under [`personas/`](personas/): one TOML file per persona (`personas/<id>.toml`) plus a portable canonical spec (`personas/<id>.md`), grouped into named sets in [`personas/sets.toml`](personas/sets.toml). Any workflow can load them directly from the package's persona subsystem (re-exported from `src/index.ts`):

```ts
import { getPersona, getPersonaSet, listPersonaSets, composePersonaPrompt } from "weavekit";

const sunTzu = getPersona("sun-tzu");
const message = composePersonaPrompt(sunTzu, {
  brief: { roundNumber: 1, prompt: "Should we out-build a larger competitor?", focus: "Strategy" },
});
```

`getPersona(id)`, `getPersonaSet(name)`, and `listPersonaSets()` read the registry; `composePersonaPrompt` deterministically renders a persona's stance, framing corrections, anti-hedging, and mode into the round message. Set `WEAVEKIT_PERSONAS_DIR` to point at a different directory to load a custom persona library.

## Model + effort routing

Weavekit's decision council routes each task (normalize, assess, report, persona) to a model and optional reasoning effort using a hybrid router: a deterministic policy default always applies, and an optional fast LLM router is consulted only when a task is marked `dynamic`.

**Hybrid router:** The policy default is always resolved first. For tasks with `dynamic: true`, the router consults a fast LLM router model to pick a model and effort from a curated candidate set. The LLM router result is cached per `(taskKind, summary)` prefix. If the LLM returns a client or model outside the allowed candidate set, the router falls back to the policy default.

**Sub-5-second guarantee:** The LLM router races its call against a 3500 ms `AbortSignal` timeout. On timeout or any error, the router immediately falls back to the deterministic policy. This ensures routing decisions never block the workflow.

**Default routing policy:**

| Task kind | BAML client | Model | Use case |
|-----------|-------------|-------|----------|
| `normalize` | `CopilotProxyGpt54` | `gpt-5.4` | Lowest-TTFT structured extraction default |
| `assess` | `CopilotProxyGpt54` | `gpt-5.4` | Lowest-TTFT Judge decision default |
| `report` | `CopilotProxyGpt55` | `gpt-5.5` | Fast, high-throughput synthesis |
| `persona` | (Copilot SDK path) | `claude-sonnet-4.5` | Persona debate tier |

**BAML effort passthrough:** By default, BAML routing swaps the *client* only and does NOT send `reasoning_effort` to the proxy. Effort passthrough is opt-in, left disabled pending proxy verification. Similarly, persona `reasoningEffort` is only forwarded when an operator wires an explicit capability predicate (it defaults to off). No model receives an effort field it might reject unless explicitly enabled.

**Benchmark router latency:**

Before choosing a production router model, measure TTFT and total latency across candidates:

```bash
export COPILOT_PROXY_BASE_URL="http://127.0.0.1:8080/v1"
export COPILOT_PROXY_API_KEY="anything"
npm run bench:router
```

This prints a table of TTFT and total latency per candidate router model. It is a standalone diagnostic, not part of `npm test`.

## Observability

The direct CLI path uses Weavekit's typed `DecisionCouncilLogger` events. Use `--log-format json` to capture them as JSONL:

```bash
BAML_LOG=warn nub run council decision-council run --input examples/design-question.md --output runs/example --log-format json 2> runs/example/events.jsonl
```

Recommended span names if you export those events to OpenTelemetry:

- `run.council`
- `run.council.round`
- `run.council.persona`
- `run.council.baml`
- `write.council.artifacts`

Flue runtime observability applies when running through the exported `createDecisionCouncilWorkflow(...)` registration seam. Register Flue's observer or OpenTelemetry instrumentation in the application entrypoint that hosts the workflow:

```ts
import { instrument, observe } from "@flue/runtime";
import { createOpenTelemetryInstrumentation } from "@flue/opentelemetry";

observe((event) => {
  if (event.type === "run_end" && event.isError) {
    console.error("Workflow failed", event.runId, event.error);
  }

  if (event.type === "operation" && event.durationMs > 5_000) {
    console.warn("Slow Flue operation", event.operationKind, event.durationMs);
  }
});

const dispose = instrument(createOpenTelemetryInstrumentation({
  content: {
    enabled: process.env.OTEL_GENAI_CAPTURE_CONTENT === "true",
    transform(content) {
      return content;
    },
  },
}));
```

Install the Flue OpenTelemetry bridge only in apps that export telemetry:

```bash
npm install @flue/opentelemetry @opentelemetry/api
```

Keep `OTEL_GENAI_CAPTURE_CONTENT` unset or `false` unless you have reviewed prompt/content retention, because Flue events can include model-visible content.

## Verify

```bash
npm test
npm run typecheck
npm run build
```

## Evaluating the Decision Council

`evals/corpus/*.yaml` holds open-ended technical *decision* questions, each with a
detailed reference answer and a weighted rubric. The eval harness runs two
providers against every question — the Decision Council (`runDecisionCouncil`,
in-memory) and a vanilla `copilot -p` baseline (no extra prompting) — and grades
both with a reference-guided LLM judge via promptfoo.

```bash
# Grade every corpus item (council vs vanilla Copilot CLI):
npm run eval

# Grade specific items by id:
npm run eval -- orchestration-framework-001 data-store-001

# Run up to 4 promptfoo eval cells concurrently:
npm run eval -- --max-concurrency 4 orchestration-framework-001 data-store-001
```

Judge configuration (OpenAI-compatible) via env: `EVAL_JUDGE_BASE_URL`
(default `http://127.0.0.1:8080/v1`), `EVAL_JUDGE_API_KEY`, `EVAL_JUDGE_MODEL`.
Baseline model via `EVAL_COPILOT_MODEL` (default `auto`). Results are written to
`evals/results/<timestamp>/` (gitignored).

Eval concurrency defaults to `1` (fully sequential). Set `--max-concurrency <n>` or
`--concurrency <n>` (or `EVAL_MAX_CONCURRENCY`) to let promptfoo evaluate multiple
corpus cells in parallel. Keep values small: each Council cell fans out roughly 4+
Copilot SDK persona sessions, and each baseline cell starts a `copilot` CLI process,
so concurrency `N` can mean up to `N × personas` concurrent Copilot SDK sessions plus
`N` baseline processes against the local proxy.
