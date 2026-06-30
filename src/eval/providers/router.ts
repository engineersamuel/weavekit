import type { ApiProvider, ProviderResponse } from "promptfoo";
import { createInitialWorkflowRouter, type InitialRouter, type InitialRouterInput, type RouteDecision } from "../../initialRouter.js";

export interface RouterProviderOptions {
  router?: InitialRouter;
}

function toContextText(context?: { vars?: Record<string, unknown> }): string | undefined {
  const vars = context?.vars ?? {};
  if (typeof vars.context === "string") {
    return vars.context;
  }
  if (typeof vars.contextItems === "string") {
    return vars.contextItems;
  }
  if (Array.isArray(vars.contextItems)) {
    return vars.contextItems.map((item) => String(item)).join("\n");
  }
  return undefined;
}

function formatDecision(decision: RouteDecision): string {
  return [
    `Route: ${decision.route}`,
    `Score: ${decision.score}`,
    `Rationale: ${decision.rationale}`,
    `Consideration: ${decision.consideration}`,
    `Needs elicitation: ${decision.needsElicitation}`,
  ].join("\n");
}

export class RouterProvider implements ApiProvider {
  private readonly router: InitialRouter;

  constructor(options: RouterProviderOptions = {}) {
    this.router = options.router ?? createInitialWorkflowRouter();
  }

  id(): string {
    return "weavekit:initial-router";
  }

  async callApi(prompt: string, context?: { vars?: Record<string, unknown> }): Promise<ProviderResponse> {
    const vars = context?.vars ?? {};
    const input: InitialRouterInput = {
      prompt: String(vars.prompt ?? vars.question ?? prompt),
      context: toContextText(context),
    };

    try {
      const decision = await this.router.route(input);
      return {
        output: formatDecision(decision),
        metadata: {
          route: decision.route,
          score: decision.score,
          needsElicitation: decision.needsElicitation,
        },
      };
    } catch (error) {
      return { error: `initial-router failed: ${(error as Error).message}` };
    }
  }
}
