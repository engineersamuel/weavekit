import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_POLICY,
  PolicyModelRouter,
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
