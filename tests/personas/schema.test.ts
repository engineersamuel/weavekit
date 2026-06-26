import { describe, expect, it } from "vitest";
import {
  PersonaArchetypeSchema,
  PersonaDefinitionSchema,
  PersonaModeSchema,
  PersonaSetSchema,
} from "../../src/personas/schema.js";

describe("PersonaDefinitionSchema", () => {
  it("parses a flat persona and applies array defaults", () => {
    const persona = PersonaDefinitionSchema.parse({
      id: "skeptic",
      name: "Skeptic",
      description: "Challenges weak evidence.",
      prompt: "Challenge weak evidence.",
    });

    expect(persona.framingCorrections).toEqual([]);
    expect(persona.ignores).toEqual([]);
    expect(persona.modes).toEqual([]);
    expect(persona.tags).toEqual([]);
    expect(persona.archetype).toBeUndefined();
    expect(persona.stance).toBeUndefined();
  });

  it("parses a structured persona with all cognitive fields", () => {
    const persona = PersonaDefinitionSchema.parse({
      id: "dialectic-advocate",
      name: "Dialectic Advocate",
      description: "Believes the proposal is sound.",
      prompt: "Make the committed case.",
      archetype: "believer",
      stance: "This proposal is sound.",
      framingCorrections: ["Not naive boosterism."],
      antiHedging: "Do not hedge.",
      ignores: ["Cost framing — defer to the Adversary."],
      modes: ["believe", "analyze"],
      tags: ["dialectic", "thesis"],
      specRef: "dialectic-advocate.md",
    });

    expect(persona.archetype).toBe("believer");
    expect(persona.modes).toEqual(["believe", "analyze"]);
    expect(persona.specRef).toBe("dialectic-advocate.md");
  });

  it("rejects an unknown archetype", () => {
    expect(() => PersonaArchetypeSchema.parse("cheerleader")).toThrow();
  });

  it("rejects an unknown mode", () => {
    expect(() => PersonaModeSchema.parse("vibe")).toThrow();
  });

  it("rejects a persona missing a prompt", () => {
    expect(() => PersonaDefinitionSchema.parse({ id: "x", name: "X", description: "d" })).toThrow();
  });
});

describe("PersonaSetSchema", () => {
  it("requires at least two personas", () => {
    expect(() =>
      PersonaSetSchema.parse({
        name: "lonely",
        personas: [{ id: "a", name: "A", description: "d", prompt: "p" }],
      }),
    ).toThrow();
  });
});
