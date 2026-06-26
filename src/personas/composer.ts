import type { PersonaDefinition, PersonaMode, RoundBrief } from "./schema.js";

export interface ComposeOptions {
  brief: RoundBrief;
  mode?: PersonaMode;
}

/**
 * Assembles the per-round message for a persona. Only the sections present on the
 * persona are emitted; a flat persona (no stance/framing/anti-hedging/ignores/mode)
 * composes byte-identically to the legacy buildPersonaPrompt.
 */
export function composePersonaPrompt(persona: PersonaDefinition, options: ComposeOptions): string {
  const { brief, mode } = options;
  const lines: string[] = [`You are ${persona.name}.`];

  if (persona.stance) {
    lines.push("", `You hold this position with full conviction: ${persona.stance}`);
  }

  if (persona.framingCorrections.length > 0) {
    lines.push("", "Framing corrections:");
    for (const correction of persona.framingCorrections) {
      lines.push(`- ${correction}`);
    }
  }

  lines.push("", persona.prompt);

  if (persona.antiHedging) {
    lines.push("", persona.antiHedging);
  }

  if (persona.ignores.length > 0) {
    lines.push("", "Stay in your lane — defer these to other personas; do not critique them:");
    for (const ignored of persona.ignores) {
      lines.push(`- ${ignored}`);
    }
  }

  if (mode) {
    lines.push("", `Operate in ${mode.toUpperCase()} mode per your specification.`);
  }

  lines.push("", `Round ${brief.roundNumber}`, `Focus: ${brief.focus}`);
  lines.push("", "Design/question:", brief.prompt);
  lines.push("", "Return a concise critique with claims, risks, questions, and recommendations.");

  return lines.join("\n");
}
