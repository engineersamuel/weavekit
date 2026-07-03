import { z } from "zod";
import {
  PersonaEntityManifestSchema,
  PersonaRoleSchema,
} from "../entities/index.js";

export const PersonaArchetypeSchema = PersonaEntityManifestSchema.shape.persona.shape.archetype;
export type PersonaArchetype = z.infer<typeof PersonaArchetypeSchema>;

export const PersonaSkillSchema = z.object({
  name: z.string().min(1),
}).strict();

export type PersonaSkill = z.infer<typeof PersonaSkillSchema>;

export const PersonaDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),
  role: PersonaRoleSchema,
  archetype: PersonaArchetypeSchema,
  tags: z.array(z.string().min(1)),
  useWhen: z.array(z.string().min(1)),
  avoidWhen: z.array(z.string().min(1)),
  skill: PersonaSkillSchema.optional(),
}).strict();

export type PersonaDefinition = z.infer<typeof PersonaDefinitionSchema>;

export const RoundBriefSchema = z.object({
  roundNumber: z.number().int().positive(),
  prompt: z.string().min(1),
  focus: z.string().min(1),
});

export type RoundBrief = z.infer<typeof RoundBriefSchema>;
