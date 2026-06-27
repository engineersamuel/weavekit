import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const spanState = {
    startActiveSpanCalls: [] as string[],
    spans: [] as {
      attributes: Record<string, unknown>;
      ended: boolean;
    }[],
  };

  return {
    bamlCall: vi.fn(),
    spanState,
  };
});

vi.mock("@boundaryml/baml", () => ({
  Collector: class Collector {
    logs: unknown[] = [];
    last: unknown = null;
    usage = {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    };
    constructor(public readonly name?: string) {}
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
        setStatus: (value: unknown) => void;
        recordException: (value: unknown) => void;
        end: () => void;
      }) => Promise<unknown>) => {
        const span = {
          attributes: {} as Record<string, unknown>,
          ended: false,
        };
        mocks.spanState.startActiveSpanCalls.push(name);
        mocks.spanState.spans.push(span);
        return await fn({
          setAttribute(key, value) {
            span.attributes[key] = value;
          },
          setStatus() {},
          recordException() {},
          end() {
            span.ended = true;
          },
        });
      }),
    })),
  },
}));

vi.mock("../../src/generated/baml_client/index.js", () => ({
  b: {
    RouteModelCall: mocks.bamlCall,
  },
}));

import { defaultRouteModelCall } from "../../src/decision-council/modelRouter.js";

describe("defaultRouteModelCall", () => {
  beforeEach(() => {
    mocks.bamlCall.mockReset();
    mocks.spanState.startActiveSpanCalls.length = 0;
    mocks.spanState.spans.length = 0;
  });

  it("traces the generated RouteModelCall and serializes bounded args/result payloads", async () => {
    mocks.bamlCall.mockResolvedValue({
      clientName: "CopilotProxyGpt54",
      model: "gpt-5.4",
      reasoningEffort: "low",
      rationale: "y".repeat(6000),
    });

    const input = {
      taskKind: "assess",
      summary: "x".repeat(6000),
      candidates: ["CopilotProxyGpt54", "CopilotProxyClaudeSonnet46"],
    };

    await expect(defaultRouteModelCall(input, new AbortController().signal)).resolves.toMatchObject({
      clientName: "CopilotProxyGpt54",
    });

    expect(mocks.bamlCall).toHaveBeenCalledWith(
      input.taskKind,
      input.summary,
      input.candidates,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        collector: expect.objectContaining({ name: "decision-council.route-model-call" }),
      }),
    );
    expect(mocks.spanState.startActiveSpanCalls).toEqual(["run.council.baml.route-model-call"]);

    const span = mocks.spanState.spans[0];
    const args = span?.attributes["weavekit.decision_council.args"] as string;
    const result = span?.attributes["weavekit.decision_council.result"] as string;
    const langfuseInput = span?.attributes["langfuse.observation.input"] as string;
    const langfuseOutput = span?.attributes["langfuse.observation.output"] as string;
    expect(args.length).toBeLessThanOrEqual(5 * 1024);
    expect(result.length).toBeLessThanOrEqual(5 * 1024);
    expect(langfuseInput.length).toBeLessThanOrEqual(5 * 1024);
    expect(langfuseOutput.length).toBeLessThanOrEqual(5 * 1024);
    expect(args).toContain('"taskKind":"assess"');
    expect(result).toContain('"clientName":"CopilotProxyGpt54"');
    expect(langfuseInput).toContain('"taskKind":"assess"');
    expect(langfuseOutput).toContain('"clientName":"CopilotProxyGpt54"');
    expect(span?.attributes).not.toHaveProperty("langfuse.trace.name");
    expect(span?.attributes).not.toHaveProperty("langfuse.trace.input");
    expect(span?.attributes).not.toHaveProperty("langfuse.trace.output");
    expect(span?.ended).toBe(true);
  });

  it("threads the trace-scope collector into RouteModelCall options", async () => {
    mocks.bamlCall.mockImplementation(async (_taskKind, _summary, _candidates, options) => {
      const collector = options?.collector;
      if (collector && !Array.isArray(collector)) {
        collector.last = {
          functionName: "RouteModelCall",
          logType: "invoke",
          timing: { durationMs: 17 },
        };
        collector.usage.inputTokens = 11;
        collector.usage.outputTokens = 7;
        collector.usage.cachedInputTokens = 3;
      }
      return {
        clientName: "CopilotProxyGpt54",
        model: "gpt-5.4",
        reasoningEffort: "low",
        rationale: "picked",
      };
    });

    const input = {
      taskKind: "assess",
      summary: "route me",
      candidates: ["CopilotProxyGpt54", "CopilotProxyClaudeSonnet46"],
    };

    await expect(defaultRouteModelCall(input, new AbortController().signal)).resolves.toMatchObject({
      clientName: "CopilotProxyGpt54",
    });

    const callOptions = mocks.bamlCall.mock.calls[0]?.[3] as {
      collector?: { name?: string; logs: unknown[]; last: unknown; usage: Record<string, unknown> };
    } | undefined;
    expect(callOptions?.collector).toBeDefined();
    expect(callOptions?.collector?.name).toBe("decision-council.route-model-call");
    expect(mocks.spanState.spans[0]?.attributes).toMatchObject({
      "weavekit.decision_council.function_name": "RouteModelCall",
      "weavekit.decision_council.baml_duration_ms": 17,
      "gen_ai.usage.input_tokens": 11,
      "gen_ai.usage.output_tokens": 7,
      "gen_ai.usage.cached_input_tokens": 3,
    });
    expect(JSON.parse(mocks.spanState.spans[0]?.attributes["langfuse.observation.usage_details"] as string)).toEqual({
      input: 11,
      output: 7,
      total: 18,
      cached_input: 3,
    });
  });
});
