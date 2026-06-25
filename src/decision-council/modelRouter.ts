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

export type RouteModelCallInput = {
  taskKind: string;
  summary: string;
  candidates: string[];
};

export type RouteModelCallFn = (
  input: RouteModelCallInput,
  signal: AbortSignal,
) => Promise<RoutingDecision>;

// Candidate client names (BAML kinds) / SDK model ids (persona) offered to the LLM router.
export const ROUTER_CANDIDATES: Record<RouteTaskKind, string[]> = {
  normalize: ["CopilotProxyClaudeHaiku45", "CopilotProxyGrokCodeFast1", "CopilotProxyGpt5Mini"],
  assess: ["CopilotProxyClaudeSonnet46", "CopilotProxyGpt54"],
  report: ["CopilotProxyClaudeSonnet46", "CopilotProxyClaudeOpus48", "CopilotProxyGpt55"],
  persona: ["claude-sonnet-4.5", "claude-sonnet-4.6", "gpt-5.4"],
};

const VALID_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh"]);

export function normalizeRoutingDecision(
  raw: {
    clientName?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    rationale?: string | null;
  },
  fallbackModel: string,
): RoutingDecision {
  const effort = raw.reasoningEffort ?? undefined;
  return {
    clientName: raw.clientName ?? undefined,
    model: raw.model ?? fallbackModel,
    reasoningEffort: effort && VALID_EFFORTS.has(effort) ? (effort as ReasoningEffort) : undefined,
    rationale: raw.rationale ?? "",
  };
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`router timeout after ${ms}ms`)), ms);
  });
}

// A decision is only trusted if it stays within the offered candidates: for the persona
// (SDK) path the model id must be a candidate; for BAML kinds the clientName must be a
// candidate client. Anything else (hallucinated client/model) is rejected -> policy fallback.
export function isValidDecision(
  decision: RoutingDecision,
  taskKind: RouteTaskKind,
  candidates: string[],
): boolean {
  if (!decision.model) {
    return false;
  }
  if (taskKind === "persona") {
    return candidates.includes(decision.model);
  }
  return decision.clientName !== undefined && candidates.includes(decision.clientName);
}

export class LlmModelRouter implements ModelRouter {
  private readonly fallback: ModelRouter;
  private readonly callRouteModelCall: RouteModelCallFn;
  private readonly timeoutMs: number;
  private readonly candidates: Record<RouteTaskKind, string[]>;

  constructor(args: {
    fallback: ModelRouter;
    callRouteModelCall: RouteModelCallFn;
    timeoutMs?: number;
    candidates?: Record<RouteTaskKind, string[]>;
  }) {
    this.fallback = args.fallback;
    this.callRouteModelCall = args.callRouteModelCall;
    this.timeoutMs = args.timeoutMs ?? 3500;
    this.candidates = args.candidates ?? ROUTER_CANDIDATES;
  }

  async route(request: RouteRequest): Promise<RoutingDecision> {
    const candidates = this.candidates[request.taskKind];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const decision = await Promise.race([
        this.callRouteModelCall(
          {
            taskKind: request.taskKind,
            summary: request.summary ?? "",
            candidates,
          },
          controller.signal,
        ),
        rejectAfter(this.timeoutMs),
      ]);
      if (!isValidDecision(decision, request.taskKind, candidates)) {
        return this.fallback.route(request);
      }
      return decision;
    } catch {
      return this.fallback.route(request);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
