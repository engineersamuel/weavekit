import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import YAML from "yaml";
import {
  EntityManifestSchema,
  PersonaRuntimeDefinitionSchema,
  collectZodEntityErrors,
  type ArtifactEntityManifest,
  type ElicitationEntityManifest,
  type EntityValidationError,
  type EntityValidationResult,
  type PersonaRuntimeDefinition,
  type WorkflowEntityManifest,
} from "./schema.js";
import { getGeneratedBamlFunctionNames, validateManifestSemantics } from "./validation.js";

const KIND_DIRS = {
  personas: "persona",
  artifacts: "artifact",
  elicitation: "elicitation",
} as const;

export type EntityCatalog = {
  repoRoot: string;
  entities: WorkflowEntityManifest[];
  personas: PersonaRuntimeDefinition[];
  artifacts: ArtifactEntityManifest[];
  elicitation: ElicitationEntityManifest[];
};

function kindDirectory(kind: WorkflowEntityManifest["kind"]): string {
  if (kind === "persona") return "personas";
  if (kind === "artifact") return "artifacts";
  return "elicitation";
}

function manifestToRuntimePersona(
  manifest: WorkflowEntityManifest,
  repoRoot: string,
): PersonaRuntimeDefinition | undefined {
  if (manifest.kind !== "persona" || manifest.execution.mode !== "harness_then_baml") {
    return undefined;
  }
  const promptPath = join(repoRoot, "entities", "personas", `${manifest.id}.md`);
  const skills = manifest.capabilities?.skills;
  return PersonaRuntimeDefinitionSchema.parse({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    prompt: readFileSync(promptPath, "utf8").trim(),
    role: manifest.persona.role,
    archetype: manifest.persona.archetype,
    tags: [...manifest.persona.tags],
    useWhen: [...manifest.selection.useWhen],
    avoidWhen: [...manifest.selection.avoidWhen],
    skill: skills && skills.length > 0 ? { name: skills[0] } : undefined,
  });
}

function parseManifestFile(
  absolute: string,
  filePath: string,
): { manifest?: WorkflowEntityManifest; errors: EntityValidationError[] } {
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    return {
      errors: [
        {
          code: "catalog.yaml_parse",
          filePath,
          fieldPath: "<root>",
          message: error instanceof Error ? error.message : String(error),
          repairHint: "Fix YAML syntax so the manifest can be parsed.",
        },
      ],
    };
  }

  const result = EntityManifestSchema.safeParse(parsed);
  if (!result.success) {
    return { errors: collectZodEntityErrors(result, filePath) };
  }

  return { manifest: result.data, errors: [] };
}

function collectCatalog(
  repoRoot: string,
  includeSemantics: boolean,
): {
  errors: EntityValidationError[];
  manifests: Array<{ filePath: string; absolutePath: string; manifest: WorkflowEntityManifest }>;
} {
  const errors: EntityValidationError[] = [];
  const manifests: Array<{
    filePath: string;
    absolutePath: string;
    manifest: WorkflowEntityManifest;
  }> = [];
  const entitiesDir = join(repoRoot, "entities");

  if (!existsSync(entitiesDir)) {
    return {
      manifests,
      errors: [
        {
          code: "catalog.missing_entities_dir",
          filePath: "entities",
          fieldPath: "entities",
          message: "Required repo-local entities/ directory is missing.",
          repairHint:
            "Create repo-local entities/personas, entities/artifacts, and entities/elicitation directories.",
        },
      ],
    };
  }

  const idToFile = new Map<string, string>();
  const bamlFunctions = includeSemantics ? getGeneratedBamlFunctionNames() : undefined;

  for (const entry of readdirSync(entitiesDir, { withFileTypes: true })) {
    const expectedKind = KIND_DIRS[entry.name as keyof typeof KIND_DIRS];
    const entryPath = join(entitiesDir, entry.name);
    if (!entry.isDirectory() || !expectedKind) {
      errors.push({
        code: "catalog.invalid_directory",
        filePath: relative(repoRoot, entryPath),
        fieldPath: "entities",
        message:
          "Only personas, artifacts, and elicitation directories are allowed under entities/.",
        repairHint:
          "Move manifests into entities/personas, entities/artifacts, or entities/elicitation.",
      });
      continue;
    }

    for (const file of readdirSync(entryPath)) {
      const absolute = join(entryPath, file);
      const filePath = relative(repoRoot, absolute);
      if (statSync(absolute).isDirectory()) {
        errors.push({
          code: "catalog.nested_directory",
          filePath,
          fieldPath: "entities",
          message: "Entity directories must be flat in v1.",
          repairHint: "Move this manifest directly under its kind directory.",
        });
        continue;
      }

      if (extname(file) !== ".yaml") {
        if (extname(file) !== ".md") {
          errors.push({
            code: "catalog.invalid_file_extension",
            filePath,
            fieldPath: "file",
            message: "Entity manifests must use .yaml.",
            repairHint: "Use .yaml for manifests and sibling .md only for prompt prose.",
          });
        }
        continue;
      }

      const parsed = parseManifestFile(absolute, filePath);
      errors.push(...parsed.errors);
      if (!parsed.manifest) {
        continue;
      }

      const manifest = parsed.manifest;
      manifests.push({ filePath, absolutePath: absolute, manifest });

      if (manifest.kind !== expectedKind) {
        errors.push({
          code: "catalog.directory_kind_mismatch",
          filePath,
          entityId: manifest.id,
          fieldPath: "kind",
          message: `Manifest kind ${manifest.kind} does not match directory ${entry.name}.`,
          repairHint: `Move this file to entities/${kindDirectory(manifest.kind)} or change kind.`,
          value: manifest.kind,
        });
      }

      const filenameId = basename(file, ".yaml");
      if (filenameId !== manifest.id) {
        errors.push({
          code: "catalog.filename_id_mismatch",
          filePath,
          entityId: manifest.id,
          fieldPath: "id",
          message: `Manifest id ${manifest.id} must match filename ${filenameId}.`,
          repairHint: `Rename the file to ${manifest.id}.yaml or change id to ${filenameId}.`,
          value: manifest.id,
        });
      }

      const firstFile = idToFile.get(manifest.id);
      if (firstFile) {
        errors.push({
          code: "catalog.duplicate_id",
          filePath,
          entityId: manifest.id,
          fieldPath: "id",
          message: `Duplicate entity id ${manifest.id}; first seen in ${firstFile}.`,
          repairHint: "Give every workflow entity a globally unique id.",
          value: manifest.id,
        });
      } else {
        idToFile.set(manifest.id, filePath);
      }

      if (includeSemantics && bamlFunctions) {
        errors.push(
          ...validateManifestSemantics({
            manifest,
            filePath,
            absolutePath: absolute,
            repoRoot,
            bamlFunctions,
          }),
        );
      }
    }
  }

  return { errors, manifests };
}

export function validateEntityCatalog(repoRoot = process.cwd()): EntityValidationResult {
  const { errors } = collectCatalog(repoRoot, true);
  return { valid: errors.length === 0, errors };
}

export function formatEntityValidationErrors(errors: EntityValidationError[]): string {
  const lines = [`Entity catalog validation failed with ${errors.length} error(s).`, ""];
  errors.forEach((error, index) => {
    lines.push(`${index + 1}. ${error.filePath ?? "<unknown>"}`);
    lines.push(`   Code: ${error.code}`);
    lines.push(`   Field: ${error.fieldPath}`);
    if (error.entityId) {
      lines.push(`   Entity: ${error.entityId}`);
    }
    lines.push(`   Message: ${error.message}`);
    lines.push(`   Repair: ${error.repairHint}`);
    if (index < errors.length - 1) {
      lines.push("");
    }
  });
  return lines.join("\n");
}

export function assertValidEntityCatalog(repoRoot = process.cwd()): void {
  const result = validateEntityCatalog(repoRoot);
  if (!result.valid) {
    throw new Error(formatEntityValidationErrors(result.errors));
  }
}

export function loadEntityCatalog(repoRoot = process.cwd()): EntityCatalog {
  assertValidEntityCatalog(repoRoot);
  const { manifests } = collectCatalog(repoRoot, false);
  const entities = manifests.map(({ manifest }) => structuredClone(manifest));
  return {
    repoRoot,
    entities,
    personas: entities.flatMap((manifest) => {
      const runtime = manifestToRuntimePersona(manifest, repoRoot);
      return runtime ? [runtime] : [];
    }),
    artifacts: entities.filter(
      (manifest): manifest is ArtifactEntityManifest => manifest.kind === "artifact",
    ),
    elicitation: entities.filter(
      (manifest): manifest is ElicitationEntityManifest => manifest.kind === "elicitation",
    ),
  };
}

export function listPersonas(repoRoot = process.cwd()): PersonaRuntimeDefinition[] {
  return loadEntityCatalog(repoRoot).personas.map((persona) => structuredClone(persona));
}

export function getPersona(id: string, repoRoot = process.cwd()): PersonaRuntimeDefinition {
  const personas = listPersonas(repoRoot);
  const persona = personas.find((candidate) => candidate.id === id);
  if (!persona) {
    const available = personas.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown persona "${id}". Available personas: ${available}.`);
  }
  return structuredClone(persona);
}
