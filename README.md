# Weavekit

Weavekit is a TypeScript-first playground for orchestrating GitHub Copilot SDK agents through explicit, typed workflows.

The v0 workflow is a Design Council. It runs four debating personas, normalizes their critiques through BAML, asks a Judge reducer whether to continue, and writes:

- `CouncilReport.md`
- `CouncilRunState.json`
- raw transcript debug files

## Setup

```bash
npm install
npm run baml-generate
```

Run the local Copilot proxy on port 8080 before running the real workflow. The BAML clients use the proxy's OpenAI-compatible `/v1/chat/completions` endpoint. Set `BAML_MODEL` to your preferred model (e.g., `gpt-5-mini`).

```bash
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/v1/models
export COPILOT_PROXY_BASE_URL="http://127.0.0.1:8080/v1"
export COPILOT_PROXY_API_KEY="anything"
export BAML_MODEL="gpt-5-mini"
```

`COPILOT_PROXY_BASE_URL` is the base URL for the `DefaultClient` (the BAML client used by the normalize and judge functions). Set it to your proxy's OpenAI-compatible endpoint. The hardcoded `CopilotProxy*` model clients always use `http://127.0.0.1:8080/v1`.

`COPILOT_PROXY_API_KEY` can be any non-empty value unless your proxy is configured to require a specific inbound API key. The proxy uses your local Copilot credentials; keep it bound to loopback.

`BAML_MODEL` sets the model for `DefaultClient`. Defaults to `gpt-5-mini` in prior versions; must now be set explicitly.

> **Migration note (from ≤ aa829d9):** The BAML `DefaultClient` env variables were renamed when client definitions were extracted to `baml_src/clients.baml`. Rename your environment variables:
> - `BAML_OPENAI_BASE_URL` → `COPILOT_PROXY_BASE_URL`
> - `BAML_OPENAI_API_KEY` → `COPILOT_PROXY_API_KEY`

GitHub Copilot SDK authentication for persona workers follows the SDK's local authentication behavior.

## Run the Design Council

```bash
npm run council -- council run --input examples/design-question.md --output runs/example
```

With nub:

```bash
nub run council council run --input examples/design-question.md --output runs/example
```

The CLI prints compact rich progress to stderr while the council runs: run start, round start, persona start/finish/failure, BAML normalization/Judge/report phases, artifact paths, and final stop reason. After each successful BAML normalization, pretty logs include one indented summary of that persona's normalized stance:

```text
[2026-06-24T19:42:21.962Z] baml completed round=1 persona=pragmatic operation=normalize duration=4.5s
    -> Pragmatic persona recommends a minimal validation spike before adopting Flue/BAML.
```

Rounds use a shared fan-out/fan-in model. Round 1 sends the initial brief to every persona. Round 2+ sends one shared Judge brief, produced from the previous round's full set of normalized critiques, to every persona; the Judge then assesses the current round's full critique set together.

The final stdout includes the recommendation plus a link to the Markdown report:

```text
Markdown report: runs/example/CouncilReport.md
```

Use `--log-format` to control progress output:

```bash
nub run council council run --input examples/design-question.md --output runs/example --log-format pretty
nub run council council run --input examples/design-question.md --output runs/example --log-format json
nub run council council run --input examples/design-question.md --output runs/example --log-format silent
```

`pretty` is colored human-readable progress. `json` emits newline-delimited structured events such as `council.run.started`, `council.persona.completed`, and `council.baml.completed`. `silent` suppresses Weavekit progress logs.

BAML can print large raw prompts/responses. Use `BAML_LOG=warn` when you want Weavekit's progress logs without BAML's verbose prompt dump:

```bash
BAML_LOG=warn COPILOT_PROXY_API_KEY="anything" nub run council council run --input examples/design-question.md --output runs/example
```

## Observability

The direct CLI path uses Weavekit's typed `CouncilLogger` events. Use `--log-format json` to capture them as JSONL:

```bash
BAML_LOG=warn nub run council council run --input examples/design-question.md --output runs/example --log-format json 2> runs/example/events.jsonl
```

Recommended span names if you export those events to OpenTelemetry:

- `run.council`
- `run.council.round`
- `run.council.persona`
- `run.council.baml`
- `write.council.artifacts`

Flue runtime observability applies when running through the exported `createCouncilWorkflow(...)` registration seam. Register Flue's observer or OpenTelemetry instrumentation in the application entrypoint that hosts the workflow:

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
