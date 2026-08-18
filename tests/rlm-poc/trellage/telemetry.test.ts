import { describe, expect, it } from "vitest";
import { buildTrellageResultAttributes } from "../../../src/rlm-poc/trellage/telemetry.js";

describe("Trellage result telemetry", () => {
  it("exports native usage, cost, and bounded tool evidence", () => {
    const attributes = buildTrellageResultAttributes({
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 25,
        cachedInputTokens: 80,
        cacheCreationInputTokens: 10,
      },
      costUsd: 2.16,
      durationMs: 234_402,
      premiumRequests: 3,
      changedFiles: [],
      permissionDenials: [],
      toolUses: [
        { name: "Skill", selector: "council:council", count: 1 },
        { name: "Agent", selector: "council:council-taleb", count: 3 },
      ],
      toolUsesTruncated: false,
    });

    expect(attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 25,
      "gen_ai.usage.cached_input_tokens": 80,
      "weavekit.trellage.usage.cache_creation_input_tokens": 10,
      "weavekit.trellage.cost_usd": 2.16,
      "weavekit.trellage.duration_ms": 234_402,
      "weavekit.trellage.premium_requests": 3,
      "weavekit.trellage.changed_file_count": 0,
      "weavekit.trellage.permission_denial_count": 0,
      "weavekit.trellage.tool_use_count": 4,
      "weavekit.trellage.tool_uses_truncated": false,
    });
    expect(JSON.parse(attributes["langfuse.observation.usage_details"] as string)).toEqual({
      input: 100,
      output: 25,
      cached_input: 80,
      cache_creation_input: 10,
      total: 125,
    });
    expect(JSON.parse(attributes["langfuse.observation.cost_details"] as string)).toEqual({
      total: 2.16,
    });
    expect(JSON.parse(attributes["weavekit.trellage.tool_uses"] as string)).toEqual([
      { name: "Skill", selector: "council:council", count: 1 },
      { name: "Agent", selector: "council:council-taleb", count: 3 },
    ]);
  });

  it("does not invent usage or cost fields", () => {
    expect(buildTrellageResultAttributes({})).toEqual({});
  });
});
