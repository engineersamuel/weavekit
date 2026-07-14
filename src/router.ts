import { RouterRoute } from "./config.js";
import {
  createHeuristicRouterAdvisor,
  type RouterAdvisor,
  type RouterProviderResult,
} from "./eval/providers/router.js";

export type RouterInput = {
  prompt: string;
  context?: string;
};

export type RouterDecision = RouterProviderResult & {
  score: number;
  needsClarification: boolean;
};

export interface Router {
  route(input: RouterInput): Promise<RouterDecision>;
}

export class WorkflowRouter implements Router {
  constructor(private readonly advisor: RouterAdvisor = createHeuristicRouterAdvisor()) {}

  async route(input: RouterInput): Promise<RouterDecision> {
    const result = await this.advisor.advise(input.prompt, input.context);
    return {
      ...result,
      score: result.confidence,
      needsClarification: result.route === RouterRoute.GRILL_WITH_DOCS,
    };
  }
}

export function createRouter(advisor: RouterAdvisor = createHeuristicRouterAdvisor()): Router {
  return new WorkflowRouter(advisor);
}

export { RouterRoute };
export type { RouterAdvisor, RouterProviderResult };
