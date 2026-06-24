import { z } from "zod";

export const PersonaDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),
});

export type PersonaDefinition = z.infer<typeof PersonaDefinitionSchema>;

export const PersonaSetSchema = z.object({
  name: z.string().min(1),
  personas: z.array(PersonaDefinitionSchema).min(2),
});

export type PersonaSet = z.infer<typeof PersonaSetSchema>;

export const CouncilInputSchema = z.object({
  prompt: z.string().min(1),
  context: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  personaSetName: z.string().min(1).optional(),
});

export type CouncilInput = z.infer<typeof CouncilInputSchema>;

export const RoundBriefSchema = z.object({
  roundNumber: z.number().int().positive(),
  prompt: z.string().min(1),
  focus: z.string().min(1),
});

export type RoundBrief = z.infer<typeof RoundBriefSchema>;

export const PersonaCritiqueSchema = z.object({
  personaId: z.string().min(1),
  summary: z.string().min(1),
  claims: z.array(z.string().min(1)),
  risks: z.array(z.string().min(1)),
  questions: z.array(z.string().min(1)),
  recommendations: z.array(z.string().min(1)),
});

export type PersonaCritique = z.infer<typeof PersonaCritiqueSchema>;

export const PersonaFailureSchema = z.object({
  personaId: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});

export type PersonaFailure = z.infer<typeof PersonaFailureSchema>;

export const RawPersonaResultSchema = z.object({
  personaId: z.string().min(1),
  text: z.string(),
  transcript: z.array(z.string()),
  metadata: z.record(z.string(), z.string()).default({}),
});

export type RawPersonaResult = z.infer<typeof RawPersonaResultSchema>;

export const RoundAssessmentSchema = z.object({
  roundNumber: z.number().int().positive(),
  consensus: z.string().min(1),
  disagreements: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
  convergence: z.number().min(0).max(1),
  shouldContinue: z.boolean(),
  diminishingReturns: z.boolean(),
  nextRoundBrief: z.string().min(1).optional(),
});

export type RoundAssessment = z.infer<typeof RoundAssessmentSchema>;

export const CouncilReportSchema = z.object({
  recommendation: z.string().min(1),
  rationale: z.array(z.string().min(1)),
  strongestObjections: z.array(z.string().min(1)),
  unresolvedQuestions: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
  convergence: z.number().min(0).max(1),
  nextExperiment: z.string().min(1),
  failedPersonas: z.array(PersonaFailureSchema),
});

export type CouncilReport = z.infer<typeof CouncilReportSchema>;

export const CouncilRoundSchema = z.object({
  brief: RoundBriefSchema,
  rawResults: z.array(RawPersonaResultSchema),
  critiques: z.array(PersonaCritiqueSchema),
  failures: z.array(PersonaFailureSchema),
  assessment: RoundAssessmentSchema,
});

export type CouncilRound = z.infer<typeof CouncilRoundSchema>;

export const CouncilRunStateSchema = z.object({
  input: CouncilInputSchema,
  personas: z.array(PersonaDefinitionSchema),
  maxRounds: z.number().int().positive(),
  rounds: z.array(CouncilRoundSchema),
  finalReport: CouncilReportSchema.optional(),
  stopReason: z.enum(["consensus", "diminishing-returns", "max-rounds"]).optional(),
});

export type CouncilRunState = z.infer<typeof CouncilRunStateSchema>;

export function createInitialRunState(input: z.input<typeof CouncilInputSchema>, personaSet: PersonaSet): CouncilRunState {
  const parsedInput = CouncilInputSchema.parse(input);
  const parsedPersonaSet = PersonaSetSchema.parse(personaSet);

  return {
    input: parsedInput,
    personas: parsedPersonaSet.personas,
    maxRounds: 3,
    rounds: [],
  };
}
