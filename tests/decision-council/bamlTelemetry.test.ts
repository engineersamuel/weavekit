import { beforeEach, describe, expect, it, vi } from "vitest";

const collectorInstances: { name?: string; logs: unknown[]; last: unknown }[] = [];
const spanState = {
  startActiveSpanCalls: [] as string[],
  spans: [] as {
    name: string;
    attributes: Record<string, unknown>;
    status: unknown[];
    exceptions: unknown[];
    ended: boolean;
  }[],
};

vi.mock("@boundaryml/baml", () => ({
  Collector: class Collector {
    logs: unknown[] = [];
    last: unknown = null;
    usage = {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    };

    constructor(public readonly name?: string) {
      collectorInstances.push(this);
    }
  },
}));

vi.mock("@opentelemetry/api", () => ({
  SpanStatusCode: {
    OK: 1,
    ERROR: 2,
  },
  trace: {
    getTracer: vi.fn(() => ({
      startActiveSpan: vi.fn(async (name: string, fn: (span: {
        setAttribute: (key: string, value: unknown) => void;
        updateName: (value: string) => void;
        setStatus: (value: unknown) => void;
        recordException: (value: unknown) => void;
        end: () => void;
      }) => Promise<unknown>) => {
        const span = {
          name,
          attributes: {} as Record<string, unknown>,
          status: [] as unknown[],
          exceptions: [] as unknown[],
          ended: false,
        };
        spanState.startActiveSpanCalls.push(name);
        spanState.spans.push(span);
        return await fn({
          setAttribute(key, value) {
            span.attributes[key] = value;
          },
          updateName(value) {
            span.name = value;
          },
          setStatus(value) {
            span.status.push(value);
          },
          recordException(value) {
            span.exceptions.push(value);
          },
          end() {
            span.ended = true;
          },
        });
      }),
    })),
  },
}));

import {
  runTracedBamlOperation,
  TraceBamlOperation,
  createBamlTelemetryOptions,
  createCollectorTagMap,
} from "../../src/decision-council/bamlTelemetry.js";

describe("bamlTelemetry", () => {
  beforeEach(() => {
    collectorInstances.length = 0;
    spanState.startActiveSpanCalls.length = 0;
    spanState.spans.length = 0;
  });

  it("creates collector tag maps from defined values", () => {
    expect(createCollectorTagMap({ runId: "run-1", roundNumber: 2, personaId: "skeptic" })).toEqual({
      runId: "run-1",
      roundNumber: "2",
      personaId: "skeptic",
    });
    expect(createCollectorTagMap({})).toEqual({});
  });

  it("preserves method results and exposes collector-backed options", async () => {
    class Example {
      @TraceBamlOperation("normalize")
      async ok(): Promise<{
        options: ReturnType<typeof createBamlTelemetryOptions>;
        collectorName: string | undefined;
      }> {
        const options = createBamlTelemetryOptions({ personaId: "skeptic", roundNumber: 3 });
        const collector = Array.isArray(options.collector) ? options.collector[0] : options.collector;
        return { options, collectorName: (collector as { name?: string } | undefined)?.name };
      }
    }

    const result = await new Example().ok();

    expect(result.collectorName).toBe("decision-council.normalize");
    expect(result.options.tags).toEqual({ personaId: "skeptic", roundNumber: "3" });
    expect(spanState.startActiveSpanCalls).toEqual(["run.council.baml.normalize"]);
    expect(spanState.spans[0]?.name).toBe("run.council.baml.persona.skeptic");
    expect(spanState.spans[0]?.attributes).toMatchObject({
      "gen_ai.system": "baml",
      "gen_ai.operation.name": "normalize",
      "weavekit.decision_council.persona_id": "skeptic",
      "weavekit.decision_council.round_number": 3,
    });
    expect(spanState.spans[0]?.ended).toBe(true);
  });

  it("falls back to the current normalize span name without persona context", async () => {
    await runTracedBamlOperation("normalize", [{ text: "plain" }], async () => "ok");

    expect(spanState.startActiveSpanCalls).toEqual(["run.council.baml.normalize"]);
  });

  it("keeps non-normalize span names unchanged", async () => {
    await runTracedBamlOperation("report", [{ personaId: "skeptic" }], async () => "ok");

    expect(spanState.startActiveSpanCalls).toEqual(["run.council.baml.report"]);
  });

  it("records exceptions on the span and rethrows", async () => {
    const failure = new Error("boom");

    class Example {
      @TraceBamlOperation("report")
      async explode(): Promise<never> {
        createBamlTelemetryOptions({ runId: "run-9" });
        throw failure;
      }
    }

    await expect(new Example().explode()).rejects.toThrow("boom");
    expect(spanState.spans[0]?.exceptions).toEqual([failure]);
    expect(spanState.spans[0]?.attributes["weavekit.decision_council.run_id"]).toBe("run-9");
    expect(spanState.spans[0]?.ended).toBe(true);
  });

  it("serializes args and results into bounded span attributes", async () => {
    const payload = {
      text: "x".repeat(6000),
    };

    class Example {
      @TraceBamlOperation("normalize")
      async echo(input: typeof payload): Promise<typeof payload> {
        return input;
      }
    }

    const result = await new Example().echo(payload);

    expect(result).toEqual(payload);
    const span = spanState.spans[0];
    const args = span?.attributes["weavekit.decision_council.args"] as string;
    const output = span?.attributes["weavekit.decision_council.result"] as string;
    expect(args.length).toBeLessThanOrEqual(5 * 1024);
    expect(output.length).toBeLessThanOrEqual(5 * 1024);
    expect(args).toContain('"text":"xxxxxxxxxx');
    expect(output).toContain('"text":"xxxxxxxxxx');
  });
});
