import {
  getPersona,
  getPersonaSet,
  resolvePersonaSet,
  resolvePersonaSetByName,
} from "../personas/index.js";
import type { PersonaDefinition, PersonaSet } from "../personas/index.js";

export { resolvePersonaSet, resolvePersonaSetByName };

export enum PersonaSetName {
  DEFAULT = "default",
  STRATEGIC = "strategic",
  DIALECTIC = "dialectic",
  SMOKE = "smoke",
}

export const defaultPersonaSet: PersonaSet = getPersonaSet(PersonaSetName.DEFAULT);
export const strategicPersonaSet: PersonaSet = getPersonaSet(PersonaSetName.STRATEGIC);
export const gameTheorist: PersonaDefinition = getPersona("strategic-game-theorist");
export const sunTzu: PersonaDefinition = getPersona("sun-tzu");
export const mckinseyStrategist: PersonaDefinition = getPersona("mckinsey-strategist");

export const personaSetRegistry: Record<PersonaSetName, PersonaSet> = {
  [PersonaSetName.DEFAULT]: defaultPersonaSet,
  [PersonaSetName.STRATEGIC]: strategicPersonaSet,
  [PersonaSetName.DIALECTIC]: getPersonaSet(PersonaSetName.DIALECTIC),
  [PersonaSetName.SMOKE]: getPersonaSet(PersonaSetName.SMOKE),
};
