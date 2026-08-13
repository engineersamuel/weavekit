import { describe, expect, it } from "vitest";
import { buildRlmCallSpanName, buildRlmRootSpanName } from "../../src/rlm-poc/telemetry.js";

describe("RLM telemetry naming", () => {
  it("names the root by Submind depth and mode", () => {
    expect(buildRlmRootSpanName("rlm-submind")).toBe("SUBMIND d0 · orchestration");
    expect(buildRlmRootSpanName("rlm-poc-validation-scenario")).toBe("SUBMIND d0 · validation");
  });

  it("names recursive calls by ordinal, depth, and profile", () => {
    expect(
      buildRlmCallSpanName({
        profile: "research",
        model: "gpt-5-mini",
        prompt: "Research the topic.",
        depthRemaining: 2,
        maxDepth: 3,
        budget: { maxCalls: 12, usedCalls: 4, remainingCalls: 8 },
      }),
    ).toBe("RLM #5 d2/3 · research");
  });
});
