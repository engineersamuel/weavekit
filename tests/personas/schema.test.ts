import { describe, expect, it } from "vitest";
import {
  PersonaArchetypeSchema,
  PersonaDefinitionSchema,
  PersonaSkillSchema,
} from "../../src/personas/schema.js";

describe("PersonaDefinitionSchema", () => {
  it("parses the manifest-derived persona runtime shape", () => {
    const persona = PersonaDefinitionSchema.parse({
      id: "socratic",
      name: "Socratic Questioner",
      description: "Surfaces hidden assumptions.",
      prompt: "Ask hard questions.",
      role: "advisor",
      archetype: "analyst",
      tags: ["questions"],
      useWhen: ["Use for unclear problem framing."],
      avoidWhen: ["Avoid when implementation is already decided."],
    });

    expect(persona).toEqual({
      id: "socratic",
      name: "Socratic Questioner",
      description: "Surfaces hidden assumptions.",
      prompt: "Ask hard questions.",
      role: "advisor",
      archetype: "analyst",
      tags: ["questions"],
      useWhen: ["Use for unclear problem framing."],
      avoidWhen: ["Avoid when implementation is already decided."],
    });
  });

  it("rejects unknown persona metadata fields", () => {
    expect(() =>
      PersonaDefinitionSchema.parse({
        id: "legacy",
        name: "Legacy",
        description: "Old TOML shape.",
        prompt: "Do old things.",
        role: "advisor",
        tags: [],
        useWhen: [],
        avoidWhen: [],
        unexpected: ["analyze"],
      }),
    ).toThrow();
  });

  it("rejects an unknown archetype", () => {
    expect(() => PersonaArchetypeSchema.parse("cheerleader")).toThrow();
  });

  it("requires manifest selector fields", () => {
    expect(() =>
      PersonaDefinitionSchema.parse({
        id: "x",
        name: "X",
        description: "d",
        prompt: "p",
        role: "advisor",
        tags: [],
      }),
    ).toThrow();
  });
});

describe("PersonaSkillSchema", () => {
  it("parses only the manifest skill name", () => {
    expect(PersonaSkillSchema.parse({ name: "mckinsey-strategist" })).toEqual({
      name: "mckinsey-strategist",
    });
  });

  it("rejects extra skill metadata", () => {
    expect(() =>
      PersonaSkillSchema.parse({
        name: "mckinsey-strategist",
        unexpected: "mckinsey",
      }),
    ).toThrow();
  });
});
