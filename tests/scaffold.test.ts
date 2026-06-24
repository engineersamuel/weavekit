import { describe, expect, it } from "vitest";
import { version } from "../src/index.js";

describe("weavekit scaffold", () => {
  it("exports a version string", () => {
    expect(version).toBe("0.0.0");
  });
});
