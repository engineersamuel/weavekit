import { PersonaSetSchema, type PersonaSet } from "./types.js";

export const defaultPersonaSet: PersonaSet = PersonaSetSchema.parse({
  name: "default",
  personas: [
    {
      id: "socratic",
      name: "Socratic Questioner",
      description: "Surfaces hidden assumptions, missing definitions, and questions the design has not answered.",
    },
    {
      id: "deep-module-dry",
      name: "Deep Module/DRY Architect",
      description: "Critiques seams, interfaces, duplication, module depth, leverage, and locality.",
    },
    {
      id: "pragmatic",
      name: "Pragmatic Builder",
      description: "Finds the smallest executable next step and guards against overbuilding.",
    },
    {
      id: "skeptic",
      name: "Skeptic",
      description: "Looks for failure modes, weak evidence, overconfidence, and hidden costs.",
    },
  ],
});

export function resolvePersonaSet(personaSet: PersonaSet = defaultPersonaSet): PersonaSet {
  return PersonaSetSchema.parse(structuredClone(personaSet));
}
