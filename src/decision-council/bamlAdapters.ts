import { b } from "../generated/baml_client/index.js";
import { toBamlCallOptions, type BamlEnv, type BamlRouteOptions } from "./bamlRouting.js";
import type { ModelRouter, RouteTaskKind } from "./modelRouter.js";
import {
  DecisionCouncilReportSchema,
  DecisionPersonaCritiqueSchema,
  DecisionRoundAssessmentSchema,
  type DecisionCouncilReport,
  type DecisionPersonaCritique,
  type DecisionPersonaFailure,
  type DecisionRoundAssessment,
  type RawPersonaResult,
} from "./types.js";

export type CritiqueNormalizer = {
  normalizeCritique(raw: RawPersonaResult): Promise<DecisionPersonaCritique>;
};

export type JudgeReducer = {
  assessRound(args: {
    roundNumber: number;
    critiques: DecisionPersonaCritique[];
    failures: DecisionPersonaFailure[];
  }): Promise<DecisionRoundAssessment>;
  createFinalReport(args: {
    critiques: DecisionPersonaCritique[];
    assessments: DecisionRoundAssessment[];
    failures: DecisionPersonaFailure[];
  }): Promise<DecisionCouncilReport>;
};

// Structural seam over the generated client so adapters can be tested without a live proxy.
export type RoutableBamlClient = {
  NormalizePersonaCritique(
    args: { personaId: string; text: string },
    options?: BamlRouteOptions,
  ): Promise<DecisionPersonaCritique>;
  AssessCouncilRound(
    roundNumber: number,
    critiques: DecisionPersonaCritique[],
    failures: DecisionPersonaFailure[],
    options?: BamlRouteOptions,
  ): Promise<DecisionRoundAssessment>;
  CreateCouncilReport(
    critiques: DecisionPersonaCritique[],
    assessments: DecisionRoundAssessment[],
    failures: DecisionPersonaFailure[],
    options?: BamlRouteOptions,
  ): Promise<DecisionCouncilReport>;
};

export class GeneratedBamlAdapters implements CritiqueNormalizer, JudgeReducer {
  private readonly router?: ModelRouter;
  private readonly bamlEnv: BamlEnv;
  private readonly client: RoutableBamlClient;

  constructor(args: { router?: ModelRouter; bamlEnv?: BamlEnv; bamlClient?: RoutableBamlClient } = {}) {
    this.router = args.router;
    this.bamlEnv = args.bamlEnv ?? {
      baseUrl: process.env.COPILOT_PROXY_BASE_URL,
      apiKey: process.env.COPILOT_PROXY_API_KEY,
    };
    this.client = args.bamlClient ?? (b as unknown as RoutableBamlClient);
  }

  private async optionsFor(taskKind: RouteTaskKind, summary?: string): Promise<BamlRouteOptions | undefined> {
    if (!this.router) {
      return undefined;
    }
    const decision = await this.router.route({ taskKind, summary });
    return toBamlCallOptions(decision, this.bamlEnv);
  }

  async normalizeCritique(raw: RawPersonaResult): Promise<DecisionPersonaCritique> {
    const options = await this.optionsFor("normalize", raw.text);
    const result = await this.client.NormalizePersonaCritique(
      { personaId: raw.personaId, text: raw.text },
      options,
    );
    return DecisionPersonaCritiqueSchema.parse(result);
  }

  async assessRound(args: {
    roundNumber: number;
    critiques: DecisionPersonaCritique[];
    failures: DecisionPersonaFailure[];
  }): Promise<DecisionRoundAssessment> {
    const options = await this.optionsFor("assess");
    const result = await this.client.AssessCouncilRound(
      args.roundNumber,
      args.critiques,
      args.failures,
      options,
    );
    return DecisionRoundAssessmentSchema.parse(result);
  }

  async createFinalReport(args: {
    critiques: DecisionPersonaCritique[];
    assessments: DecisionRoundAssessment[];
    failures: DecisionPersonaFailure[];
  }): Promise<DecisionCouncilReport> {
    const options = await this.optionsFor("report");
    const result = await this.client.CreateCouncilReport(
      args.critiques,
      args.assessments,
      args.failures,
      options,
    );
    return DecisionCouncilReportSchema.parse(result);
  }
}
