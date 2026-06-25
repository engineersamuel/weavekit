import { b } from "../generated/baml_client/index.js";
import {
  DecisionCouncilReportSchema,
  DecisionPersonaCritiqueSchema,
  DecisionRoundAssessmentSchema,
  type DecisionCouncilReport,
  type DecisionPersonaCritique,
  type DecisionPersonaFailure,
  type RawPersonaResult,
  type DecisionRoundAssessment,
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
    const result = await b.NormalizePersonaCritique({
      personaId: raw.personaId,
      text: raw.text,
    });
    return DecisionPersonaCritiqueSchema.parse(result);
  }

  async assessRound(args: {
    roundNumber: number;
    critiques: DecisionPersonaCritique[];
    failures: DecisionPersonaFailure[];
  }): Promise<DecisionRoundAssessment> {
    const result = await b.AssessCouncilRound(args.roundNumber, args.critiques, args.failures);
    return DecisionRoundAssessmentSchema.parse(result);
  }

  async createFinalReport(args: {
    critiques: DecisionPersonaCritique[];
    assessments: DecisionRoundAssessment[];
    failures: DecisionPersonaFailure[];
  }): Promise<DecisionCouncilReport> {
    const result = await b.CreateCouncilReport(args.critiques, args.assessments, args.failures);
    return DecisionCouncilReportSchema.parse(result);
  }
}
