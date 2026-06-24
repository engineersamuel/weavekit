export const version = "0.0.0";

export type {
  CouncilInput,
  CouncilReport,
  CouncilRunState,
  PersonaDefinition,
  PersonaSet,
} from "./council/types.js";
export { defaultPersonaSet, resolvePersonaSet } from "./council/personas.js";
export { runCouncil, type RunCouncilOptions } from "./council/runner.js";
