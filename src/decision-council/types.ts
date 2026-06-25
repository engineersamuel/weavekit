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

export const DecisionCouncilInputSchema = z.object({
  prompt: z.string().min(1),
  context: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  personaSetName: z.string().min(1).optional(),
});

export type DecisionCouncilInput = z.infer<typeof DecisionCouncilInputSchema>;

export const RoundBriefSchema = z.object({
  roundNumber: z.number().int().positive(),
  prompt: z.string().min(1),
  focus: z.string().min(1),
});

export type RoundBrief = z.infer<typeof RoundBriefSchema>;

export const DecisionPersonaCritiqueSchema = z.object({
  personaId: z.string().min(1),
  overallSummary: z.string().min(1),
  summary: z.string().min(1),
  claims: z.array(z.string().min(1)),
  risks: z.array(z.string().min(1)),
  questions: z.array(z.string().min(1)),
  recommendations: z.array(z.string().min(1)),
});

export type DecisionPersonaCritique = z.infer<typeof DecisionPersonaCritiqueSchema>;

export const DecisionPersonaFailureSchema = z.object({
  personaId: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});

export type DecisionPersonaFailure = z.infer<typeof DecisionPersonaFailureSchema>;

export const RawPersonaResultSchema = z.object({
  personaId: z.string().min(1),
  text: z.string(),
  transcript: z.array(z.string()),
  metadata: z.record(z.string(), z.string()).default({}),
});

export type RawPersonaResult = z.infer<typeof RawPersonaResultSchema>;

export const DecisionRoundAssessmentSchema = z.object({
  roundNumber: z.number().int().positive(),
  consensus: z.string().min(1),
  disagreements: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
  convergence: z.number().min(0).max(1),
  shouldContinue: z.boolean(),
  diminishingReturns: z.boolean(),
  nextRoundBrief: z.preprocess((value) => (value === null ? undefined : value), z.string().min(1).optional()),
});

export type DecisionRoundAssessment = z.infer<typeof DecisionRoundAssessmentSchema>;

export const DecisionCouncilReportSchema = z.object({
  recommendation: z.string().min(1),
  rationale: z.array(z.string().min(1)),
  strongestObjections: z.array(z.string().min(1)),
  unresolvedQuestions: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
  convergence: z.number().min(0).max(1),
  nextExperiment: z.string().min(1),
  finalReportMarkdown: z.string().min(1),
  failedPersonas: z.array(DecisionPersonaFailureSchema),
});

export type DecisionCouncilReport = z.infer<typeof DecisionCouncilReportSchema>;

export const DecisionCouncilRoundSchema = z.object({
  brief: RoundBriefSchema,
  rawResults: z.array(RawPersonaResultSchema),
  critiques: z.array(DecisionPersonaCritiqueSchema),
  failures: z.array(DecisionPersonaFailureSchema),
  assessment: DecisionRoundAssessmentSchema,
});

export type DecisionCouncilRound = z.infer<typeof DecisionCouncilRoundSchema>;

export const DecisionCouncilRunStateSchema = z.object({
  input: DecisionCouncilInputSchema,
  personas: z.array(PersonaDefinitionSchema),
  maxRounds: z.number().int().positive(),
  rounds: z.array(DecisionCouncilRoundSchema),
  finalReport: DecisionCouncilReportSchema.optional(),
  stopReason: z.enum(["consensus", "diminishing-returns", "max-rounds"]).optional(),
});

export type DecisionCouncilRunState = z.infer<typeof DecisionCouncilRunStateSchema>;

export function createInitialRunState(input: z.input<typeof DecisionCouncilInputSchema>, personaSet: PersonaSet): DecisionCouncilRunState {
  const parsedInput = DecisionCouncilInputSchema.parse(input);
  const parsedPersonaSet = PersonaSetSchema.parse(personaSet);

  return {
    input: parsedInput,
    personas: parsedPersonaSet.personas,
    maxRounds: 3,
    rounds: [],
  };
}
