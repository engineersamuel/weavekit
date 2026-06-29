import { describe, expect, it } from "vitest";
import {
  defaultPersonaSet,
  gameTheorist,
  mckinseyStrategist,
  resolvePersonaSet,
  resolvePersonaSetByName,
  strategicPersonaSet,
  sunTzu,
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

  it("resolves the 2-persona smoke set for fast integration tests", () => {
    const resolved = resolvePersonaSetByName("smoke");
    const parsed = PersonaSetSchema.parse(resolved);

    expect(parsed.name).toBe("smoke");
    expect(parsed.personas).toHaveLength(2);
    expect(parsed.personas.map((persona) => persona.id)).toEqual(["pragmatic", "skeptic"]);
  });
});

describe("strategic persona set", () => {
  it("defines a game theorist persona with council normalization lists", () => {
    const parsed = PersonaDefinitionSchema.parse(gameTheorist);

    expect(parsed.id).toBe("strategic-game-theorist");
    expect(parsed.prompt).toContain("claims");
    expect(parsed.prompt).toContain("risks");
    expect(parsed.prompt).toContain("questions");
    expect(parsed.prompt).toContain("recommendations");
  });

  it("defines a Sun Tzu strategist persona with council normalization lists", () => {
    const parsed = PersonaDefinitionSchema.parse(sunTzu);

    expect(parsed.id).toBe("sun-tzu");
    expect(parsed.archetype).toBe("analyst");
    expect(parsed.prompt).toContain("claims");
    expect(parsed.prompt).toContain("risks");
    expect(parsed.prompt).toContain("questions");
    expect(parsed.prompt).toContain("recommendations");
  });

  it("defines a McKinsey strategist persona with council normalization lists and a skill block", () => {
    const parsed = PersonaDefinitionSchema.parse(mckinseyStrategist);

    expect(parsed.id).toBe("mckinsey-strategist");
    expect(parsed.archetype).toBe("analyst");
    expect(parsed.skill?.name).toBe("mckinsey-strategist");
    expect(parsed.skill?.bundle).toBe("mckinsey");
    expect(parsed.prompt).toContain("McKinsey");
  });

  it("extends the default council with the strategic game theorist and Sun Tzu", () => {
    const parsed = PersonaSetSchema.parse(strategicPersonaSet);

    expect(parsed.name).toBe("strategic");
    expect(parsed.personas).toHaveLength(7);
    expect(parsed.personas.some((persona) => persona.id === "strategic-game-theorist")).toBe(true);
    expect(parsed.personas.some((persona) => persona.id === "sun-tzu")).toBe(true);
    expect(parsed.personas.some((persona) => persona.id === "mckinsey-strategist")).toBe(true);
    expect(parsed.personas.slice(0, 4).map((persona) => persona.id)).toEqual(defaultPersonaSet.personas.map((persona) => persona.id));
  });

  it("resolves the strategic persona set by name", () => {
    const resolved = resolvePersonaSetByName("strategic");

    expect(resolved.name).toBe("strategic");
    expect(resolved.personas).toHaveLength(7);
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
