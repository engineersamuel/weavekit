import { describe, expect, it } from "vitest";
import { getPersona, listPersonas } from "../../src/personas/index.js";
import { PersonaDefinitionSchema } from "../../src/decision-council/types.js";

describe("manifest-backed council personas", () => {
  it("loads the shipped manifest personas", () => {
    expect(listPersonas().map((persona) => persona.id).sort()).toEqual([
      "deep-module-dry",
      "dialectic-adversary",
      "dialectic-advocate",
      "hostile-auditor",
      "mckinsey-strategist",
      "pragmatic",
      "skeptic",
      "socratic",
      "strategic-game-theorist",
      "sun-tzu",
      "synthesist",
    ]);
  });

  it("loads Markdown prompt prose from the entity catalog", () => {
    const pragmatic = PersonaDefinitionSchema.parse(getPersona("pragmatic"));

    expect(pragmatic.prompt).toBe(
      "You are the Pragmatic Builder. Identify the smallest useful next experiment, implementation slice, or prototype that would validate the design.",
    );
    expect(pragmatic.useWhen).toEqual([
      "Use for defining minimal experiments, incremental delivery plans, and practical next actions.",
    ]);
  });

  it("keeps strategic personas and skill provenance available by id", () => {
    const gameTheorist = PersonaDefinitionSchema.parse(getPersona("strategic-game-theorist"));
    const sunTzu = PersonaDefinitionSchema.parse(getPersona("sun-tzu"));
    const mckinseyStrategist = PersonaDefinitionSchema.parse(getPersona("mckinsey-strategist"));

    expect(gameTheorist.prompt).toContain("claims");
    expect(sunTzu.prompt).toContain("recommendations");
    expect(mckinseyStrategist.skill?.name).toBe("mckinsey-strategist");
  });

  it("returns clones so callers cannot mutate the registry", () => {
    const personas = listPersonas();
    personas[0]!.useWhen.push("bad");

    expect(listPersonas()[0]!.useWhen).not.toContain("bad");
  });
});
