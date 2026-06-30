import { b } from "../generated/baml_client/index.js";
import {
  resolveBamlEffortModel,
  toBamlCallOptions,
  type BamlEnv,
  type BamlRouteOptions,
} from "./bamlRouting.js";
import { TraceBamlOperation, createBamlTelemetryOptions, type BamlTelemetryContext } from "./bamlTelemetry.js";
import { RouteTaskKind, type ModelRouter } from "./modelRouter.js";
import {
  DecisionCouncilReportSchema,
  DecisionPersonaCritiqueSchema,
  DecisionRoundAssessmentSchema,
  type DecisionCouncilReport,
  type DecisionPersonaCritique,
  type DecisionPersonaCritiqueSummary,
  type DecisionPersonaFailure,
  type DecisionRoundAssessment,
  type RawPersonaResult,
} from "./types.js";

// Observability hook: the adapter resolves the routed model internally, so it surfaces it via
// this callback (invoked after routing, before the client call) for log decoration. Optional so
// fakes and non-routed callers can ignore it.
export type ModelObserver = (model: string | undefined) => void;

export type CritiqueNormalizer = {
  normalizeCritique(
    raw: RawPersonaResult,
    onModel?: ModelObserver,
  ): Promise<DecisionPersonaCritique>;
};

export type JudgeReducer = {
  assessRound(
    args: {
      roundNumber: number;
      critiques: DecisionPersonaCritique[];
      failures: DecisionPersonaFailure[];
    },
    onModel?: ModelObserver,
  ): Promise<DecisionRoundAssessment>;
  createFinalReport(
    args: {
      critiques: DecisionPersonaCritique[];
      assessments: DecisionRoundAssessment[];
      failures: DecisionPersonaFailure[];
    },
    onModel?: ModelObserver,
  ): Promise<DecisionCouncilReport>;
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
    critiques: DecisionPersonaCritiqueSummary[],
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

  private async resolveRouting(
    taskKind: RouteTaskKind,
    summary?: string,
  ): Promise<{ options: BamlRouteOptions | undefined; model: string | undefined }> {
    if (!this.router) {
      return { options: undefined, model: undefined };
    }
    const decision = await this.router.route({ taskKind, summary });
    // Report only the validated client's canonical model, never the free-form decision.model.
    // When no known client is chosen, toBamlCallOptions returns no override and the call runs
    // against DefaultClient (BAML_MODEL), so report undefined (the log omits model=) rather
    // than a model id the request did not actually use.
    return {
      options: toBamlCallOptions(decision, this.bamlEnv),
      model: resolveBamlEffortModel(decision),
    };
  }

  private withTelemetryOptions(
    options: BamlRouteOptions | undefined,
    telemetryContext: BamlTelemetryContext = {},
  ): BamlRouteOptions {
    const telemetryOptions = createBamlTelemetryOptions(telemetryContext);
    return {
      ...(options ?? {}),
      ...telemetryOptions,
      tags: {
        ...(options?.tags ?? {}),
        ...(telemetryOptions.tags ?? {}),
      },
    };
  }

  @TraceBamlOperation("normalize")
  async normalizeCritique(
    raw: RawPersonaResult,
    onModel?: ModelObserver,
  ): Promise<DecisionPersonaCritique> {
    const { options, model } = await this.resolveRouting(RouteTaskKind.NORMALIZE, raw.text);
    onModel?.(model);
    const result = await this.client.NormalizePersonaCritique(
      { personaId: raw.personaId, text: raw.text },
      this.withTelemetryOptions(options, { personaId: raw.personaId }),
    );
    return DecisionPersonaCritiqueSchema.parse(result);
  }

  @TraceBamlOperation("assess")
  async assessRound(
    args: {
      roundNumber: number;
      critiques: DecisionPersonaCritique[];
      failures: DecisionPersonaFailure[];
    },
    onModel?: ModelObserver,
  ): Promise<DecisionRoundAssessment> {
    const { options, model } = await this.resolveRouting(RouteTaskKind.ASSESS);
    onModel?.(model);
    const result = await this.client.AssessCouncilRound(
      args.roundNumber,
      args.critiques,
      args.failures,
      this.withTelemetryOptions(options, { roundNumber: args.roundNumber }),
    );
    return DecisionRoundAssessmentSchema.parse(result);
  }

  @TraceBamlOperation("report")
  async createFinalReport(
    args: {
      critiques: DecisionPersonaCritique[];
      assessments: DecisionRoundAssessment[];
      failures: DecisionPersonaFailure[];
    },
    onModel?: ModelObserver,
  ): Promise<DecisionCouncilReport> {
    const { options, model } = await this.resolveRouting(RouteTaskKind.REPORT);
    onModel?.(model);
    // Feed only per-persona summaries to the report call. The full critiques (with claims,
    // risks, questions, recommendations) stay authoritative in the run state; sending them
    // verbatim made the report generation large enough to intermittently exceed the proxy
    // timeout. The Judge assessments already carry the cross-persona synthesis.
    const critiqueSummaries: DecisionPersonaCritiqueSummary[] = args.critiques.map((critique) => ({
      personaId: critique.personaId,
      overallSummary: critique.overallSummary,
      summary: critique.summary,
    }));
    const result = await this.client.CreateCouncilReport(
      critiqueSummaries,
      args.assessments,
      args.failures,
      this.withTelemetryOptions(options),
    );
    return DecisionCouncilReportSchema.parse(result);
  }
}
