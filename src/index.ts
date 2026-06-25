export const version = "0.0.0";

export type {
  DecisionCouncilInput,
  DecisionCouncilReport,
  DecisionCouncilRunState,
  PersonaDefinition,
  PersonaSet,
} from "./decision-council/types.js";
export { defaultPersonaSet, gameTheorist, personaSetRegistry, resolvePersonaSet, resolvePersonaSetByName, strategicPersonaSet } from "./decision-council/personas.js";
export { runDecisionCouncil, type RunDecisionCouncilOptions } from "./decision-council/runner.js";
export { createDecisionCouncilWorkflow, type DecisionCouncilWorkflowDeps } from "./decision-council/workflow.js";
