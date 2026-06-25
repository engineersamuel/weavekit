import { ClientRegistry } from "@boundaryml/baml";
import type { RoutingDecision } from "./modelRouter.js";

export type BamlEnv = { baseUrl?: string; apiKey?: string };

export type BamlRouteOptions = { client?: string; clientRegistry?: ClientRegistry };

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

  if (decision.reasoningEffort && env.baseUrl) {
    const registry = new ClientRegistry();
    registry.addLlmClient("RoutedDecisionClient", "openai-generic", {
      base_url: env.baseUrl,
      api_key: env.apiKey ?? "",
      model: decision.model,
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
