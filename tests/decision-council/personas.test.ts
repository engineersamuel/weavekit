import { describe, expect, it } from "vitest";
import { defaultPersonaSet, resolvePersonaSet } from "../../src/council/personas.js";

describe("persona sets", () => {
  it("ships the approved default debating personas", () => {
    expect(defaultPersonaSet.name).toBe("default");
    expect(defaultPersonaSet.personas.map((persona) => persona.name)).toEqual([
      "Socratic Questioner",
      "Deep Module/DRY Architect",
      "Pragmatic Builder",
      "Skeptic",
    ]);
  });

  it("copies a supplied persona set so callers cannot mutate defaults", () => {
    const resolved = resolvePersonaSet(defaultPersonaSet);
    resolved.personas[0]!.name = "Changed";

    expect(defaultPersonaSet.personas[0]!.name).toBe("Socratic Questioner");
  });
});
