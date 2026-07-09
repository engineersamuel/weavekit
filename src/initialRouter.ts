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

export type InitialRouterInput = {
  prompt: string;
  context?: string;
};

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

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
}

function countMatches(text: string, terms: readonly string[]): number {
  return terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
}

export class HeuristicRouteScorer implements RouteScorer {
  async score(input: InitialRouterInput): Promise<RouteScore[]> {
    const combined = [input.prompt, input.context ?? ""].join(" ");
    const text = normalizeText(combined);
    const words = text.split(/\s+/).filter(Boolean);

    const scores: Record<WorkflowRouteKind, { score: number; reasons: string[] }> = {
      [Classifier.DIRECT]: { score: 0, reasons: [] },
      [Classifier.PLAN]: { score: 0, reasons: [] },
      [Classifier.RESEARCH]: { score: 0, reasons: [] },
      [Classifier.DECISION_COUNCIL]: { score: 0, reasons: [] },
      [Classifier.ELICITATION]: { score: 0, reasons: [] },
    };

    const addPoint = (kind: WorkflowRouteKind, amount: number, reason: string) => {
      scores[kind].score += amount;
      scores[kind].reasons.push(reason);
    };

    const decisionTerms = [
      "decision",
      "decide",
      "recommend",
      "recommendation",
      "tradeoff",
      "trade-offs",
      "option",
      "options",
      "choose",
      "choice",
      "should we",
      "which",
      "pros",
      "cons",
      "architecture",
      "strategy",
      "direction",
    ];
    const researchTerms = [
      "research",
      "investigate",
      "explore",
      "compare",
      "comparison",
      "analyze",
      "analysis",
      "evidence",
      "sources",
      "source",
      "latest",
      "current",
      "benchmark",
      "background",
      "find",
      "inspect",
    ];
    const planningTerms = [
      "plan",
      "planning",
      "roadmap",
      "blueprint",
      "implementation",
      "steps",
      "milestones",
      "timeline",
      "workflow",
      "sequence",
      "phases",
      "strategy",
      "break down",
      "breakdown",
      "outline",
    ];
    const elicitationTerms = [
      "unclear",
      "ambiguous",
      "need more context",
      "need context",
      "need more information",
      "more information",
      "what is the goal",
      "what should",
      "help me",
      "i need help",
      "unknown",
    ];

    if (countMatches(text, decisionTerms) > 0) {
      addPoint(
        Classifier.DECISION_COUNCIL,
        4,
        "The prompt asks for a decision, recommendation, or trade-off analysis.",
      );
    }
    if (countMatches(text, researchTerms) > 0) {
      addPoint(
        Classifier.RESEARCH,
        4,
        "The prompt asks for investigation, comparison, or evidence gathering.",
      );
    }
    if (countMatches(text, planningTerms) > 0) {
      addPoint(
        Classifier.PLAN,
        4,
        "The prompt is framed around decomposition into steps or milestones.",
      );
    }
    if (countMatches(text, elicitationTerms) > 0) {
      addPoint(
        Classifier.ELICITATION,
        4,
        "The prompt is underspecified enough that the next step should clarify assumptions.",
      );
    }

    if (words.length >= 40) {
      addPoint(
        Classifier.PLAN,
        2,
        "The prompt is long and structured enough that planning is likely the best first move.",
      );
    }
    const isUnderspecified =
      words.length <= 6 &&
      /help|need|unclear|ambiguous|unknown|what|which|should|could|maybe|\?/.test(text);
    if (
      isUnderspecified &&
      !text.includes("plan") &&
      !text.includes("research") &&
      !text.includes("decision") &&
      !text.includes("recommend")
    ) {
      addPoint(
        Classifier.ELICITATION,
        3,
        "The prompt is terse and lacks enough detail for a direct route.",
      );
    }

    if (scores[Classifier.DECISION_COUNCIL].score > 0 && scores[Classifier.PLAN].score > 0) {
      addPoint(
        Classifier.DECISION_COUNCIL,
        1,
        "The prompt combines planning with a choice, which tends to favor a decision-first pass.",
      );
    }
    if (scores[Classifier.RESEARCH].score > 0 && scores[Classifier.PLAN].score > 0) {
      addPoint(
        Classifier.RESEARCH,
        1,
        "The prompt combines planning with evidence gathering, so research may be the better first pass.",
      );
    }

    if (
      scores[Classifier.DECISION_COUNCIL].score === 0 &&
      scores[Classifier.RESEARCH].score === 0 &&
      scores[Classifier.PLAN].score === 0 &&
      scores[Classifier.ELICITATION].score === 0
    ) {
      addPoint(
        Classifier.DIRECT,
        2,
        "The prompt is straightforward and does not contain strong planning, research, or decision cues.",
      );
    }

    return (
      Object.entries(scores) as Array<[WorkflowRouteKind, { score: number; reasons: string[] }]>
    )
      .map(([kind, entry]) => ({
        kind: kind as WorkflowRouteKind,
        score: entry.score,
        reason: entry.reasons.join(" "),
      }))
      .sort((left, right) => right.score - left.score);
  }
}

export class InitialWorkflowRouter implements InitialRouter {
  constructor(private readonly scorer: RouteScorer = new HeuristicRouteScorer()) {}

  async route(input: InitialRouterInput): Promise<RouteDecision> {
    const scores = await this.scorer.score(input);
    const top = scores[0];
    const fallback = scores.find((score) => score.kind === Classifier.DIRECT) ?? scores[0];

    const route = top?.score && top.score >= 3 ? top.kind : fallback.kind;
    const selected = scores.find((score) => score.kind === route) ?? top ?? fallback;
    const decisionRoute = route === Classifier.DIRECT ? Classifier.DIRECT : selected.kind;
    const needsElicitation = decisionRoute === Classifier.ELICITATION;

    return {
      route: decisionRoute,
      score: selected.score,
      rationale:
        selected.reason ||
        "No strong signal was present, so the request falls back to the direct path.",
      consideration: ROUTE_CONSIDERATIONS[decisionRoute],
      needsElicitation,
      scores,
    };
  }
}

export function createInitialWorkflowRouter(
  scorer: RouteScorer = new HeuristicRouteScorer(),
): InitialRouter {
  return new InitialWorkflowRouter(scorer);
}
