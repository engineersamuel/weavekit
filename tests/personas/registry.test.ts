import { describe, expect, it } from "vitest";
import {
  buildRegistry,
  defaultRegistry,
  getPersona,
  listPersonas,
} from "../../src/personas/registry.js";

describe("manifest-backed persona registry", () => {
  it("loads personas from the entity catalog", () => {
    const personas = listPersonas();

    expect(personas.length).toBeGreaterThan(0);
    expect(personas.map((persona) => persona.id)).toContain("socratic");
    expect(personas.map((persona) => persona.id)).toContain("mckinsey-strategist");
  });

  it("loads manifest selector fields and prompt prose", () => {
    const persona = getPersona("mckinsey-strategist");

    expect(persona.role).toBe("advisor");
    expect(persona.archetype).toBe("analyst");
    expect(persona.tags).toEqual(["strategic"]);
    expect(persona.useWhen[0]).toMatch(/structured business problem decomposition/i);
    expect(persona.avoidWhen[0]).toMatch(/purely technical architecture reviews/i);
    expect(persona.prompt).toContain("claims");
    expect(persona.prompt).toContain("risks");
    expect(persona.skill).toEqual({ name: "mckinsey-strategist" });
  });

  it("lists personas as clones so callers cannot mutate registry state", () => {
    const personas = listPersonas();
    personas[0]!.name = "Changed";
    personas[0]!.useWhen.push("bad");

    const reloaded = listPersonas();
    expect(reloaded[0]!.name).not.toBe("Changed");
    expect(reloaded[0]!.useWhen).not.toContain("bad");
  });

  it("has no duplicate persona ids", () => {
    const ids = listPersonas().map((persona) => persona.id);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it("ensures each shipped persona has selector-facing manifest metadata", () => {
    for (const persona of listPersonas()) {
      expect(persona.description.trim().length).toBeGreaterThanOrEqual(20);
      expect(persona.useWhen.length).toBeGreaterThan(0);
      expect(persona.avoidWhen.length).toBeGreaterThan(0);
    }
  });

  it("throws a helpful error for an unknown persona", () => {
    expect(() => getPersona("nope")).toThrow(/nope/);
  });

  it("buildRegistry accepts an explicit repo root", () => {
    const registry = buildRegistry(process.cwd());
    expect(registry.getPersona("socratic").name).toBe("Socratic Questioner");
    expect(registry.listPersonas().length).toBe(defaultRegistry.listPersonas().length);
  });
});
