export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type RouteTaskKind = "normalize" | "assess" | "report" | "persona";

export type RouteRequest = {
  taskKind: RouteTaskKind;
  summary?: string;
  roundNumber?: number;
  personaId?: string;
  /** When true, a HybridModelRouter consults the fast LLM router instead of policy. */
  dynamic?: boolean;
};

export type RoutingDecision = {
  /** A clients.baml client name for BAML calls. Undefined for the Copilot SDK path. */
  clientName?: string;
  /** Concrete model id: a proxy model id for BAML effort routing, or an SDK model id for personas. */
  model: string;
  reasoningEffort?: ReasoningEffort;
  rationale: string;
};

export interface ModelRouter {
  route(request: RouteRequest): Promise<RoutingDecision>;
}

export type RoutingPolicy = Record<RouteTaskKind, RoutingDecision>;

// Defaults from research §6.1. BAML kinds use client-name swap only (no effort) by
// default; effort passthrough is opt-in pending proxy verification (research §8.2).
// The persona default keeps today's SDK model so behavior is unchanged until tuned.
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  normalize: {
    clientName: "CopilotProxyClaudeHaiku45",
    model: "claude-haiku-4-5",
    rationale: "Fast, cheap structured extraction; non-reasoning Haiku.",
  },
  assess: {
    clientName: "CopilotProxyClaudeSonnet46",
    model: "claude-sonnet-4-6",
    rationale: "Mid-reasoning Judge decision.",
  },
  report: {
    clientName: "CopilotProxyClaudeSonnet46",
    model: "claude-sonnet-4-6",
    rationale: "Strong synthesis for the decision-ready report.",
  },
  persona: {
    model: "claude-sonnet-4.5",
    rationale: "Persona debate tier (Copilot SDK model id).",
  },
};

export class PolicyModelRouter implements ModelRouter {
  private readonly policy: RoutingPolicy;

  constructor(policy: RoutingPolicy = DEFAULT_ROUTING_POLICY) {
    this.policy = policy;
  }

  async route(request: RouteRequest): Promise<RoutingDecision> {
    return this.policy[request.taskKind];
  }
}
