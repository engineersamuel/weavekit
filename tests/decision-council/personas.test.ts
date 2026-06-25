import { describe, expect, it } from "vitest";
import {
  defaultPersonaSet,
  gameTheorist,
  resolvePersonaSet,
  resolvePersonaSetByName,
  strategicPersonaSet,
} from "../../src/decision-council/personas.js";
import { PersonaDefinitionSchema, PersonaSetSchema } from "../../src/decision-council/types.js";

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

describe("strategic persona set", () => {
  it("defines a game theorist persona with council normalization lists", () => {
    const parsed = PersonaDefinitionSchema.parse(gameTheorist);

    expect(parsed.id).toBe("game-theorist");
    expect(parsed.prompt).toContain("claims");
    expect(parsed.prompt).toContain("risks");
    expect(parsed.prompt).toContain("questions");
    expect(parsed.prompt).toContain("recommendations");
  });

  it("extends the default council with the strategic game theorist", () => {
    const parsed = PersonaSetSchema.parse(strategicPersonaSet);

    expect(parsed.name).toBe("strategic");
    expect(parsed.personas).toHaveLength(5);
    expect(parsed.personas.some((persona) => persona.id === "game-theorist")).toBe(true);
    expect(parsed.personas.slice(0, 4).map((persona) => persona.id)).toEqual(defaultPersonaSet.personas.map((persona) => persona.id));
  });

  it("resolves the strategic persona set by name", () => {
    const resolved = resolvePersonaSetByName("strategic");

    expect(resolved.name).toBe("strategic");
    expect(resolved.personas).toHaveLength(5);
  });

  it("resolves default persona sets by name or absence", () => {
    expect(resolvePersonaSetByName("default")).toMatchObject({
      name: "default",
      personas: expect.arrayContaining(defaultPersonaSet.personas),
    });
    expect(resolvePersonaSetByName("default").personas).toHaveLength(4);
    expect(resolvePersonaSetByName(undefined).name).toBe("default");
    expect(resolvePersonaSetByName(undefined).personas).toHaveLength(4);
  });

  it("rejects unknown persona set names", () => {
    expect(() => resolvePersonaSetByName("nonexistent")).toThrow(/nonexistent/);
  });
});
