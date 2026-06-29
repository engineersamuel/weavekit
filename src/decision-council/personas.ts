import {
  getPersona,
  getPersonaSet,
  resolvePersonaSet,
  resolvePersonaSetByName,
} from "../personas/index.js";
import type { PersonaDefinition, PersonaSet } from "../personas/index.js";

export { resolvePersonaSet, resolvePersonaSetByName };

export const defaultPersonaSet: PersonaSet = getPersonaSet("default");
export const strategicPersonaSet: PersonaSet = getPersonaSet("strategic");
export const gameTheorist: PersonaDefinition = getPersona("strategic-game-theorist");
export const sunTzu: PersonaDefinition = getPersona("sun-tzu");
export const mckinseyStrategist: PersonaDefinition = getPersona("mckinsey-strategist");

export const personaSetRegistry: Record<string, PersonaSet> = {
  default: defaultPersonaSet,
  strategic: strategicPersonaSet,
  dialectic: getPersonaSet("dialectic"),
  smoke: getPersonaSet("smoke"),
};
