export const version = "0.0.0";

export type {
  DecisionCouncilInput,
  DecisionCouncilReport,
  DecisionCouncilRunState,
  PersonaDefinition,
  PersonaSet,
} from "./decision-council/types.js";
export { defaultPersonaSet, gameTheorist, personaSetRegistry, resolvePersonaSet, resolvePersonaSetByName, strategicPersonaSet, sunTzu } from "./decision-council/personas.js";
export { runDecisionCouncil, type RunDecisionCouncilOptions } from "./decision-council/runner.js";
export { type DecisionCouncilWorkflowDeps } from "./decision-council/workflow.js";
export { createDecisionCouncilWorkflow, type DecisionCouncilFlueOptions } from "./flue/decisionCouncilWorkflowDefinition.js";
export {
  createConfiguredDecisionCouncilWorkflow,
  type ConfiguredDecisionCouncilWorkflowOptions,
} from "./flue/decisionCouncilWorkflow.js";

// Reusable, workflow-agnostic persona subsystem.
export {
  composePersonaPrompt,
  createBamlPersonaSelector,
  createStaticPersonaSelector,
  getPersona,
  getPersonaSet,
  listPersonas,
  listPersonaSets,
  PersonaArchetypeSchema,
  PersonaModeSchema,
} from "./personas/index.js";
export type {
  PersonaArchetype,
  PersonaMode,
  PersonaSelectorEvent,
  PersonaSelectionInput,
  PersonaSelectionResult,
  PersonaSelector,
} from "./personas/index.js";
export * from "./work-queue/index.js";
