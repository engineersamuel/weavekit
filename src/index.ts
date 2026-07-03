export const version = "0.0.0";

export type {
  DecisionCouncilInput,
  DecisionCouncilReport,
  DecisionCouncilRunState,
  PersonaDefinition,
} from "./decision-council/types.js";
export { runDecisionCouncil, type RunDecisionCouncilOptions } from "./decision-council/runner.js";
export { type DecisionCouncilWorkflowDeps } from "./decision-council/workflow.js";
export * from "./entities/index.js";
export * from "./macro-workflow/index.js";
export {
  Classifier,
  createInitialWorkflowRouter,
  createInitialWorkflowRouter as createInitialRouter,
  InitialWorkflowRouter,
  HeuristicRouteScorer,
  type InitialRouter,
  type InitialRouterInput,
  type RouteDecision,
  type RouteScorer,
  type RouteScore,
  type WorkflowRouteKind,
} from "./initialRouter.js";
export { createDecisionCouncilWorkflow, type DecisionCouncilFlueOptions } from "./flue/decisionCouncilWorkflowDefinition.js";
export {
  createConfiguredDecisionCouncilWorkflow,
  type ConfiguredDecisionCouncilWorkflowOptions,
} from "./flue/decisionCouncilWorkflow.js";

// Reusable, workflow-agnostic persona subsystem.
export {
  composePersonaPrompt,
  createBamlPersonaSelector,
  getPersona,
  listPersonas,
  PersonaArchetypeSchema,
} from "./personas/index.js";
export type {
  PersonaArchetype,
  PersonaSelectorEvent,
  PersonaSelectionInput,
  PersonaSelectionResult,
  PersonaSelector,
} from "./personas/index.js";
