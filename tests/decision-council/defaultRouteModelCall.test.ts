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

    expect(mocks.bamlCall).toHaveBeenCalledWith(input.taskKind, input.summary, input.candidates, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.spanState.startActiveSpanCalls).toEqual(["run.council.baml.route-model-call"]);

    const span = mocks.spanState.spans[0];
    const args = span?.attributes["weavekit.decision_council.args"] as string;
    const result = span?.attributes["weavekit.decision_council.result"] as string;
    expect(args.length).toBeLessThanOrEqual(5 * 1024);
    expect(result.length).toBeLessThanOrEqual(5 * 1024);
    expect(args).toContain('"taskKind":"assess"');
    expect(result).toContain('"clientName":"CopilotProxyGpt54"');
    expect(span?.ended).toBe(true);
  });
});
