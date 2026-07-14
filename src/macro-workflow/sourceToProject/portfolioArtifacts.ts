import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  PortfolioCoverageAudit,
  PortfolioPlanDraft,
  ProjectApplicabilityMatrix,
  SourcePracticeLedger,
} from "../../generated/baml_client/index.js";
import type { WorkflowArtifactRef } from "../types.js";
import type {
  OpportunityCoverageEntry,
  PortfolioPlanningCandidate,
  RequiredCoverage,
} from "./portfolioCompiler.js";

const PORTFOLIO_ARTIFACT_SCHEMA_VERSION = 2;

type ArtifactEnvelope<T> = {
  schemaVersion: typeof PORTFOLIO_ARTIFACT_SCHEMA_VERSION;
  inputDigests: Record<string, string>;
  value: T;
};

export type PersistPortfolioCompilerArtifactsInput = {
  outputDir: string;
  ledger: SourcePracticeLedger;
  matrix: ProjectApplicabilityMatrix;
  opportunityCoverage: PersistedOpportunityCoverage;
  initialDraft: PortfolioPlanDraft;
  initialAudit: PortfolioCoverageAudit;
  finalDraft: PortfolioPlanDraft;
  finalAudit: PortfolioCoverageAudit;
  repairAttempted: boolean;
  planTranscript?: string;
};

export type PersistedOpportunityCoverage = {
  required: RequiredCoverage;
  accepted: Array<OpportunityCoverageEntry & Pick<PortfolioPlanningCandidate, "kind">>;
};

export type PersistedPortfolioCompilerArtifacts = {
  canonicalPlanPath: "raw-plans/plan-portfolio-full.md";
  transcriptPath: "raw-plans/plan-portfolio-transcript.md";
  artifacts: WorkflowArtifactRef[];
};

export async function persistPortfolioCompilerArtifacts(
  input: PersistPortfolioCompilerArtifactsInput,
): Promise<PersistedPortfolioCompilerArtifacts> {
  const ledgerDigest = digestValue(input.ledger);
  const matrixDigest = digestValue(input.matrix);
  const opportunityCoverageDigest = digestValue(input.opportunityCoverage);
  const initialDraftDigest = digestValue(input.initialDraft);
  const initialAuditDigest = digestValue(input.initialAudit);
  const finalDraftDigest = digestValue(input.finalDraft);
  const envelopes = [
    envelopeArtifact("source-practice-ledger.json", input.ledger, {}),
    envelopeArtifact("project-applicability-matrix.json", input.matrix, {
      practiceLedger: ledgerDigest,
    }),
    envelopeArtifact("opportunity-coverage-map.json", input.opportunityCoverage, {
      practiceLedger: ledgerDigest,
      applicabilityMatrix: matrixDigest,
    }),
    envelopeArtifact("portfolio-plan-draft.initial.json", input.initialDraft, {
      opportunityCoverage: opportunityCoverageDigest,
    }),
    envelopeArtifact("portfolio-coverage-audit.initial.json", input.initialAudit, {
      portfolioDraft: initialDraftDigest,
    }),
    envelopeArtifact("portfolio-plan-draft.final.json", input.finalDraft, {
      initialDraft: initialDraftDigest,
      initialAudit: initialAuditDigest,
      repairDecision: digestValue(input.repairAttempted),
    }),
    envelopeArtifact("portfolio-coverage-audit.final.json", input.finalAudit, {
      portfolioDraft: finalDraftDigest,
    }),
  ] as const;

  for (const artifact of envelopes) {
    await atomicWrite(
      join(input.outputDir, artifact.path),
      `${stableStringify(artifact.envelope)}\n`,
    );
  }

  const transcriptPath = "raw-plans/plan-portfolio-transcript.md" as const;
  const canonicalPlanPath = "raw-plans/plan-portfolio-full.md" as const;
  await atomicWrite(join(input.outputDir, transcriptPath), input.planTranscript ?? "");
  await atomicWrite(join(input.outputDir, canonicalPlanPath), input.finalDraft.markdown);

  return {
    canonicalPlanPath,
    transcriptPath,
    artifacts: [
      ...envelopes.map(({ path }) => ({
        kind: "json" as const,
        path,
        description: `Schema-versioned source-to-project portfolio compiler artifact: ${path}.`,
      })),
      {
        kind: "markdown",
        path: transcriptPath,
        description: "Original Copilot canonical portfolio planning transcript.",
      },
      {
        kind: "markdown",
        path: canonicalPlanPath,
        description: "Final audited canonical source-to-project portfolio plan.",
      },
    ],
  };
}

export async function verifyPortfolioCompilerArtifact(
  path: string,
  expectedInputDigests: Record<string, string>,
): Promise<ArtifactEnvelope<unknown>> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ArtifactEnvelope<unknown>>;
  if (parsed.schemaVersion !== PORTFOLIO_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `Portfolio artifact schema version mismatch at ${path}: expected ${PORTFOLIO_ARTIFACT_SCHEMA_VERSION}, received ${String(parsed.schemaVersion)}.`,
    );
  }
  if (!parsed.inputDigests || typeof parsed.inputDigests !== "object") {
    throw new Error(`Portfolio artifact input digests are missing at ${path}.`);
  }
  for (const [name, expected] of Object.entries(expectedInputDigests)) {
    const actual = parsed.inputDigests[name];
    if (actual !== expected) {
      throw new Error(
        `Portfolio artifact digest mismatch for ${name} at ${path}: expected ${expected}, received ${String(actual)}.`,
      );
    }
  }
  if (!("value" in parsed)) {
    throw new Error(`Portfolio artifact value is missing at ${path}.`);
  }
  return parsed as ArtifactEnvelope<unknown>;
}

function envelopeArtifact<T>(
  path: string,
  value: T,
  inputDigests: Record<string, string>,
): { path: string; envelope: ArtifactEnvelope<T> } {
  return {
    path,
    envelope: {
      schemaVersion: PORTFOLIO_ARTIFACT_SCHEMA_VERSION,
      inputDigests,
      value,
    },
  };
}

function digestValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJsonValue(nested)]),
    );
  }
  return value;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}
