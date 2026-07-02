import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ROUTING_POLICY,
  PolicyModelRouter,
  SMOKE_ROUTING_POLICY,
  RouteTaskKind,
  createSmokeModelRouter,
} from "../../src/decision-council/modelRouter.js";
import {
  LlmModelRouter,
  normalizeRoutingDecision,
  type RouteModelCallFn,
} from "../../src/decision-council/modelRouter.js";

describe("smoke routing", () => {
  it("pins every task kind to gpt-5-mini", async () => {
    const router = createSmokeModelRouter();

    for (const taskKind of [RouteTaskKind.NORMALIZE, RouteTaskKind.ASSESS, RouteTaskKind.REPORT] as const) {
      const decision = await router.route({ taskKind });
      expect(decision.clientName).toBe("CopilotProxyGpt5Mini");
      expect(decision.model).toBe("gpt-5-mini");
    }

    const persona = await router.route({ taskKind: RouteTaskKind.PERSONA });
    expect(persona.model).toBe("gpt-5-mini");
  });

  it("exposes a smoke policy with gpt-5-mini for all task kinds", () => {
    for (const decision of Object.values(SMOKE_ROUTING_POLICY)) {
      expect(decision.model).toBe("gpt-5-mini");
    }
  });
});

describe("PolicyModelRouter", () => {
  it("returns the GPT-5 mini client for normalize with no effort override", async () => {
    const router = new PolicyModelRouter();
    const decision = await router.route({ taskKind: RouteTaskKind.NORMALIZE });

    expect(decision.clientName).toBe("CopilotProxyGpt5Mini");
    expect(decision.model).toBe("gpt-5-mini");
    expect(decision.reasoningEffort).toBeUndefined();
    expect(decision.rationale).toMatch(/\S/);
  });

  it("routes assess to GPT-5.4 and report to Opus 4.8", async () => {
    const router = new PolicyModelRouter();
    await expect(router.route({ taskKind: RouteTaskKind.ASSESS })).resolves.toMatchObject({
      clientName: "CopilotProxyGpt54",
      model: "gpt-5.4",
    });
    await expect(router.route({ taskKind: RouteTaskKind.REPORT })).resolves.toMatchObject({
      clientName: "CopilotProxyClaudeOpus48",
      model: "claude-opus-4.8",
    });
  });

  it("routes persona to an SDK model id with no BAML client name", async () => {
    const router = new PolicyModelRouter();
    const decision = await router.route({ taskKind: RouteTaskKind.PERSONA, personaId: "skeptic" });

    expect(decision.clientName).toBeUndefined();
    expect(decision.model).toBe("claude-sonnet-5");
  });

  it("honors a custom policy table", async () => {
    const custom = {
      ...DEFAULT_ROUTING_POLICY,
      [RouteTaskKind.NORMALIZE]: { clientName: "CopilotProxyGrokCodeFast1", model: "grok-code-fast-1", rationale: "override" },
    };
    const router = new PolicyModelRouter(custom);
    await expect(router.route({ taskKind: RouteTaskKind.NORMALIZE })).resolves.toMatchObject({
      clientName: "CopilotProxyGrokCodeFast1",
    });
  });
});

describe("LlmModelRouter", () => {
  it("returns the LLM decision when the call resolves in time", async () => {
    const call: RouteModelCallFn = async () => ({
      clientName: "CopilotProxyGpt54",
      model: "gpt-5.4",
      reasoningEffort: undefined,
      rationale: "capable",
    });
    const router = new LlmModelRouter({ fallback: new PolicyModelRouter(), callRouteModelCall: call });

    await expect(router.route({ taskKind: RouteTaskKind.ASSESS, dynamic: true })).resolves.toMatchObject({
      clientName: "CopilotProxyGpt54",
    });
  });

  it("falls back to policy when the call exceeds the timeout", async () => {
    const call: RouteModelCallFn = (_input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const router = new LlmModelRouter({
      fallback: new PolicyModelRouter(),
      callRouteModelCall: call,
      timeoutMs: 20,
    });

    const decision = await router.route({ taskKind: RouteTaskKind.ASSESS });
    expect(decision.clientName).toBe("CopilotProxyGpt54");
  });

  it("falls back to policy when the call throws", async () => {
    const call: RouteModelCallFn = async () => {
      throw new Error("proxy down");
    };
    const router = new LlmModelRouter({ fallback: new PolicyModelRouter(), callRouteModelCall: call });

    await expect(router.route({ taskKind: RouteTaskKind.NORMALIZE })).resolves.toMatchObject({
      clientName: "CopilotProxyGpt5Mini",
    });
  });

  it("falls back to policy when the LLM returns a client not in the candidates", async () => {
    const call: RouteModelCallFn = async () => ({
      clientName: "CopilotProxyHallucinated",
      model: "made-up",
      rationale: "bad",
    });
    const router = new LlmModelRouter({ fallback: new PolicyModelRouter(), callRouteModelCall: call });

    await expect(router.route({ taskKind: RouteTaskKind.ASSESS, dynamic: true })).resolves.toMatchObject({
      clientName: "CopilotProxyGpt54",
    });
  });

  it("enforces the timeout even when the call ignores the abort signal", async () => {
    // This call never settles and never observes the signal — only the independent timeout
    // (which both aborts and rejects) can rescue it. Proves the sub-5s guarantee does not
    // depend on the underlying call honoring AbortSignal.
    const call: RouteModelCallFn = () => new Promise<never>(() => {});
    const router = new LlmModelRouter({
      fallback: new PolicyModelRouter(),
      callRouteModelCall: call,
      timeoutMs: 20,
    });

    const start = Date.now();
    const decision = await router.route({ taskKind: RouteTaskKind.REPORT });
    expect(decision.clientName).toBe("CopilotProxyClaudeOpus48");
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("clears its timeout timer when the call resolves before the deadline (no leaked timer)", async () => {
    vi.useFakeTimers();
    try {
      const call: RouteModelCallFn = async () => ({
        clientName: "CopilotProxyGpt54",
        model: "gpt-5.4",
        rationale: "fast",
      });
      const router = new LlmModelRouter({
        fallback: new PolicyModelRouter(),
        callRouteModelCall: call,
        timeoutMs: 3500,
      });
      const decision = await router.route({ taskKind: RouteTaskKind.ASSESS, dynamic: true });
      expect(decision.clientName).toBe("CopilotProxyGpt54");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("normalizeRoutingDecision", () => {
  it("coerces null/invalid effort to undefined and fills the model", () => {
    const decision = normalizeRoutingDecision(
      { clientName: "X", model: null, reasoningEffort: "turbo", rationale: null },
      "claude-haiku-4-5",
    );
    expect(decision).toEqual({
      clientName: "X",
      model: "claude-haiku-4-5",
      reasoningEffort: undefined,
      rationale: "",
    });
  });

  it("keeps a valid effort", () => {
    const decision = normalizeRoutingDecision(
      { clientName: "X", model: "m", reasoningEffort: "high", rationale: "r" },
      "fallback",
    );
    expect(decision.reasoningEffort).toBe("high");
  });

  it("canonicalizes BAML client decisions to the registered proxy model id", () => {
    const decision = normalizeRoutingDecision(
      {
        clientName: "CopilotProxyGpt5Mini",
        model: "copilot-proxy-gpt5-mini",
        reasoningEffort: "low",
        rationale: "picked",
      },
      "fallback",
    );
    expect(decision).toMatchObject({
      clientName: "CopilotProxyGpt5Mini",
      model: "gpt-5-mini",
      reasoningEffort: "low",
    });
  });
});

import {
  HybridModelRouter,
  createDefaultModelRouter,
} from "../../src/decision-council/modelRouter.js";

describe("HybridModelRouter", () => {
  it("uses policy for static requests without calling the LLM", async () => {
    let llmCalls = 0;
    const llm = {
      async route() {
        llmCalls += 1;
        return { clientName: "CopilotProxyGrokCodeFast1", model: "grok-code-fast-1", rationale: "x" };
      },
    };
    const router = new HybridModelRouter({ policy: new PolicyModelRouter(), llm });

    const decision = await router.route({ taskKind: RouteTaskKind.NORMALIZE });
    expect(decision.clientName).toBe("CopilotProxyGpt5Mini");
    expect(llmCalls).toBe(0);
  });

  it("consults the LLM for dynamic requests and caches by task + summary", async () => {
    let llmCalls = 0;
    const llm = {
      async route() {
        llmCalls += 1;
        return { clientName: "CopilotProxyGrokCodeFast1", model: "grok-code-fast-1", rationale: "x" };
      },
    };
    const router = new HybridModelRouter({ policy: new PolicyModelRouter(), llm });

    await router.route({ taskKind: RouteTaskKind.ASSESS, summary: "same", dynamic: true });
    await router.route({ taskKind: RouteTaskKind.ASSESS, summary: "same", dynamic: true });
    expect(llmCalls).toBe(1);
  });

  it("falls back to policy for dynamic requests when no LLM router is configured", async () => {
    const router = new HybridModelRouter({ policy: new PolicyModelRouter() });
    await expect(router.route({ taskKind: RouteTaskKind.REPORT, dynamic: true })).resolves.toMatchObject({
      clientName: "CopilotProxyClaudeOpus48",
    });
  });
});

describe("createDefaultModelRouter", () => {
  it("returns a router that resolves static decisions from policy", async () => {
    const router = createDefaultModelRouter(async () => {
      throw new Error("LLM should not be called for static requests");
    });
    await expect(router.route({ taskKind: RouteTaskKind.NORMALIZE })).resolves.toMatchObject({
      clientName: "CopilotProxyGpt5Mini",
    });
  });
});
