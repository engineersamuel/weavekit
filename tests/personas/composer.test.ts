import { describe, expect, it } from "vitest";
import { composePersonaPrompt } from "../../src/personas/composer.js";
import { PersonaDefinitionSchema, type RoundBrief } from "../../src/personas/schema.js";

const brief: RoundBrief = { roundNumber: 1, prompt: "Should we use Flue?", focus: "Initial critique" };

// Byte-for-byte reference: the legacy buildPersonaPrompt output the composer must preserve
// for a flat persona (no structured cognitive fields, no mode).
function legacyPrompt(name: string, prompt: string, b: RoundBrief): string {
  return [
    `You are ${name}.`,
    "",
    prompt,
    "",
    `Round ${b.roundNumber}`,
    `Focus: ${b.focus}`,
    "",
    "Design/question:",
    b.prompt,
    "",
    "Return a concise critique with claims, risks, questions, and recommendations.",
  ].join("\n");
}

describe("composePersonaPrompt", () => {
  it("is byte-identical to the legacy prompt for a flat persona", () => {
    const persona = PersonaDefinitionSchema.parse({
      id: "skeptic",
      name: "Skeptic",
      description: "Challenges weak evidence.",
      prompt: "Challenge weak evidence.",
    });

    expect(composePersonaPrompt(persona, { brief })).toBe(
      legacyPrompt("Skeptic", "Challenge weak evidence.", brief),
    );
  });

  it("includes stance, framing, anti-hedging, ignores, and mode in order", () => {
    const persona = PersonaDefinitionSchema.parse({
      id: "dialectic-advocate",
      name: "Dialectic Advocate",
      description: "Believes the proposal is sound.",
      prompt: "Make the committed case.",
      stance: "This proposal is sound.",
      framingCorrections: ["Not naive boosterism."],
      antiHedging: "Do not hedge.",
      ignores: ["Cost framing — defer to the Adversary."],
    });

    const out = composePersonaPrompt(persona, { mode: "believe", brief });

    expect(out).toContain("You hold this position with full conviction: This proposal is sound.");
    expect(out).toContain("Framing corrections:");
    expect(out).toContain("- Not naive boosterism.");
    expect(out).toContain("Do not hedge.");
    expect(out).toContain("Stay in your lane");
    expect(out).toContain("- Cost framing — defer to the Adversary.");
    expect(out).toContain("Operate in BELIEVE mode per your specification.");

    expect(out.indexOf("full conviction")).toBeLessThan(out.indexOf("Make the committed case."));
    expect(out.indexOf("Make the committed case.")).toBeLessThan(out.indexOf("Operate in BELIEVE"));
    expect(out.indexOf("Operate in BELIEVE")).toBeLessThan(out.indexOf("Round 1"));
  });
});
