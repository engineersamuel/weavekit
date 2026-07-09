# Observability Idea: Unified Flue, Weavekit, and BAML Tracing

Weavekit should expose enough telemetry to make a long-running Design Council traceable end-to-end without building a custom observability web app.

## Goal

Show Flue runtime activity, Weavekit council orchestration, Copilot persona calls, BAML normalization/Judge/report calls, and artifact writing in one distributed trace view.

## Recommended Viewer

Use an existing OpenTelemetry-compatible backend instead of building a custom UI.

Good options:

| Backend                             | Use when                                                               |
| ----------------------------------- | ---------------------------------------------------------------------- |
| Jaeger                              | You want the simplest local distributed trace viewer.                  |
| Grafana Tempo + Grafana             | You want local or production-style traces, logs, and metrics together. |
| Honeycomb                           | You want hosted trace analysis with strong query UX.                   |
| Datadog / New Relic / Grafana Cloud | You want hosted all-in-one observability.                              |

Local Jaeger starter:

```bash
docker run --rm --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest
```

Then open:

```text
http://127.0.0.1:16686
```

## Runtime Configuration

Example local run:

```bash
export OTEL_SERVICE_NAME=weavekit
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_TRACES_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=none
export OTEL_LOGS_EXPORTER=none
export COPILOT_PROXY_API_KEY=anything
export BAML_LOG=warn

nub run council council run --input examples/design-question.md --output runs/example
```

## Flue Integration

Use Flue's OpenTelemetry bridge when running through a Flue-hosted app or the exported `createCouncilWorkflow(...)` registration seam.

```ts
import { instrument } from "@flue/runtime";
import { createOpenTelemetryInstrumentation } from "@flue/opentelemetry";

instrument(
  createOpenTelemetryInstrumentation({
    content: {
      enabled: process.env.OTEL_GENAI_CAPTURE_CONTENT === "true",
      transform(content) {
        return content;
      },
    },
  }),
);
```

Keep `OTEL_GENAI_CAPTURE_CONTENT` unset or `false` by default. Flue events can contain prompts, model messages, tool values, and workflow inputs, so content capture needs a redaction policy first.

## Weavekit Manual Spans

The current CLI path calls `runCouncil()` directly instead of executing through a Flue app. Add manual OpenTelemetry spans around the direct path so local CLI runs still produce one trace tree.

Recommended span names:

- `run.council`
- `run.council.round`
- `run.council.persona`
- `run.council.baml.normalize`
- `run.council.baml.assess`
- `run.council.baml.report`
- `write.council.artifacts`

Recommended low-cardinality attributes:

- `council.run_id`
- `council.round_number`
- `council.persona_id`
- `council.stop_reason`
- `council.successful_personas`
- `council.failed_personas`
- `gen_ai.operation.name`
- `gen_ai.request.model`
- `server.address`
- `url.full`

Avoid raw prompt text, full Markdown report content, and design question content as span attributes.

## BAML Integration

BAML has a `Collector` API that can inspect function calls, usage, raw responses, timing, and HTTP calls. Wrap each generated BAML call in an OpenTelemetry span and attach collector-derived attributes.

Example BAML call boundaries:

- `NormalizePersonaCritique`
- `AssessCouncilRound`
- `CreateCouncilReport`

Recommended BAML span attributes:

- `gen_ai.system = "baml"`
- `gen_ai.operation.name = "NormalizePersonaCritique"`
- `gen_ai.request.model = "gpt-5-mini"`
- `gen_ai.usage.input_tokens`
- `gen_ai.usage.output_tokens`
- `server.address = "127.0.0.1"`
- `url.full = "http://127.0.0.1:8080/v1/chat/completions"`

The BAML spans should be created while the Weavekit/Flue span context is active. That is what makes them appear as child spans in the same trace.

## Important Design Point

Flue, Weavekit, and BAML only show up in one view if they share the same active OpenTelemetry context.

- Flue spans appear automatically only when the work runs under Flue instrumentation.
- Weavekit direct CLI spans must be created manually.
- BAML spans should be manually wrapped around generated client calls using the BAML Collector.
- The viewer can be Jaeger, Tempo, Honeycomb, Datadog, or another OTLP backend; no custom web app is required.

## Future Implementation Sketch

1. Add OpenTelemetry SDK dependencies and an optional `src/telemetry.ts` bootstrap.
2. Add `RunCouncilOptions.telemetry?: TelemetryHooks` or use active OTel context directly in `runCouncil`.
3. Convert existing `CouncilLogger` events into span events or structured logs.
4. Wrap persona worker calls in `run.council.persona` spans.
5. Wrap BAML adapter calls in `run.council.baml.*` spans using `Collector`.
6. Add README instructions for Jaeger and OTLP env vars.
7. Add tests with an in-memory OTel exporter to verify span names, parent-child hierarchy, and content omission.
