import { describe, expect, it } from "vitest";
import { createBamlPersonaSelector, validateEntityCatalog } from "../src/index.js";

describe("public exports", () => {
  it("exports entity catalog validation and dynamic persona selection APIs", () => {
    expect(validateEntityCatalog).toBeTypeOf("function");
    expect(createBamlPersonaSelector).toBeTypeOf("function");
  });
});
