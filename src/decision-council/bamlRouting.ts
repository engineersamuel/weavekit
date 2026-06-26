import { ClientRegistry } from "@boundaryml/baml";
import { BAML_CANDIDATE_CLIENT_MODELS, type RoutingDecision } from "./modelRouter.js";

export type BamlEnv = { baseUrl?: string; apiKey?: string };

export type BamlRouteOptions = { client?: string; clientRegistry?: ClientRegistry };

// The proxy model for a BAML effort decision is the canonical model of the chosen, already-
// validated client — NEVER the LLM router's free-form decision.model. Unknown client -> undefined.
export function resolveBamlEffortModel(decision: RoutingDecision): string | undefined {
  return decision.clientName ? BAML_CANDIDATE_CLIENT_MODELS[decision.clientName] : undefined;
}

// Mapping rules (research §3):
//  - No decision -> no override (back-compat: DefaultClient).
//  - Effort requested AND proxy base url known -> dynamic ClientRegistry (mechanism b).
//  - Otherwise -> swap client by name (mechanism a, verified).
export function toBamlCallOptions(
  decision: RoutingDecision | undefined,
  env: BamlEnv = {},
): BamlRouteOptions {
  if (!decision) {
    return {};
  }

  const clientModel = resolveBamlEffortModel(decision);

  // Effort passthrough (mechanism b): only when effort + proxy base url + a KNOWN client.
  // The model comes from the validated client, so a hallucinated decision.model cannot reach
  // the proxy. Unknown client -> skip the registry and fall through to a plain client swap.
  if (decision.reasoningEffort && env.baseUrl && clientModel) {
    const registry = new ClientRegistry();
    registry.addLlmClient("RoutedDecisionClient", "openai-generic", {
      base_url: env.baseUrl,
      api_key: env.apiKey ?? "",
      model: clientModel,
      reasoning_effort: decision.reasoningEffort,
    });
    registry.setPrimary("RoutedDecisionClient");
    return { clientRegistry: registry };
  }

  if (decision.clientName) {
    return { client: decision.clientName };
  }

  return {};
}
