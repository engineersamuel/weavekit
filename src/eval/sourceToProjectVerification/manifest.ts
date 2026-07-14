import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { boundedErrorText } from "../boundedError.js";
import { WeavekitOpportunityDiagnosticsSchema } from "./weavekitDiagnostics.js";

export type ProjectVerificationExecutionRow = {
  provider: { id: string };
  success?: boolean;
  error?: unknown;
  latencyMs?: number;
  tokenUsage?: Record<string, unknown>;
  cost?: number;
  response?: {
    output?: unknown;
    error?: unknown;
    metadata?: Record<string, unknown>;
  };
};

const NonEmptyStringSchema = z.string().trim().min(1);
const NonNegativeNumberSchema = z.number().finite().nonnegative();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const FrozenPlanArtifactSchema = z
  .object({
    providerId: NonEmptyStringSchema,
    generationSucceeded: z.boolean(),
    workspaceMutationVerified: z.boolean(),
    planPath: NonEmptyStringSchema.optional(),
    sha256: Sha256Schema.optional(),
    model: NonEmptyStringSchema.optional(),
    latencyMs: NonNegativeNumberSchema.optional(),
    tokenUsage: z.record(z.string(), NonNegativeNumberSchema).optional(),
    estimatedCostUsd: NonNegativeNumberSchema.optional(),
    retries: z.number().int().nonnegative().optional(),
    opportunityDiagnostics: WeavekitOpportunityDiagnosticsSchema.optional(),
    errors: z.array(z.string()),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.generationSucceeded && !artifact.planPath) {
      context.addIssue({
        code: "custom",
        path: ["planPath"],
        message: "Required after generation",
      });
    }
    if (artifact.generationSucceeded && !artifact.sha256) {
      context.addIssue({ code: "custom", path: ["sha256"], message: "Required after generation" });
    }
    if (Boolean(artifact.planPath) !== Boolean(artifact.sha256)) {
      context.addIssue({
        code: "custom",
        path: ["planPath"],
        message: "Plan path and digest must be present together",
      });
    }
  });
const ProjectVerificationManifestSchema = z
  .object({
    version: z.literal(2),
    caseId: NonEmptyStringSchema,
    caseSha256: Sha256Schema,
    createdAt: z.string().datetime({ offset: true }),
    promptfooGenerationEvaluationId: NonEmptyStringSchema,
    artifacts: z.array(FrozenPlanArtifactSchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    const providerIds = new Set<string>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (providerIds.has(artifact.providerId)) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index, "providerId"],
          message: `Duplicate provider id: ${artifact.providerId}`,
        });
      }
      providerIds.add(artifact.providerId);
    }
  });

export type FrozenPlanArtifact = z.infer<typeof FrozenPlanArtifactSchema>;
export type ProjectVerificationManifest = z.infer<typeof ProjectVerificationManifestSchema>;
export type VerifiedPlanArtifact = { providerId: string; markdown: string };

export async function buildProjectVerificationManifest(args: {
  caseId: string;
  caseSha256: string;
  createdAt: string;
  promptfooGenerationEvaluationId: string;
  rows: ProjectVerificationExecutionRow[];
}): Promise<ProjectVerificationManifest> {
  if (args.promptfooGenerationEvaluationId.trim().length === 0) {
    throw new Error("Promptfoo generation evaluation ID must be non-empty.");
  }
  const seen = new Set<string>();
  const artifacts: FrozenPlanArtifact[] = [];
  for (const row of args.rows) {
    if (seen.has(row.provider.id)) {
      throw new Error(`Duplicate provider result in plan manifest: ${row.provider.id}`);
    }
    seen.add(row.provider.id);
    artifacts.push(await freezeRow(row));
  }
  return parseProjectVerificationManifest({
    version: 2,
    caseId: args.caseId,
    caseSha256: args.caseSha256,
    createdAt: args.createdAt,
    promptfooGenerationEvaluationId: args.promptfooGenerationEvaluationId,
    artifacts,
  });
}

export function parseProjectVerificationManifest(
  value: unknown,
  options: { sourceDir?: string } = {},
): ProjectVerificationManifest {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).version !== 2
  ) {
    throw new Error("Project verification rejudge requires manifest version 2.");
  }
  const parsed = ProjectVerificationManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid project verification manifest: ${parsed.error.message}`);
  }
  return options.sourceDir ? confineArtifactPaths(parsed.data, options.sourceDir) : parsed.data;
}

export async function verifyProjectVerificationManifest(
  manifest: ProjectVerificationManifest,
  sourceDir: string,
): Promise<VerifiedPlanArtifact[]> {
  const confined = confineArtifactPaths(manifest, sourceDir);
  const sourceRealPath = await realpath(resolve(sourceDir));
  const verified: VerifiedPlanArtifact[] = [];
  for (const artifact of confined.artifacts) {
    if (!artifact.generationSucceeded) continue;
    if (!artifact.planPath || !artifact.sha256) {
      throw new Error(`Frozen plan is incomplete for ${artifact.providerId}.`);
    }
    const planRealPath = await realpath(artifact.planPath);
    assertInsideSource(sourceRealPath, planRealPath, artifact.providerId);
    const bytes = await readFile(planRealPath);
    const actual = digest(bytes);
    if (actual !== artifact.sha256) {
      throw new Error(
        `Plan digest mismatch for ${artifact.providerId}: expected ${artifact.sha256}, received ${actual}.`,
      );
    }
    verified.push({ providerId: artifact.providerId, markdown: bytes.toString("utf8") });
  }
  return verified;
}

function confineArtifactPaths(
  manifest: ProjectVerificationManifest,
  sourceDir: string,
): ProjectVerificationManifest {
  const sourceRoot = resolve(sourceDir);
  return {
    ...manifest,
    artifacts: manifest.artifacts.map((artifact) => {
      if (!artifact.planPath) return artifact;
      const planPath = isAbsolute(artifact.planPath)
        ? resolve(artifact.planPath)
        : resolve(sourceRoot, artifact.planPath);
      assertInsideSource(sourceRoot, planPath, artifact.providerId);
      return { ...artifact, planPath };
    }),
  };
}

function assertInsideSource(sourceRoot: string, planPath: string, providerId: string): void {
  const pathFromSource = relative(sourceRoot, planPath);
  if (
    pathFromSource === ".." ||
    pathFromSource.startsWith(`..${sep}`) ||
    isAbsolute(pathFromSource)
  ) {
    throw new Error(`Plan path for ${providerId} resolves outside the source result directory.`);
  }
}

async function freezeRow(row: ProjectVerificationExecutionRow): Promise<FrozenPlanArtifact> {
  const metadata = row.response?.metadata;
  const paths = readArtifactPaths(metadata);
  const errors = collectPersistedErrors([
    row.error,
    row.response?.error,
    metadata?.workspaceMutationError,
  ]);
  const hasOutput = typeof row.response?.output === "string";
  if (row.success === false || !hasOutput || paths.length !== 1) {
    if (paths.length !== 1 && row.success !== false) {
      errors.push(`Expected one canonical plan artifact, found ${paths.length}.`);
    }
    return baseArtifact(row, metadata, false, errors);
  }
  const planPath = resolve(paths[0]!);
  const sha256 = digest(await readFile(planPath));
  return {
    ...baseArtifact(row, metadata, true, errors),
    planPath,
    sha256,
  };
}

function collectPersistedErrors(values: unknown[]): string[] {
  const errors = values
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map(boundedErrorText);
  return [...new Set(errors)];
}

function baseArtifact(
  row: ProjectVerificationExecutionRow,
  metadata: Record<string, unknown> | undefined,
  generationSucceeded: boolean,
  errors: string[],
): FrozenPlanArtifact {
  const model = typeof metadata?.model === "string" ? metadata.model : undefined;
  const tokenUsage = normalizeTokenUsage(row.tokenUsage);
  const retries =
    typeof metadata?.retries === "number" && Number.isInteger(metadata.retries)
      ? metadata.retries
      : undefined;
  const opportunityDiagnostics = WeavekitOpportunityDiagnosticsSchema.safeParse(
    metadata?.opportunityDiagnostics,
  );
  return {
    providerId: row.provider.id,
    generationSucceeded,
    workspaceMutationVerified: metadata?.workspaceMutationVerified === true,
    ...(model ? { model } : {}),
    ...(typeof row.latencyMs === "number" ? { latencyMs: row.latencyMs } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(typeof row.cost === "number" ? { estimatedCostUsd: row.cost } : {}),
    ...(retries !== undefined ? { retries } : {}),
    ...(opportunityDiagnostics.success
      ? { opportunityDiagnostics: opportunityDiagnostics.data }
      : {}),
    errors,
  };
}

function normalizeTokenUsage(
  tokenUsage: Record<string, unknown> | undefined,
): Record<string, number> | undefined {
  if (!tokenUsage) return undefined;
  const counters = Object.fromEntries(
    Object.entries(tokenUsage).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0,
    ),
  );
  return Object.keys(counters).length > 0 ? counters : undefined;
}

function readArtifactPaths(metadata: Record<string, unknown> | undefined): string[] {
  const value = metadata?.artifactPaths;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
