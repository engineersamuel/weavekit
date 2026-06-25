import { b } from "../generated/baml_client/index.js";
import type {
  DecisionCouncilReport,
  DecisionPersonaCritique,
  DecisionPersonaFailure,
  DecisionRoundAssessment,
  RawPersonaResult,
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

export class GeneratedBamlAdapters implements CritiqueNormalizer, JudgeReducer {
  async normalizeCritique(raw: RawPersonaResult): Promise<DecisionPersonaCritique> {
    return b.NormalizePersonaCritique(raw);
  }

  async assessRound(args: {
    roundNumber: number;
    critiques: DecisionPersonaCritique[];
    failures: DecisionPersonaFailure[];
  }): Promise<DecisionRoundAssessment> {
    const result = await b.AssessCouncilRound(args.roundNumber, args.critiques, args.failures);
    return {
      ...result,
      nextRoundBrief: result.nextRoundBrief ?? undefined,
    };
  }

  async createFinalReport(args: {
    critiques: DecisionPersonaCritique[];
    assessments: DecisionRoundAssessment[];
    failures: DecisionPersonaFailure[];
  }): Promise<DecisionCouncilReport> {
    return b.CreateCouncilReport(args.critiques, args.assessments, args.failures);
  }
}
