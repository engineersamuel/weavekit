import { describe, expect, it } from "vitest";
import { parseEntityCliArgs } from "../src/cli.js";

describe("entity CLI", () => {
  it("parses entity validate", () => {
    expect(parseEntityCliArgs(["entity", "validate"])).toEqual({ command: "validate" });
  });

  it("rejects unknown entity command", () => {
    expect(() => parseEntityCliArgs(["entity", "list"])).toThrow("Usage: weavekit entity validate");
  });
});
