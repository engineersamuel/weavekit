import { describe, expect, it } from "vitest";
import { ROUTER_BENCHMARK_CANDIDATES } from "../../scripts/router-benchmark.js";

describe("router benchmark candidates", () => {
  it("includes the research §5 fast-tier candidates", () => {
    expect(ROUTER_BENCHMARK_CANDIDATES).toEqual(
      expect.arrayContaining([
        "claude-haiku-4-5",
        "grok-code-fast-1",
        "gemini-3-flash-preview",
        "raptor-mini",
      ]),
    );
  });
});
