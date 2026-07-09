import { describe, expect, it } from "vitest";
import { composePersonaPrompt } from "../../src/personas/composer.js";
import { PersonaDefinitionSchema, type RoundBrief } from "../../src/personas/schema.js";

const brief: RoundBrief = {
  roundNumber: 1,
  prompt: "Should we use Flue?",
  focus: "Initial critique",
};

function expectedPrompt(name: string, prompt: string, b: RoundBrief): string {
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
  it("composes only persona prompt and round brief fields", () => {
    const persona = PersonaDefinitionSchema.parse({
      id: "skeptic",
      name: "Skeptic",
      description: "Challenges weak evidence.",
      prompt: "Challenge weak evidence.",
      role: "advisor",
      tags: ["review"],
      useWhen: ["Use for critique."],
      avoidWhen: ["Avoid for implementation-only tasks."],
    });

    expect(composePersonaPrompt(persona, { brief })).toBe(
      expectedPrompt("Skeptic", "Challenge weak evidence.", brief),
    );
  });
});
