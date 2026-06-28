import { describe, expect, it } from "vitest";
import {
  PersonaArchetypeSchema,
  PersonaDefinitionSchema,
  PersonaModeSchema,
  PersonaSetSchema,
  PersonaSkillSchema,
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
    expect(persona.selectionHints).toEqual([]);
    expect(persona.selectionAntiHints).toEqual([]);
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
      selectionHints: ["Use for committed case-making and thesis defense."],
      selectionAntiHints: ["Avoid when a neutral synthesis is needed."],
      specRef: "dialectic-advocate.md",
    });

    expect(persona.archetype).toBe("believer");
    expect(persona.modes).toEqual(["believe", "analyze"]);
    expect(persona.selectionHints).toEqual(["Use for committed case-making and thesis defense."]);
    expect(persona.selectionAntiHints).toEqual(["Avoid when a neutral synthesis is needed."]);
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

describe("PersonaSkillSchema", () => {
  it("parses a skill with name and bundle, and defaults installer to claude-superskills", () => {
    const skill = PersonaSkillSchema.parse({
      name: "mckinsey-strategist",
      bundle: "mckinsey",
    });

    expect(skill.name).toBe("mckinsey-strategist");
    expect(skill.bundle).toBe("mckinsey");
    expect(skill.installer).toBe("claude-superskills");
  });

  it("rejects a skill with empty name", () => {
    expect(() => PersonaSkillSchema.parse({ name: "" })).toThrow();
  });
});

describe("PersonaDefinitionSchema with skill", () => {
  it("parses a persona with a skill", () => {
    const persona = PersonaDefinitionSchema.parse({
      id: "strategist",
      name: "McKinsey Strategist",
      description: "Strategic advisor",
      prompt: "Provide strategic advice.",
      skill: {
        name: "mckinsey-strategist",
        bundle: "mckinsey",
      },
    });

    expect(persona.skill).toBeDefined();
    expect(persona.skill?.name).toBe("mckinsey-strategist");
    expect(persona.skill?.bundle).toBe("mckinsey");
    expect(persona.skill?.installer).toBe("claude-superskills");
  });

  it("parses a persona without a skill as undefined", () => {
    const persona = PersonaDefinitionSchema.parse({
      id: "skeptic",
      name: "Skeptic",
      description: "Challenges weak evidence.",
      prompt: "Challenge weak evidence.",
    });

    expect(persona.skill).toBeUndefined();
  });
});
