import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  persistPortfolioCompilerArtifacts,
  type PersistPortfolioCompilerArtifactsInput,
  verifyPortfolioCompilerArtifact,
} from "../../../src/macro-workflow/sourceToProject/portfolioArtifacts.js";
import {
  compilePracticeLedger,
  type OpportunityCoverageEntry,
  type PortfolioPlanningCandidate,
  type RequiredCoverage,
} from "../../../src/macro-workflow/sourceToProject/portfolioCompiler.js";

const outputDirs: string[] = [];

afterEach(async () => {
  await Promise.all(outputDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("portfolio compiler artifacts", () => {
  it("uses the canonical required and accepted coverage contract", () => {
    expectTypeOf<PersistPortfolioCompilerArtifactsInput["opportunityCoverage"]>().toEqualTypeOf<{
      required: RequiredCoverage;
      accepted: Array<OpportunityCoverageEntry & Pick<PortfolioPlanningCandidate, "kind">>;
    }>();
  });

  it("persists linked envelopes, rejected drafts, and final audited markdown", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "weavekit-portfolio-artifacts-"));
    outputDirs.push(outputDir);
    const ledger = compilePracticeLedger({
      sourceId: "source",
      summary: "Boundary practice",
      claims: [],
      evidence: [],
      practices: [
        {
          id: "boundaries",
          title: "Boundaries",
          behavior: "Validate at ingress.",
          rationale: "Reject malformed input.",
          adoptionPreconditions: ["An ingress exists."],
          requiredBehaviors: ["Validate requests"],
          proofObligations: ["Run integration checks"],
          evidence: [],
        },
      ],
    });
    const practice = ledger.practices[0]!;
    const matrix = {
      projectId: "fixture",
      architecture: "HTTP service",
      constraints: [],
      validationCommands: ["nub run test"],
      evidence: [],
      assessments: [
        {
          practiceId: practice.id,
          status: "applicable" as const,
          applicableBehaviorIds: practice.behaviorIds,
          excludedBehaviorIds: [],
          targetLayers: ["HTTP adapter"],
          projectEvidence: [{ id: "p1", source: "src/http.ts", quote: "router" }],
          contradictionEvidence: [],
          rationale: "The adapter accepts requests.",
        },
      ],
    };
    const initialDraft = portfolioDraft("Initial plan without integration proof.", practice);
    const finalDraft = portfolioDraft(
      "Final plan with request validation and an integration proof.",
      practice,
    );
    const initialAudit = portfolioAudit(practice.behaviorIds[0]!, "partial", initialDraft.markdown);
    const finalAudit = portfolioAudit(practice.behaviorIds[0]!, "complete", finalDraft.markdown);

    const published = await persistPortfolioCompilerArtifacts({
      outputDir,
      ledger,
      matrix,
      opportunityCoverage: {
        required: {
          practiceIds: [practice.id],
          behaviorIds: practice.behaviorIds,
          proofIds: practice.proofIds,
          targetLayersByPracticeId: {
            [practice.id]: ["HTTP adapter"],
          },
        },
        accepted: [
          {
            id: "accepted-boundaries",
            kind: "opportunity",
            practiceIds: [practice.id],
            behaviorIds: practice.behaviorIds,
            proofIds: practice.proofIds,
            targetLayers: ["HTTP adapter"],
          },
        ],
      },
      initialDraft,
      initialAudit,
      finalDraft,
      finalAudit,
      repairAttempted: true,
      planTranscript: "Copilot transcript",
    });

    expect(published.canonicalPlanPath).toBe("raw-plans/plan-portfolio-full.md");
    const matrixEnvelope = JSON.parse(
      await readFile(join(outputDir, "project-applicability-matrix.json"), "utf8"),
    ) as { schemaVersion: number; inputDigests: { practiceLedger: string } };
    expect(matrixEnvelope).toMatchObject({
      schemaVersion: 2,
      inputDigests: { practiceLedger: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    const opportunityCoverageEnvelope = JSON.parse(
      await readFile(join(outputDir, "opportunity-coverage-map.json"), "utf8"),
    ) as {
      schemaVersion: number;
      value: {
        required: { targetLayersByPracticeId: Record<string, string[]> };
        accepted: Array<{ id: string; targetLayers: string[] }>;
      };
    };
    expect(opportunityCoverageEnvelope).toMatchObject({
      schemaVersion: 2,
      value: {
        required: {
          targetLayersByPracticeId: {
            [practice.id]: ["HTTP adapter"],
          },
        },
        accepted: [{ id: "accepted-boundaries", targetLayers: ["HTTP adapter"] }],
      },
    });
    const initialDraftEnvelope = JSON.parse(
      await readFile(join(outputDir, "portfolio-plan-draft.initial.json"), "utf8"),
    ) as { value: { markdown: string } };
    expect(initialDraftEnvelope.value.markdown).toBe(initialDraft.markdown);
    await expect(
      readFile(join(outputDir, "raw-plans/plan-portfolio-transcript.md"), "utf8"),
    ).resolves.toBe("Copilot transcript");
    await expect(
      readFile(join(outputDir, "raw-plans/plan-portfolio-full.md"), "utf8"),
    ).resolves.toBe(finalDraft.markdown);
    await expect(
      verifyPortfolioCompilerArtifact(join(outputDir, "project-applicability-matrix.json"), {
        practiceLedger: "incorrect-digest",
      }),
    ).rejects.toThrow(/digest mismatch/);
  });
});

function portfolioDraft(
  line: string,
  practice: { id: string; behaviorIds: string[]; proofIds: string[] },
) {
  return {
    title: "Boundary plan",
    summary: "Validate requests.",
    markdown: `# Boundary plan\n\n${line}`,
    coverageClaims: [
      {
        practiceId: practice.id,
        behaviorIds: practice.behaviorIds,
        proofIds: practice.proofIds,
        targetLayers: ["HTTP adapter"],
        evidenceQuotes: [line],
      },
    ],
  };
}

function portfolioAudit(behaviorId: string, status: "complete" | "partial", markdown: string) {
  return {
    behaviorAssessments: [
      {
        behaviorId,
        status,
        responsibleLayer: "HTTP adapter",
        evidenceQuotes: [markdown.split("\n").at(-1)!],
        gaps: status === "complete" ? [] : ["Integration proof missing."],
        rationale: "Fixture audit.",
      },
    ],
    specializedAssessments: [],
    unsupportedClaims: [],
    contradictions: [],
    summary: "Fixture audit.",
  };
}
