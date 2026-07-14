import type { ApiProvider, ProviderResponse } from "promptfoo";
import { loadLocalEnvFiles, loadTypedWeavekitConfig } from "../src/config.js";
import {
  BamlRouterProvider,
  createHeuristicRouterAdvisor,
  RouterProvider,
} from "../src/eval/providers/router.js";

export type ProviderOptions = {
  id?: string;
  config?: {
    mode?: "deterministic" | "gpt-5-mini";
  };
};

export default class PromptfooRouterProvider implements ApiProvider {
  public readonly config: ProviderOptions["config"];
  private readonly provider: ApiProvider;
  private readonly providerId: string;

  constructor(options: ProviderOptions = {}) {
    loadLocalEnvFiles();
    this.config = options.config ?? {};
    const routerConfig = loadTypedWeavekitConfig().router;
    const mode = this.config.mode ?? "deterministic";
    this.providerId =
      options.id ?? (mode === "gpt-5-mini" ? "router-gpt-5-mini" : "router-deterministic");
    this.provider =
      mode === "gpt-5-mini"
        ? new BamlRouterProvider({
            id: "router-gpt-5-mini",
            clientName: "CopilotProxyGpt5Mini",
            config: routerConfig,
          })
        : new RouterProvider({
            id: "router-deterministic",
            advisor: createHeuristicRouterAdvisor(routerConfig.preferences),
          });
  }

  id(): string {
    return this.providerId;
  }

  callApi(
    prompt: string,
    context?: Parameters<ApiProvider["callApi"]>[1],
  ): Promise<ProviderResponse> {
    return this.provider.callApi(prompt, context);
  }
}
