import { z } from "zod";

export const EntityKindSchema = z.enum(["persona", "artifact", "elicitation"]);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const PersonaRoleSchema = z.enum(["advisor", "reviewer"]);
export const PersonaArchetypeValueSchema = z.enum(["believer", "auditor", "synthesist", "critic", "analyst"]);
export const PersonaArchetypeSchema = PersonaArchetypeValueSchema.optional();

export const EntitySelectionSchema = z.object({
  useWhen: z.array(z.string().min(1)),
  avoidWhen: z.array(z.string().min(1)),
}).strict();

export const ModelPolicySchema = z.object({
  default: z.string().min(1).optional(),
  allowOverride: z.boolean().optional(),
}).strict();

export const EntityCapabilitiesSchema = z.object({
  skills: z.array(z.string().min(1)).optional(),
  mcps: z.array(z.string().min(1)).optional(),
}).strict();

export const BamlDirectExecutionSchema = z.object({
  mode: z.literal("baml_direct"),
  bamlFunction: z.string().min(1),
  modelPolicy: ModelPolicySchema.optional(),
}).strict();

export const HarnessThenBamlExecutionSchema = z.object({
  mode: z.literal("harness_then_baml"),
  harness: z.literal("copilot-sdk"),
  promptRef: z.string().min(1),
  modelPolicy: ModelPolicySchema.optional(),
  output: z.object({
    normalizeWithBamlFunction: z.string().min(1),
  }).strict(),
}).strict();

export const EntityExecutionSchema = z.discriminatedUnion("mode", [
  BamlDirectExecutionSchema,
  HarnessThenBamlExecutionSchema,
]);

export const PersonaEntityManifestSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("persona"),
  name: z.string().min(1),
  description: z.string().min(1),
  persona: z.object({
    role: PersonaRoleSchema,
    archetype: PersonaArchetypeSchema,
    tags: z.array(z.string().min(1)),
  }).strict(),
  selection: EntitySelectionSchema,
  execution: EntityExecutionSchema,
  capabilities: EntityCapabilitiesSchema.optional(),
}).strict();

export const ArtifactEntityManifestSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("artifact"),
  name: z.string().min(1),
  description: z.string().min(1),
  artifact: z.object({
    lifecycle: z.enum(["input", "intermediate", "output"]).optional(),
    producedBy: z.object({
      bamlFunction: z.string().min(1),
    }).strict().optional(),
  }).strict().optional(),
  execution: BamlDirectExecutionSchema,
  capabilities: EntityCapabilitiesSchema.optional(),
}).strict();

export const ElicitationEntityManifestSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("elicitation"),
  name: z.string().min(1),
  description: z.string().min(1),
  elicitation: z.object({
    channel: z.enum(["deferred"]),
    requiredResponse: z.enum(["text"]),
  }).strict(),
  selection: EntitySelectionSchema,
  execution: HarnessThenBamlExecutionSchema,
  capabilities: EntityCapabilitiesSchema.optional(),
}).strict();

export const EntityManifestSchema = z.discriminatedUnion("kind", [
  PersonaEntityManifestSchema,
  ArtifactEntityManifestSchema,
  ElicitationEntityManifestSchema,
]);
export const WorkflowEntityManifestSchema = EntityManifestSchema;

export type PersonaEntityManifest = z.infer<typeof PersonaEntityManifestSchema>;
export type ArtifactEntityManifest = z.infer<typeof ArtifactEntityManifestSchema>;
export type ElicitationEntityManifest = z.infer<typeof ElicitationEntityManifestSchema>;
export type WorkflowEntityManifest = z.infer<typeof EntityManifestSchema>;

export type EntityValidationError = {
  code: string;
  filePath?: string;
  entityId?: string;
  fieldPath: string;
  message: string;
  repairHint: string;
  value?: unknown;
};

export type EntityValidationResult = {
  valid: boolean;
  errors: EntityValidationError[];
};

export const PersonaRuntimeDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),
  role: PersonaRoleSchema,
  archetype: PersonaArchetypeSchema,
  tags: z.array(z.string().min(1)),
  useWhen: z.array(z.string().min(1)),
  avoidWhen: z.array(z.string().min(1)),
  skill: z.object({
    name: z.string().min(1),
  }).strict().optional(),
}).strict();
export type PersonaRuntimeDefinition = z.infer<typeof PersonaRuntimeDefinitionSchema>;

export function collectZodEntityErrors(
  result: { success: false; error: z.ZodError } | { success: true },
  filePath?: string,
): EntityValidationError[] {
  if (result.success) return [];
  return result.error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      const parentPath = issue.path.join(".");
      return issue.keys.map((key) => {
        const fieldPath = parentPath ? `${parentPath}.${key}` : key;
        return toEntityValidationError(issue.message, fieldPath, filePath);
      });
    }

    const fieldPath = issue.path.join(".") || "<root>";
    return toEntityValidationError(issue.message, fieldPath, filePath);
  });
}

function toEntityValidationError(
  message: string,
  fieldPath: string,
  filePath?: string,
): EntityValidationError {
  return {
    code: "entity.schema",
    filePath,
    fieldPath,
    message,
    repairHint: fieldPath === "kind"
      ? "Use kind: persona and set persona.role: reviewer."
      : `Fix ${fieldPath} to match the entity manifest schema.`,
  };
}
