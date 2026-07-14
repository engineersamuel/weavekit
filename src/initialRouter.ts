import { RouterRoute, createRouter, type Router, type RouterInput } from "./router.js";

export enum Classifier {
  DIRECT = "direct",
  PLAN = "plan",
  RESEARCH = "research",
  DECISION_COUNCIL = "decision-council",
  ELICITATION = "elicitation",
}

export type WorkflowRouteKind = Classifier;

export type RouteScore = {
  kind: WorkflowRouteKind;
  score: number;
  reason: string;
};

export type InitialRouterInput = RouterInput;

export type RouteDecision = {
  route: WorkflowRouteKind;
  score: number;
  rationale: string;
  consideration: string;
  needsElicitation: boolean;
  scores: RouteScore[];
};

export interface RouteScorer {
  score(input: InitialRouterInput): Promise<RouteScore[]>;
}

export interface InitialRouter {
  route(input: InitialRouterInput): Promise<RouteDecision>;
}

export const ROUTE_CONSIDERATIONS: Record<WorkflowRouteKind, string> = {
  [Classifier.DIRECT]:
    "Handle directly when the prompt is narrow and does not need planning, research, multiple perspectives, or extra context.",
  [Classifier.PLAN]:
    "Prefer plan mode when the request is mostly about breaking work into a concrete sequence, milestones, or implementation steps.",
  [Classifier.RESEARCH]:
    "Use deep research when the request depends on current facts, evidence, comparisons, or exploration across sources.",
  [Classifier.DECISION_COUNCIL]:
    "Pass to the decision council when the request needs a recommendation or trade-off analysis across competing options.",
  [Classifier.ELICITATION]:
    "Elicit more information when the prompt is underspecified and the next step needs clarity about goals, constraints, or success criteria.",
};

export class HeuristicRouteScorer implements RouteScorer {
  constructor(private readonly router: Router = createRouter()) {}

  async score(input: InitialRouterInput): Promise<RouteScore[]> {
    const decision = await this.router.route(input);
    return [
      {
        kind: toLegacyRoute(decision.route),
        score: decision.score,
        reason: decision.rationale,
      },
    ];
  }
}

export class InitialWorkflowRouter implements InitialRouter {
  constructor(private readonly router: Router = createRouter()) {}

  async route(input: InitialRouterInput): Promise<RouteDecision> {
    const decision = await this.router.route(input);
    const route = toLegacyRoute(decision.route);
    const scores = [
      {
        kind: route,
        score: decision.score,
        reason: decision.rationale,
      },
    ];
    return {
      route,
      score: decision.score,
      rationale: decision.rationale,
      consideration: ROUTE_CONSIDERATIONS[route],
      needsElicitation: route === Classifier.ELICITATION,
      scores,
    };
  }
}

export function createInitialWorkflowRouter(router: Router = createRouter()): InitialRouter {
  return new InitialWorkflowRouter(router);
}

function toLegacyRoute(route: RouterRoute): WorkflowRouteKind {
  if (route === RouterRoute.PLAN || route === RouterRoute.GOAL_PROMPT) return Classifier.PLAN;
  if (route === RouterRoute.RESEARCH) return Classifier.RESEARCH;
  if (route === RouterRoute.DECISION_COUNCIL) return Classifier.DECISION_COUNCIL;
  if (route === RouterRoute.GRILL_WITH_DOCS) return Classifier.ELICITATION;
  return Classifier.DIRECT;
}
