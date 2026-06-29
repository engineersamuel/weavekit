import { z } from "zod";

export const PersonaArchetypeSchema = z.enum([
  "believer",
  "auditor",
  "synthesist",
  "critic",
  "analyst",
]);

export type PersonaArchetype = z.infer<typeof PersonaArchetypeSchema>;

export const PersonaModeSchema = z.enum([
  "analyze",
  "grade",
  "red-team",
  "advise",
  "synthesize",
  "believe",
]);

export type PersonaMode = z.infer<typeof PersonaModeSchema>;

export const PersonaSkillSchema = z.object({
  name: z.string().min(1),
  bundle: z.string().min(1).optional(),
  installer: z.string().min(1).default("claude-superskills"),
});

export type PersonaSkill = z.infer<typeof PersonaSkillSchema>;

export const PersonaDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),
  archetype: PersonaArchetypeSchema.optional(),
  stance: z.string().min(1).optional(),
  framingCorrections: z.array(z.string().min(1)).default([]),
  antiHedging: z.string().min(1).optional(),
  ignores: z.array(z.string().min(1)).default([]),
  modes: z.array(PersonaModeSchema).default([]),
  tags: z.array(z.string().min(1)).default([]),
  selectionHints: z.array(z.string().min(1)).default([]),
  selectionAntiHints: z.array(z.string().min(1)).default([]),
  specRef: z.string().min(1).optional(),
  skill: PersonaSkillSchema.optional(),
});

export type PersonaDefinition = z.infer<typeof PersonaDefinitionSchema>;

export const PersonaSetSchema = z.object({
  name: z.string().min(1),
  personas: z.array(PersonaDefinitionSchema).min(2),
});

export type PersonaSet = z.infer<typeof PersonaSetSchema>;

export const RoundBriefSchema = z.object({
  roundNumber: z.number().int().positive(),
  prompt: z.string().min(1),
  focus: z.string().min(1),
});

export type RoundBrief = z.infer<typeof RoundBriefSchema>;
