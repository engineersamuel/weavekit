# Weavekit

Weavekit is a TypeScript-first playground for orchestrating GitHub Copilot SDK agents through explicit, typed workflows.

The v0 workflow is a Design Council. It selects a compact, task-appropriate persona subset each round from repo-local entity manifests, normalizes critiques through BAML, asks a Judge reducer whether to continue, and writes:

- `DecisionCouncilReport.md`
- `DecisionCouncilRunState.json`
- raw transcript debug files

## Initial prompt router

Weavekit now includes a lightweight front-door router that classifies an incoming prompt before the main harness runs. The default scorer is heuristic and intentionally cheap: it scores planning, research, decision-council, elicitation, and direct routes so a prompt can be routed to the most suitable next step without replacing the underlying agent harness.

```ts
import { createInitialWorkflowRouter } from "weavekit";

const router = createInitialWorkflowRouter();
const decision = await router.route({
  prompt: "Create a rollout plan for the new router and break it into milestones.",
});

console.log(decision.route);
```

This layer is designed to be extended with additional routes or a faster LLM/BAML scorer later, while keeping the initial classification cheap and deterministic.

## Setup

```bash
mise install
nub install
nub run baml-generate
```

Install the local pre-commit hook (lints/auto-fixes and formats staged files with oxlint + oxfmt via `mise run pre-commit`; this must be run once per clone since `.git/hooks` isn't version-controlled):

```bash
mise generate git-pre-commit --write
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

## Source-to-project workflow

The `source-to-project` workflow applies one external Source artifact to one configured Target project. It reads the source, corroborates claims, researches the target project, maps project-specific Opportunities, asks the Decision Council to rank and bundle them, writes Plan artifacts, and can optionally prepare review-ready pull requests.

Advisory mode is the default and does not modify the target project:

```bash
nub src/cli.ts workflow run --template source-to-project --source "https://example.com/post" --project weavekit --mode advisory
```

`--source` may be omitted when the prompt or input file includes a URL, `source: ...`, or `blog: ...`; the explicit flag still wins when both are present.

Use `--prompt` when you want a human-readable objective for the run without creating an input file:

```bash
nub src/cli.ts workflow run \
  --template source-to-project \
  --prompt "Read and analyze https://github.com/robert-mcdermott/ai-knowledge-graph for how it will apply to project: secondbrain" \
  --source "https://github.com/robert-mcdermott/ai-knowledge-graph" \
  --project secondbrain \
  --mode advisory
```

For repeated source-to-project runs against weavekit, use the mise task. If the prompt includes a URL, Weavekit uses that URL as the Source artifact reference; otherwise it treats the prompt text itself as the Source artifact.

```bash
mise run source-to-project "Adapt these loops to weavekit: https://github.com/cobusgreyling/loop-engineering and also review their code to see how they are doing loops and what might apply to the weavekit static DAG templates or dynamic workflows"
```

The task defaults to `project=weavekit`, `mode=advisory`, `output=runs`, and dashboard publishing to `http://127.0.0.1:4321`. For different project or output settings, call `nub src/cli.ts workflow run` directly with `--project` or `--project-path`, `--mode`, `--output`, and `--dashboard-url`.

By default, source-to-project runs use the live Copilot SDK harness and generated BAML distillation calls. Configure first-party source-to-project defaults in `~/.weavekit/config.toml`: `source_to_project.copilot_model` overrides Copilot SDK calls, `timeout_ms` controls SDK wait time, `max_tool_calls` sets the global research tool budget, `source_reading_max_tool_calls` and `project_research_max_tool_calls` tune individual research nodes, and `offline = true` uses the deterministic offline harness for local smoke tests. The workflow verifies the `visual-plan` skill installer in a preflight node before source reading begins, and `mise run doctor:sdk` dry-runs the same installer path with `--dry-run --no-connect`. Without a Copilot model override, source reading and source corroboration use `gpt-5.5`, target project research uses `claude-sonnet-5`, planning uses `claude-opus-4.8`, and implementation uses `gpt-5.3-codex`. `BAML_MODEL` affects generated BAML distillation/mapping calls, not Copilot SDK sessions.

Autonomous PR mode must be enabled for the project in `~/.weavekit/config.toml`:

```bash
nub src/cli.ts workflow run --template source-to-project --source "https://example.com/post" --project weavekit --mode autonomous-pr
```

Example project catalog entry:

```toml
[source_to_project]
max_opportunities = 1
min_applicability = 0.7
min_confidence = 0.65
min_impact = 0.5
max_risk = 0.8
mode = "advisory"
offline = false
copilot_model = "gpt-5.5"
timeout_ms = 300000
max_tool_calls = 60
source_reading_max_tool_calls = 40
project_research_max_tool_calls = 60

[copilot]
verbose_events = false
# Optional local SDK runtime selection:
# runtime_url = "http://127.0.0.1:8181"
# cli_path = "~/.local/bin/copilot"
sdk_doctor_model = "gpt-5-mini"

[flue]
model = "anthropic/claude-haiku-4-5"

[tooling]
skills_directory = "~/.weavekit/skills"
agent_native_skills_installer = "~/.local/bin/agent-skills"
agent_native_skills_package = "@agent-native/skills@latest"
mise_bin = "/opt/homebrew/bin/mise"

[plugins.hve-core]
directory = "~/.copilot/installed-plugins/_direct/hve-core"

[projects.weavekit]
display_name = "Weavekit"
working_tree = "/path/to/weavekit"
mainline = "origin main"
remote = "origin"
context_docs = ["CONTEXT.md", "docs/adr"]
validation_commands = ["nub run typecheck", "nub run test"]
autonomous_pr_allowed = true
max_opportunities = 1
notification = "cli"
knowledge_export = "off"
```

Set `notification = "telegram"` to send final-review rejection notices through `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID`. The CLI loads these from the current shell first, then local `.env`, then local `.env.fish` without printing secret values. Notification failures are recorded in the workflow artifacts but do not fail a guarded no-op rejection.

Autonomous PR mode prepares an isolated worktree, rebases it from the configured mainline, copies `.env*` files into the worktree without recording their contents, runs implementation and verification, opens a PR, and stops. It never merges or self-approves.

## Native Flue agent harness

Weavekit uses Flue as the production workflow/agent harness. The main workflow path should call models through Flue/Pi providers, not through `@github/copilot-sdk`. The Copilot SDK may be used later for an explicit final handoff/autopilot experiment, but it is not the primary Decision Council model-call path.

Set `[flue].model` in `~/.weavekit/config.toml` to override the default Flue model for Decision Council agents. Defaults to `anthropic/claude-haiku-4-5`. The model must be a registered Flue/Pi provider.

### Flue MCP tools

The Flue workflow can expose selected MCP tools from the same systems used in local Copilot CLI config:

| MCP | Env/config | Notes |
| --- | --- | --- |
| Exa | `EXA_API_KEY` | Builds `https://mcp.exa.ai/mcp?exaApiKey=...` at runtime. |
| EngHub | none | Uses `https://mcp.eng.ms`. |
| Context7 | `CONTEXT7_API_KEY` | Sent as a trusted application header. |
| Baton | `includeLocalBaton: true` | Local development only; requires Baton MCP server on `http://localhost:53724/mcp`. |
| awesome-copilot | not wired | Current Flue MCP API expects remote MCP endpoints; bridge the Docker stdio server before exposing it. |

Server or application registration code should use `createConfiguredDecisionCouncilWorkflow(...)` when it wants the environment-configured MCP tools attached to the Flue workflow:

```ts
const { workflow, close } = await createConfiguredDecisionCouncilWorkflow(deps, {
  env: process.env,
  includeLocalBaton: false,
});

try {
  // Register or invoke `workflow` with the Flue runtime.
} finally {
  await close();
}
```

### Superpowers skill

The `using-superpowers` Agent Skill is vendored under `src/skills/using-superpowers/` and imported by the shared Flue Decision Council agent. Skills provide instructions and reusable process guidance; executable capabilities still come from Flue tools/MCP servers.

## Run the Design Council

```bash
nub run council decision-council run --input examples/design-question.md --output runs/example
```

The CLI prints rich progress to stderr while the council runs: run start, round start, persona start/finish/failure, BAML normalization/Judge/report phases, artifact paths, and final stop reason. Each event renders as a colored, YAML-style block (via [prettyjson](https://www.npmjs.com/package/prettyjson)) under a status-colored header. After each successful BAML normalization, the block includes the persona's normalized stance summary:

```text
[2026-06-24T19:42:21.962Z] baml completed
  runId:       run-1
  roundNumber: 1
  personaId:   pragmatic
  operation:   normalize
  summary:     Pragmatic persona recommends a minimal validation spike before adopting Flue/BAML.
  duration:    4.5s
```

Rounds use a shared fan-out/fan-in model. Round 1 sends the initial brief to the selected personas for that round. Round 2+ sends one shared Judge brief, produced from the previous round's full set of normalized critiques, to the newly selected personas; the Judge then assesses the current round's full critique set together.

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

`pretty` is colored, YAML-style human-readable progress (rendered with prettyjson). `json` emits newline-delimited structured events such as `council.run.started`, `council.persona.completed`, and `council.baml.completed`. `silent` suppresses Weavekit progress logs.

BAML can print large raw prompts/responses. Use `BAML_LOG=warn` when you want Weavekit's progress logs without BAML's verbose prompt dump:

```bash
BAML_LOG=warn COPILOT_PROXY_API_KEY="anything" nub run council decision-council run --input examples/design-question.md --output runs/example
```

## Workflow Entity Manifests

Weavekit uses repo-local YAML Workflow Entity Manifests as the canonical catalog for reusable workflow entities.

- Personas live in `entities/personas/<id>.yaml` with sibling prompt prose in `entities/personas/<id>.md`.
- Artifacts live in `entities/artifacts/<id>.yaml` and reference BAML-owned functions.
- Elicitation contracts live in `entities/elicitation/<id>.yaml` with sibling prompt prose.
- Artifact and elicitation manifests are validated in v1 but are not invoked directly by runtime code.

Validate the catalog before a run:

```bash
nub src/cli.ts entity validate
```

Decision Council dynamically selects from all eligible manifest personas. Static persona sets are not supported.

```bash
nub run council decision-council run --input examples/design-question.md
```

## Smoke testing

For fast end-to-end integration smoke tests, use `--smoke`. It is a runtime preset that keeps dynamic persona selection, caps selection to two personas, runs a **single round**, and pins every model call (personas and BAML normalize/assess/report) to `gpt-5-mini` for speed:

```bash
nub run council decision-council run --smoke --input examples/smoke-question.md --output runs/smoke
```

`--smoke` defaults `--max-rounds` to `1`. `--max-rounds <n>` is also available independently to cap any run.

A `mise` task wraps the smoke command (with `BAML_LOG=warn` and a placeholder proxy key):

```bash
mise run council:smoke
```

### Sun Tzu Strategist

`sun-tzu` reads a decision as terrain. It names the real battlefield and the actual opposing force (not the surface rival), finds the undefended gap, prescribes the exact next move, and names the trap to avoid — then closes on the one governing principle that makes the move win. It is cold and prescriptive ("give the move, not the wisdom"); in-council it ends every critique with the four claims/risks/questions/recommendations lists so BAML normalization stays lossless. The full standalone form lives in [`entities/personas/sun-tzu.md`](entities/personas/sun-tzu.md).

### Reusing personas in other workflows

Personas are loaded from the entity catalog and exposed through manifest-backed APIs. Future workflows can reuse `createBamlPersonaSelector` with `listPersonas()` or direct persona lookup:

```ts
import {
  createBamlPersonaSelector,
  getPersona,
  listPersonas,
  composePersonaPrompt,
} from "weavekit";

const sunTzu = getPersona("sun-tzu");
const dynamicSelector = createBamlPersonaSelector({ candidatePersonas: listPersonas(), minPersonas: 2, maxPersonas: 6 });
const message = composePersonaPrompt(sunTzu, {
  brief: { roundNumber: 1, prompt: "Should we out-build a larger competitor?", focus: "Strategy" },
});
```

`getPersona(id)` and `listPersonas()` read the validated entity catalog; `composePersonaPrompt` renders the sibling Markdown prompt with the round brief.

## Model + effort routing

Weavekit's decision council routes each task (normalize, assess, report, persona) to a model and optional reasoning effort using a hybrid router: a deterministic policy default always applies, and an optional fast LLM router is consulted only when a task is marked `dynamic`.

**Hybrid router:** The policy default is always resolved first. For tasks with `dynamic: true`, the router consults a fast LLM router model to pick a model and effort from a curated candidate set. The LLM router result is cached per `(taskKind, summary)` prefix. If the LLM returns a client or model outside the allowed candidate set, the router falls back to the policy default.

**Sub-5-second guarantee:** The LLM router races its call against a 3500 ms `AbortSignal` timeout. On timeout or any error, the router immediately falls back to the deterministic policy. This ensures routing decisions never block the workflow.

**Default routing policy:**

| Task kind | BAML client | Model | Use case |
|-----------|-------------|-------|----------|
| `normalize` | `CopilotProxyGpt54` | `gpt-5.4` | Lowest-TTFT structured extraction default |
| `assess` | `CopilotProxyGpt54` | `gpt-5.4` | Lowest-TTFT Judge decision default |
| `report` | `CopilotProxyGpt54` | `gpt-5.4` | Stable synthesis default |
| `persona` | (Copilot SDK path) | `claude-sonnet-4.5` | Persona debate tier |

**BAML effort passthrough:** By default, BAML routing swaps the *client* only and does NOT send `reasoning_effort` to the proxy. Effort passthrough is opt-in, left disabled pending proxy verification. Similarly, persona `reasoningEffort` is only forwarded when an operator wires an explicit capability predicate (it defaults to off). No model receives an effort field it might reject unless explicitly enabled.

**Benchmark router latency:**

Before choosing a production router model, measure TTFT and total latency across candidates:

```bash
export COPILOT_PROXY_BASE_URL="http://127.0.0.1:8080/v1"
export COPILOT_PROXY_API_KEY="anything"
nub run bench:router
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
nub install @flue/opentelemetry @opentelemetry/api
```

Keep `OTEL_GENAI_CAPTURE_CONTENT` unset or `false` unless you have reviewed prompt/content retention, because Flue events can include model-visible content.

## Telemetry and Observability

Decision Council telemetry is emitted through OpenTelemetry spans at three levels: the CLI run (`council-run`), per-round/per-persona workflow spans, and decorator-based BAML operation spans such as `run.council.baml.normalize`. If you leave all exporter credentials unset, the CLI still runs normally and no telemetry leaves the process. Set `OTEL_SDK_DISABLED=true` when you want to skip OpenTelemetry startup entirely.

The Copilot persona worker also uses the built-in Copilot SDK telemetry path when an OTLP endpoint is configured. It reuses the same OTEL endpoint/service name as the rest of Weavekit, injects the active trace context into the SDK's outbound RPCs, and joins the same trace tree as the council spans. This is enabled automatically whenever `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set and `OTEL_SDK_DISABLED` is not `true`.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `OTEL_SDK_DISABLED` | Set to `true` to disable OpenTelemetry startup entirely. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Enables OTLP trace export when set (for example `http://127.0.0.1:4318/v1/traces`). |
| `OTEL_EXPORTER_OTLP_HEADERS` | Optional OTLP auth/tenant headers consumed by the OTLP exporter environment configuration. |
| `OTEL_SERVICE_NAME` | Optional OpenTelemetry service name override; defaults to `weavekit`. |
| `OTEL_GENAI_CAPTURE_CONTENT` | Set to `true` to enable Copilot SDK content capture for persona sessions; defaults to redacted/off. |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key. When paired with `LANGFUSE_SECRET_KEY`, enables Langfuse trace export. |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key. |
| `LANGFUSE_BASE_URL` | Optional Langfuse base URL override. Defaults to `https://cloud.langfuse.com`. |
| `LANGFUSE_EXPORT_RAW` | Set to `true` only when you intentionally want raw prompts/responses uploaded to Langfuse. By default Weavekit redacts exported content. |

### Example: telemetry enabled (OTLP + Langfuse)

```bash
BAML_LOG=warn \
OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318/v1/traces" \
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer <token>" \
OTEL_SERVICE_NAME="weavekit" \
LANGFUSE_PUBLIC_KEY="pk-lf-..." \
LANGFUSE_SECRET_KEY="sk-lf-..." \
LANGFUSE_BASE_URL="https://cloud.langfuse.com" \
LANGFUSE_EXPORT_RAW="false" \
nub run council decision-council run --smoke --input examples/smoke-question.md --output runs/telemetry-enabled
```

### Example: telemetry disabled

```bash
OTEL_SDK_DISABLED=true \
BAML_LOG=warn \
nub run council decision-council run --smoke --input examples/smoke-question.md --output runs/telemetry-disabled
```

### Verification

Capture structured progress logs while you run a smoke test:

```bash
BAML_LOG=warn \
OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318/v1/traces" \
LANGFUSE_PUBLIC_KEY="pk-lf-..." \
LANGFUSE_SECRET_KEY="sk-lf-..." \
nub run council decision-council run --smoke --input examples/smoke-question.md --output runs/telemetry-verify --log-format json \
  2> runs/telemetry-verify.stderr.log
```

Check for startup/export/shutdown failures in stderr (no matches is the healthy case):

```bash
grep -iE "telemetry startup failed|telemetry shutdown failed|otlp|langfuse|export" runs/telemetry-verify.stderr.log
```

Inspect the run-level JSONL events written by Weavekit:

```bash
grep -E '"type":"council\\.(run|round|persona|baml)\\.' runs/telemetry-verify.stderr.log
```

If Langfuse export is enabled, confirm the trace in Langfuse by filtering for service `weavekit` and span names such as `council-run`, `run.council.round`, and `run.council.baml.normalize`.

## Verify

```bash
nub run baml-generate
nub run test
nub run typecheck
nub run build
```

## Evaluating the Decision Council

`evals/corpus/*.yaml` holds open-ended technical *decision* questions, each with a
detailed reference answer and a weighted rubric. The eval harness runs two
providers against every question — the Decision Council (`runDecisionCouncil`,
in-memory) and a vanilla `copilot -p` baseline (no extra prompting) — and grades
both with a reference-guided LLM judge via promptfoo.

```bash
# Grade every corpus item (council vs vanilla Copilot CLI):
nub run eval

# Grade specific items by id:
nub run eval -- orchestration-framework-001 data-store-001

# Run up to 4 promptfoo eval cells concurrently:
nub run eval -- --max-concurrency 4 orchestration-framework-001 data-store-001
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

### Router classification evals

A focused Promptfoo suite for the initial route classifier lives under
`evals/corpus/router-classification/`. It exercises the direct, plan, research,
decision-council, and elicitation routes and writes a lightweight HTML dashboard
alongside the Promptfoo report.

```bash
nub run eval:router
```

The run writes `dashboard.html`, `report.json`, `summary.md`, and `route-results.json`
into `evals/results/router-classification/<timestamp>/`.
