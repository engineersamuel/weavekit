import { b } from "../generated/baml_client/index.js";
import { createBamlTelemetryOptions, runTracedBamlOperation } from "./bamlTelemetry.js";

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
    clientName: "CopilotProxyGpt54",
    model: "gpt-5.4",
    rationale: "Lowest-TTFT structured extraction default.",
  },
  assess: {
    clientName: "CopilotProxyGpt54",
    model: "gpt-5.4",
    rationale: "Lowest-TTFT Judge decision default.",
  },
  report: {
    clientName: "CopilotProxyGpt55",
    model: "gpt-5.5",
    rationale: "Fast, high-throughput synthesis for the decision-ready report.",
  },
  persona: {
    model: "claude-sonnet-4.5",
    rationale: "Persona debate tier (Copilot SDK model id).",
  },
};

// Smoke policy: pin every task kind to gpt-5-mini for fast integration smoke tests. BAML kinds
// use the CopilotProxyGpt5Mini client (model gpt-5-mini); persona uses the gpt-5-mini SDK model id.
export const SMOKE_ROUTING_POLICY: RoutingPolicy = {
  normalize: {
    clientName: "CopilotProxyGpt5Mini",
    model: "gpt-5-mini",
    rationale: "Smoke: fast structured extraction on gpt-5-mini.",
  },
  assess: {
    clientName: "CopilotProxyGpt5Mini",
    model: "gpt-5-mini",
    rationale: "Smoke: fast Judge decision on gpt-5-mini.",
  },
  report: {
    clientName: "CopilotProxyGpt5Mini",
    model: "gpt-5-mini",
    rationale: "Smoke: fast report synthesis on gpt-5-mini.",
  },
  persona: {
    model: "gpt-5-mini",
    rationale: "Smoke: fast persona debate on gpt-5-mini.",
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

// Router for the smoke path: a pure policy router pinned to gpt-5-mini for personas and BAML calls.
export function createSmokeModelRouter(): ModelRouter {
  return new PolicyModelRouter(SMOKE_ROUTING_POLICY);
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
  normalize: ["CopilotProxyGpt54", "CopilotProxyClaudeHaiku45", "CopilotProxyGrokCodeFast1", "CopilotProxyGpt5Mini"],
  assess: ["CopilotProxyGpt54", "CopilotProxyClaudeSonnet46"],
  report: ["CopilotProxyGpt55", "CopilotProxyClaudeSonnet46", "CopilotProxyClaudeOpus48"],
  persona: ["claude-sonnet-4.5", "claude-sonnet-4.6", "gpt-5.4"],
};

// Canonical proxy model id for each BAML candidate client (mirrors baml_src/clients.baml).
// The effort/registry path in toBamlCallOptions sources the model from the VALIDATED client
// name via this map — never from the LLM router's free-form decision.model — so a hallucinated
// model can never reach the proxy (invariant: only an offered client/model reaches the proxy).
export const BAML_CANDIDATE_CLIENT_MODELS: Record<string, string> = {
  CopilotProxyClaudeHaiku45: "claude-haiku-4-5",
  CopilotProxyGrokCodeFast1: "grok-code-fast-1",
  CopilotProxyGpt5Mini: "gpt-5-mini",
  CopilotProxyClaudeSonnet46: "claude-sonnet-4-6",
  CopilotProxyGpt54: "gpt-5.4",
  CopilotProxyClaudeOpus48: "claude-opus-4-8",
  CopilotProxyGpt55: "gpt-5.5",
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
  // BAML kinds: only clientName is trusted here. The model that actually reaches the proxy is
  // derived from this validated clientName in bamlRouting.toBamlCallOptions
  // (BAML_CANDIDATE_CLIENT_MODELS), never from the free-form decision.model.
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`router timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
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
        timeout,
      ]);
      if (!isValidDecision(decision, request.taskKind, candidates)) {
        return this.fallback.route(request);
      }
      return decision;
    } catch {
      return this.fallback.route(request);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

export class HybridModelRouter implements ModelRouter {
  private readonly policy: ModelRouter;
  private readonly llm?: ModelRouter;
  private readonly cache = new Map<string, RoutingDecision>();

  constructor(args: { policy: ModelRouter; llm?: ModelRouter }) {
    this.policy = args.policy;
    this.llm = args.llm;
  }

  async route(request: RouteRequest): Promise<RoutingDecision> {
    if (!request.dynamic || !this.llm) {
      return this.policy.route(request);
    }
    const key = `${request.taskKind}:${(request.summary ?? "").slice(0, 80)}`;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const decision = await this.llm.route(request);
    this.cache.set(key, decision);
    return decision;
  }
}

// Default production router: policy default + LLM for dynamic intent, the LLM guarded
// by an abort-timeout that falls back to policy. The callRouteModelCall seam is injected
// so the runner can pass the generated b.RouteModelCall wrapper (see bamlAdapters wiring).
export function createDefaultModelRouter(callRouteModelCall?: RouteModelCallFn): ModelRouter {
  const policy = new PolicyModelRouter();
  if (!callRouteModelCall) {
    return new HybridModelRouter({ policy });
  }
  const llm = new LlmModelRouter({ fallback: new PolicyModelRouter(), callRouteModelCall });
  return new HybridModelRouter({ policy, llm });
}

// Production seam: wraps the generated RouteModelCall, passing the abort signal so the
// hard timeout actually cancels the proxy request. The fallback model is the policy model
// for this task kind (a real model id) — NOT input.candidates[0], which for BAML kinds is
// a client name like "CopilotProxyClaudeHaiku45", not a model id.
export const defaultRouteModelCall: RouteModelCallFn = async (input, signal) => {
  return runTracedBamlOperation("route-model-call", input, async () => {
    const raw = await b.RouteModelCall(input.taskKind, input.summary, input.candidates, {
      signal,
      ...createBamlTelemetryOptions(),
    });
    const policyModel = DEFAULT_ROUTING_POLICY[input.taskKind as RouteTaskKind]?.model ?? "claude-haiku-4-5";
    return normalizeRoutingDecision(
      {
        clientName: raw.clientName ?? undefined,
        model: raw.model,
        reasoningEffort: raw.reasoningEffort ?? undefined,
        rationale: raw.rationale,
      },
      policyModel,
    );
  });
};
