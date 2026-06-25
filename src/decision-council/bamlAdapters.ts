import { b } from "../generated/baml_client/index.js";
import {
  CouncilReportSchema,
  PersonaCritiqueSchema,
  RoundAssessmentSchema,
  type CouncilReport,
  type PersonaCritique,
  type PersonaFailure,
  type RawPersonaResult,
  type RoundAssessment,
} from "./types.js";

export type CritiqueNormalizer = {
  normalizeCritique(raw: RawPersonaResult): Promise<PersonaCritique>;
};

export type JudgeReducer = {
  assessRound(args: {
    roundNumber: number;
    critiques: PersonaCritique[];
    failures: PersonaFailure[];
  }): Promise<RoundAssessment>;
  createFinalReport(args: {
    critiques: PersonaCritique[];
    assessments: RoundAssessment[];
    failures: PersonaFailure[];
  }): Promise<CouncilReport>;
};

export class GeneratedBamlAdapters implements CritiqueNormalizer, JudgeReducer {
  async normalizeCritique(raw: RawPersonaResult): Promise<PersonaCritique> {
    const result = await b.NormalizePersonaCritique({
      personaId: raw.personaId,
      text: raw.text,
    });
    return PersonaCritiqueSchema.parse(result);
  }

  async assessRound(args: {
    roundNumber: number;
    critiques: PersonaCritique[];
    failures: PersonaFailure[];
  }): Promise<RoundAssessment> {
    const result = await b.AssessCouncilRound(args.roundNumber, args.critiques, args.failures);
    return RoundAssessmentSchema.parse(result);
  }

  async createFinalReport(args: {
    critiques: PersonaCritique[];
    assessments: RoundAssessment[];
    failures: PersonaFailure[];
  }): Promise<CouncilReport> {
    const result = await b.CreateCouncilReport(args.critiques, args.assessments, args.failures);
    return CouncilReportSchema.parse(result);
  }
}
