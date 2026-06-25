import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_POLICY,
  PolicyModelRouter,
} from "../../src/decision-council/modelRouter.js";
import {
  LlmModelRouter,
  normalizeRoutingDecision,
  type RouteModelCallFn,
} from "../../src/decision-council/modelRouter.js";

describe("PolicyModelRouter", () => {
  it("returns the fast Haiku client for normalize with no effort override", async () => {
    const router = new PolicyModelRouter();
    const decision = await router.route({ taskKind: "normalize" });

    expect(decision.clientName).toBe("CopilotProxyClaudeHaiku45");
    expect(decision.reasoningEffort).toBeUndefined();
    expect(decision.rationale).toMatch(/\S/);
  });

  it("routes assess and report to the Sonnet judge client", async () => {
    const router = new PolicyModelRouter();
    await expect(router.route({ taskKind: "assess" })).resolves.toMatchObject({
      clientName: "CopilotProxyClaudeSonnet46",
    });
    await expect(router.route({ taskKind: "report" })).resolves.toMatchObject({
      clientName: "CopilotProxyClaudeSonnet46",
    });
  });

  it("routes persona to an SDK model id with no BAML client name", async () => {
    const router = new PolicyModelRouter();
    const decision = await router.route({ taskKind: "persona", personaId: "skeptic" });

    expect(decision.clientName).toBeUndefined();
    expect(decision.model).toBe("claude-sonnet-4.5");
  });

  it("honors a custom policy table", async () => {
    const custom = {
      ...DEFAULT_ROUTING_POLICY,
      normalize: { clientName: "CopilotProxyGrokCodeFast1", model: "grok-code-fast-1", rationale: "override" },
    };
    const router = new PolicyModelRouter(custom);
    await expect(router.route({ taskKind: "normalize" })).resolves.toMatchObject({
      clientName: "CopilotProxyGrokCodeFast1",
    });
  });
});

describe("LlmModelRouter", () => {
  it("returns the LLM decision when the call resolves in time", async () => {
    const call: RouteModelCallFn = async () => ({
      clientName: "CopilotProxyGrokCodeFast1",
      model: "grok-code-fast-1",
      reasoningEffort: undefined,
      rationale: "fast",
    });
    const router = new LlmModelRouter({ fallback: new PolicyModelRouter(), callRouteModelCall: call });

    await expect(router.route({ taskKind: "assess", dynamic: true })).resolves.toMatchObject({
      clientName: "CopilotProxyGrokCodeFast1",
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

    const decision = await router.route({ taskKind: "assess" });
    expect(decision.clientName).toBe("CopilotProxyClaudeSonnet46");
  });

  it("falls back to policy when the call throws", async () => {
    const call: RouteModelCallFn = async () => {
      throw new Error("proxy down");
    };
    const router = new LlmModelRouter({ fallback: new PolicyModelRouter(), callRouteModelCall: call });

    await expect(router.route({ taskKind: "normalize" })).resolves.toMatchObject({
      clientName: "CopilotProxyClaudeHaiku45",
    });
  });

  it("falls back to policy when the LLM returns a client not in the candidates", async () => {
    const call: RouteModelCallFn = async () => ({
      clientName: "CopilotProxyHallucinated",
      model: "made-up",
      rationale: "bad",
    });
    const router = new LlmModelRouter({ fallback: new PolicyModelRouter(), callRouteModelCall: call });

    await expect(router.route({ taskKind: "assess", dynamic: true })).resolves.toMatchObject({
      clientName: "CopilotProxyClaudeSonnet46",
    });
  });

  it("enforces the timeout even when the call ignores the abort signal", async () => {
    // This call never settles and never observes the signal — only the independent
    // rejectAfter race can rescue it. Proves the sub-5s guarantee does not depend on
    // the underlying call honoring AbortSignal.
    const call: RouteModelCallFn = () => new Promise<never>(() => {});
    const router = new LlmModelRouter({
      fallback: new PolicyModelRouter(),
      callRouteModelCall: call,
      timeoutMs: 20,
    });

    const start = Date.now();
    const decision = await router.route({ taskKind: "report" });
    expect(decision.clientName).toBe("CopilotProxyClaudeSonnet46");
    expect(Date.now() - start).toBeLessThan(500);
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
});
