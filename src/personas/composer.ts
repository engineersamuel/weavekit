import type { PersonaDefinition, RoundBrief } from "./schema.js";

export interface ComposeOptions {
  brief: RoundBrief;
}

export function composePersonaPrompt(persona: PersonaDefinition, options: ComposeOptions): string {
  const { brief } = options;
  return [
    `You are ${persona.name}.`,
    "",
    persona.prompt,
    "",
    `Round ${brief.roundNumber}`,
    `Focus: ${brief.focus}`,
    "",
    "Design/question:",
    brief.prompt,
    "",
    "Return a concise critique with claims, risks, questions, and recommendations.",
  ].join("\n");
}
