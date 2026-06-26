import { describe, expect, it } from "vitest";
import { ROUTER_BENCHMARK_CANDIDATES } from "../../scripts/router-benchmark.js";

describe("router benchmark candidates", () => {
  it("includes the research §5 fast-tier candidates", () => {
    expect(ROUTER_BENCHMARK_CANDIDATES).toEqual(
      expect.arrayContaining([
        "claude-haiku-4.5",
        "grok-code-fast-1",
        "gemini-3-flash-preview",
        "gemini-3.5-flash",
        "gpt-5.4",
        "gpt-5.5",
        "raptor-mini",
      ]),
    );
  });
});
