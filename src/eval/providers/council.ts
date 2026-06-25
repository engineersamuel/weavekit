import type { ApiProvider, ProviderResponse } from "promptfoo";
import { runDecisionCouncil } from "../../index.js";

export interface CouncilProviderDeps {
  run?: typeof runDecisionCouncil;
}

interface CallContext {
  vars?: Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

export class CouncilProvider implements ApiProvider {
  private readonly run: typeof runDecisionCouncil;

  constructor(deps: CouncilProviderDeps = {}) {
    this.run = deps.run ?? runDecisionCouncil;
  }

  id(): string {
    return "weavekit:decision-council";
  }

  async callApi(prompt: string, context?: CallContext): Promise<ProviderResponse> {
    const vars = context?.vars ?? {};
    const input = {
      prompt: String(vars.prompt ?? prompt),
      context: toStringArray(vars.contextItems),
      constraints: toStringArray(vars.constraints),
    };
    try {
      const report = await this.run(input, { deps: { writeArtifacts: false } });
      return {
        output: report.finalReportMarkdown,
        metadata: {
          recommendation: report.recommendation,
          confidence: report.confidence,
          convergence: report.convergence,
          failedPersonas: report.failedPersonas.length,
        },
      };
    } catch (error) {
      return { error: `decision-council failed: ${(error as Error).message}` };
    }
  }
}
