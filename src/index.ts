export const version = "0.0.0";

export type {
  DecisionCouncilInput,
  DecisionCouncilReport,
  DecisionCouncilRunState,
  PersonaDefinition,
  PersonaSet,
} from "./decision-council/types.js";
export { defaultPersonaSet, resolvePersonaSet } from "./decision-council/personas.js";
export { runCouncil as runDecisionCouncil, type RunCouncilOptions as RunDecisionCouncilOptions } from "./decision-council/runner.js";
export { createCouncilWorkflow as createDecisionCouncilWorkflow, type CouncilWorkflowDeps as DecisionCouncilWorkflowDeps } from "./decision-council/workflow.js";
