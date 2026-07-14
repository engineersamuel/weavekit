import { describe, expect, it } from "vitest";
import {
  compilePracticeLedger,
  groundPortfolioDraft,
  projectApplicabilityMatrixForPlanning,
  requiredCoverage,
  selectCoverageCompleteCandidates,
  selectPortfolioPlanningRoute,
  specializedObligationsFor,
  validateApplicabilityMatrix,
  validateOpportunityCoverage,
  validatePortfolioAudit,
  validatePortfolioDraft,
  validatePortfolioDraftExtraction,
} from "../../../src/macro-workflow/sourceToProject/portfolioCompiler.js";

describe("source-to-project portfolio compiler", () => {
  it("derives stable collision-safe practice, behavior, and proof ids", () => {
    const ledger = compilePracticeLedger({
      sourceId: "oxlint-article",
      summary: "Migration guidance",
      claims: [],
      evidence: [],
      practices: [
        {
          id: "Rule Compatibility",
          title: "Rule compatibility",
          behavior: "Inventory semantic differences before replacement.",
          rationale: "Avoid silent lint regressions.",
          adoptionPreconditions: ["The project uses ESLint rules."],
          requiredBehaviors: ["Inventory enabled ESLint rules", "Classify unsupported rules"],
          proofObligations: ["Run both tools during transition"],
          evidence: [],
        },
        {
          id: "rule compatibility",
          title: "Compatibility fallback",
          behavior: "Retain ESLint for unsupported rules.",
          rationale: "Permit partial adoption.",
          adoptionPreconditions: ["Unsupported rules remain."],
          requiredBehaviors: ["Keep a bounded ESLint compatibility config"],
          proofObligations: ["Show both commands pass"],
          evidence: [],
        },
      ],
    });

    expect(ledger.practices.map((practice) => practice.id)).toEqual([
      "practice-rule-compatibility",
      "practice-rule-compatibility-2",
    ]);
    expect(ledger.practices[0]?.behaviorIds).toEqual([
      "practice-rule-compatibility/behavior-1",
      "practice-rule-compatibility/behavior-2",
    ]);
    expect(ledger.practices[0]?.proofIds).toEqual(["practice-rule-compatibility/proof-1"]);
  });

  it("rejects non-adoption without contradictory project evidence", () => {
    const ledger = compilePracticeLedger({
      sourceId: "source",
      summary: "Boundary guidance",
      claims: [],
      evidence: [],
      practices: [
        {
          id: "boundary-validation",
          title: "Boundary validation",
          behavior: "Validate at ingress.",
          rationale: "Reject malformed input early.",
          adoptionPreconditions: ["The project has an ingress boundary."],
          requiredBehaviors: ["Validate route input"],
          proofObligations: ["Exercise the real adapter"],
          evidence: [],
        },
      ],
    });

    expect(() =>
      validateApplicabilityMatrix(ledger, {
        projectId: "fixture",
        architecture: "Node project",
        constraints: [],
        validationCommands: ["nub run test"],
        evidence: [],
        assessments: [
          {
            practiceId: ledger.practices[0]!.id,
            status: "not-applicable",
            applicableBehaviorIds: [],
            excludedBehaviorIds: ledger.practices[0]!.behaviorIds,
            targetLayers: [],
            projectEvidence: [],
            contradictionEvidence: [],
            rationale: "No fit was found.",
          },
        ],
      }),
    ).toThrow(/contradiction evidence/);
  });

  it("requires exactly one applicability assessment per canonical practice", () => {
    const ledger = compilePracticeLedger({
      sourceId: "source",
      summary: "Two practices",
      claims: [],
      evidence: [],
      practices: [
        practiceDraft("ingress", "Validate ingress"),
        practiceDraft("rendering", "Escape rendered output"),
      ],
    });

    expect(() =>
      validateApplicabilityMatrix(ledger, {
        projectId: "fixture",
        architecture: "Node project",
        constraints: [],
        validationCommands: [],
        evidence: [],
        assessments: [
          applicableAssessment(ledger.practices[0]!.id, ledger.practices[0]!.behaviorIds),
        ],
      }),
    ).toThrow(/missing.*practice-rendering/);
  });

  it("derives only the applicable behavior subset as required coverage", () => {
    const ledger = compilePracticeLedger({
      sourceId: "source",
      summary: "Migration practice",
      claims: [],
      evidence: [],
      practices: [
        {
          ...practiceDraft("migration", "Migrate validation tooling"),
          requiredBehaviors: ["Adopt the fast checks", "Replace unsupported project rules"],
          proofObligations: ["Run the stable validation script"],
        },
      ],
    });
    const practice = ledger.practices[0]!;

    expect(
      requiredCoverage(ledger, {
        projectId: "fixture",
        architecture: "Node project",
        constraints: [],
        validationCommands: ["nub run lint"],
        evidence: [],
        assessments: [
          {
            ...applicableAssessment(practice.id, [practice.behaviorIds[0]!]),
            status: "partial",
            excludedBehaviorIds: [practice.behaviorIds[1]!],
            contradictionEvidence: [
              {
                id: "unsupported-rule",
                source: "eslint.config.js",
                quote: "customProjectRule",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      practiceIds: [practice.id],
      behaviorIds: [practice.behaviorIds[0]],
      proofIds: practice.proofIds,
      targetLayersByPracticeId: {
        [practice.id]: ["adapter"],
      },
    });
  });

  it("projects only planning-relevant applicability while retaining grounded exclusions", () => {
    const matrix = {
      projectId: "fixture",
      architecture: "PROJECT_ARCHITECTURE_SENTINEL",
      constraints: ["PROJECT_CONSTRAINT_SENTINEL"],
      validationCommands: ["PROJECT_VALIDATION_SENTINEL"],
      evidence: [{ id: "matrix-evidence", source: "README.md", quote: "MATRIX_EVIDENCE_SENTINEL" }],
      assessments: [
        {
          practiceId: "practice-boundaries",
          status: "partial" as const,
          applicableBehaviorIds: ["practice-boundaries/behavior-1"],
          excludedBehaviorIds: ["practice-boundaries/behavior-2"],
          targetLayers: ["HTTP adapter"],
          projectEvidence: [
            { id: "project-evidence", source: "src/http.ts", quote: "PROJECT_EVIDENCE_SENTINEL" },
          ],
          contradictionEvidence: [
            {
              id: "contradiction-evidence",
              source: "src/legacy.ts",
              quote: "CONTRADICTION_EVIDENCE_SENTINEL",
            },
          ],
          rationale: "Keep the adapter behavior and exclude the legacy behavior.",
        },
      ],
    };

    const projection = projectApplicabilityMatrixForPlanning(matrix);

    expect(projection).toEqual({
      projectId: "fixture",
      assessments: [
        {
          practiceId: "practice-boundaries",
          status: "partial",
          applicableBehaviorIds: ["practice-boundaries/behavior-1"],
          excludedBehaviorIds: ["practice-boundaries/behavior-2"],
          targetLayers: ["HTTP adapter"],
          contradictionEvidence: [
            {
              id: "contradiction-evidence",
              source: "src/legacy.ts",
              quote: "CONTRADICTION_EVIDENCE_SENTINEL",
            },
          ],
          rationale: "Keep the adapter behavior and exclude the legacy behavior.",
        },
      ],
    });
    expect(JSON.stringify(projection)).not.toContain("PROJECT_EVIDENCE_SENTINEL");
    expect(JSON.stringify(projection)).not.toContain("MATRIX_EVIDENCE_SENTINEL");
  });

  it("rejects partial exclusions without contradictory project evidence", () => {
    const ledger = compilePracticeLedger({
      sourceId: "source",
      summary: "Testing practice",
      claims: [],
      evidence: [],
      practices: [
        {
          ...practiceDraft("vertical-proof", "Prove the vertical path"),
          requiredBehaviors: ["Add service tests", "Add adapter integration tests"],
        },
      ],
    });
    const practice = ledger.practices[0]!;

    expect(() =>
      validateApplicabilityMatrix(ledger, {
        projectId: "fixture",
        architecture: "Node project without tests",
        constraints: [],
        validationCommands: [],
        evidence: [],
        assessments: [
          {
            ...applicableAssessment(practice.id, [practice.behaviorIds[0]!]),
            status: "partial",
            excludedBehaviorIds: [practice.behaviorIds[1]!],
            contradictionEvidence: [],
          },
        ],
      }),
    ).toThrow(/contradiction evidence.*partial exclusion/);
  });

  it("rejects an opportunity set that drops an applicable behavior", () => {
    expect(() =>
      validateOpportunityCoverage(
        {
          practiceIds: ["practice-safe-write"],
          behaviorIds: ["practice-safe-write/behavior-1", "practice-safe-write/behavior-2"],
          proofIds: ["practice-safe-write/proof-1"],
          targetLayersByPracticeId: {
            "practice-safe-write": ["HTTP adapter"],
          },
        },
        [
          {
            id: "safe-parser",
            practiceIds: ["practice-safe-write"],
            behaviorIds: ["practice-safe-write/behavior-1"],
            proofIds: ["practice-safe-write/proof-1"],
            targetLayers: ["HTTP adapter"],
          },
        ],
      ),
    ).toThrow(/opportunity behavior coverage.*behavior-2/);
  });

  it("selects the smallest deterministic coverage-complete candidate set", () => {
    const selected = selectCoverageCompleteCandidates(
      ["practice-safe-write/behavior-1", "practice-safe-write/behavior-2"],
      [
        coverageCandidate("narrow-a", ["practice-safe-write/behavior-1"], 0.9),
        coverageCandidate("narrow-b", ["practice-safe-write/behavior-2"], 0.8),
        coverageCandidate(
          "cohesive-bundle",
          ["practice-safe-write/behavior-1", "practice-safe-write/behavior-2"],
          0.85,
        ),
      ],
    );

    expect(selected.map((candidate) => candidate.id)).toEqual(["cohesive-bundle"]);
  });

  it("plans one opportunity or promoted bundle directly and independent surfaces through children", () => {
    expect(
      selectPortfolioPlanningRoute([
        planningCandidate("one-opportunity", "opportunity", ["HTTP adapter"]),
      ]),
    ).toMatchObject({ kind: "direct" });
    expect(
      selectPortfolioPlanningRoute([
        planningCandidate("one-bundle", "bundle", ["HTTP adapter", "renderer"]),
      ]),
    ).toMatchObject({ kind: "direct" });
    expect(
      selectPortfolioPlanningRoute([
        planningCandidate("ingress", "opportunity", ["HTTP adapter"]),
        planningCandidate("rendering", "opportunity", ["renderer"]),
      ]),
    ).toEqual({
      kind: "child-synthesis",
      reason: "2 independent accepted change surfaces require focused child plans",
    });
  });

  it("accepts a portfolio draft only when exact coverage has byte-exact markdown evidence", () => {
    const required = {
      practiceIds: ["practice-boundaries"],
      behaviorIds: ["practice-boundaries/behavior-1"],
      proofIds: ["practice-boundaries/proof-1"],
      targetLayersByPracticeId: {
        "practice-boundaries": ["HTTP adapter", "request schema"],
      },
    };
    const draft = {
      title: "Boundary plan",
      summary: "Validate at ingress.",
      markdown: "# Boundary plan\n\nValidate requests in `src/http.ts` and test malformed input.",
      coverageClaims: [
        {
          practiceId: "practice-boundaries",
          behaviorIds: ["practice-boundaries/behavior-1"],
          proofIds: ["practice-boundaries/proof-1"],
          targetLayers: ["HTTP adapter"],
          evidenceQuotes: ["Validate requests in `src/http.ts`"],
        },
      ],
    };

    expect(() => validatePortfolioDraft(required, draft)).not.toThrow();
    expect(() =>
      validatePortfolioDraft(required, {
        ...draft,
        coverageClaims: [{ ...draft.coverageClaims[0]!, evidenceQuotes: ["invented quote"] }],
      }),
    ).toThrow(/exact markdown substring/);
    expect(() =>
      validatePortfolioDraft(required, {
        ...draft,
        coverageClaims: [{ ...draft.coverageClaims[0]!, targetLayers: ["invented layer"] }],
      }),
    ).toThrow(/unknown target layers.*invented layer/i);
  });

  it.each([
    [
      "leading bold pair",
      "**Phase 2 — Install Oxlint.** Add the package and verify the command.",
      "Phase 2 — Install Oxlint. Add the package and verify the command.",
    ],
    ["unordered dash", "- Add service unit tests.", "Add service unit tests."],
    ["unordered asterisk", "* Add HTTP integration tests.", "Add HTTP integration tests."],
    ["unordered plus", "+ Add DOM rendering tests.", "Add DOM rendering tests."],
    ["unchecked task", "- [ ] Add type checking.", "Add type checking."],
    ["lowercase checked task", "* [x] Add focused scripts.", "Add focused scripts."],
    ["uppercase checked task", "+ [X] Add README proof.", "Add README proof."],
    ["ordered dot", "12. Run the complete suite.", "Run the complete suite."],
    ["ordered parenthesis", "3) Inspect the report.", "Inspect the report."],
  ])("grounds one unique %s wrapper from canonical bytes", (_kind, canonicalLine, quote) => {
    const required = portfolioGroundingRequiredCoverage();
    const draft = portfolioGroundingDraft(
      quote,
      `${canonicalLine}\n\nAdditional canonical detail.`,
    );

    const grounded = groundPortfolioDraft(canonicalLine, draft);

    expect(grounded.changed).toBe(true);
    expect(grounded.draft).not.toBe(draft);
    expect(grounded.draft.coverageClaims[0]!.evidenceQuotes).toEqual([canonicalLine]);
    expect(() =>
      validatePortfolioDraftExtraction(required, canonicalLine, grounded.draft),
    ).not.toThrow();
  });

  it("preserves an already exact evidence quote", () => {
    const canonicalLine = "- [ ] Add service unit tests.";
    const draft = portfolioGroundingDraft(canonicalLine, canonicalLine);

    const grounded = groundPortfolioDraft(canonicalLine, draft);

    expect(grounded.changed).toBe(false);
    expect(grounded.draft.coverageClaims[0]!.evidenceQuotes).toEqual([canonicalLine]);
  });

  it("preserves a genuine exact substring when no wrapper-derived line matches", () => {
    const canonicalMarkdown = "The plan must add service unit tests before release.";
    const exactSubstring = "add service unit tests";
    const draft = portfolioGroundingDraft(exactSubstring, canonicalMarkdown);

    const grounded = groundPortfolioDraft(canonicalMarkdown, draft);

    expect(grounded.changed).toBe(false);
    expect(grounded.draft.coverageClaims[0]!.evidenceQuotes).toEqual([exactSubstring]);
  });

  it.each([
    ["one wrapper-derived sibling", "Add tests.\n- Add tests."],
    ["multiple wrapper-derived siblings", "Add tests.\n- Add tests.\n* Add tests."],
  ])("preserves a complete canonical line before considering %s", (_kind, canonicalMarkdown) => {
    const exactLine = "Add tests.";
    const draft = portfolioGroundingDraft(exactLine, canonicalMarkdown);

    const grounded = groundPortfolioDraft(canonicalMarkdown, draft);

    expect(grounded.changed).toBe(false);
    expect(grounded.draft.coverageClaims[0]!.evidenceQuotes).toEqual([exactLine]);
  });

  it.each([
    [
      "unordered",
      "- Add service unit tests.\n- Add service unit tests.",
      "Add service unit tests.",
    ],
    [
      "task",
      "- [ ] Add service unit tests.\n- [ ] Add service unit tests.",
      "Add service unit tests.",
    ],
    [
      "ordered",
      "7. Add service unit tests.\n7. Add service unit tests.",
      "Add service unit tests.",
    ],
  ])(
    "rejects multiple %s wrapper-derived lines before strict substring validation",
    (_kind, canonicalMarkdown, strippedQuote) => {
      const required = portfolioGroundingRequiredCoverage();
      const draft = portfolioGroundingDraft(strippedQuote, canonicalMarkdown);

      expect(() => {
        const grounded = groundPortfolioDraft(canonicalMarkdown, draft);
        validatePortfolioDraftExtraction(required, canonicalMarkdown, grounded.draft);
      }).toThrow(/ambiguously matches 2 canonical markdown lines/);
    },
  );

  it("fails explicitly for an ambiguous marker-normalized quote", () => {
    const canonicalLine = "**Phase 2 — Install Oxlint.** Add the package.";
    const canonicalMarkdown = `${canonicalLine}\n${canonicalLine}`;
    const required = portfolioGroundingRequiredCoverage();
    const draft = portfolioGroundingDraft(canonicalLine.replaceAll("**", ""), canonicalMarkdown);

    expect(() => {
      const grounded = groundPortfolioDraft(canonicalMarkdown, draft);
      validatePortfolioDraftExtraction(required, canonicalMarkdown, grounded.draft);
    }).toThrow(/ambiguously matches 2 canonical markdown lines/);
  });

  it.each(["Install the faster linter.", "fabricated quote", ""])(
    "does not ground non-marker or blank evidence %j",
    (invalidQuote) => {
      const canonicalMarkdown = "**Phase 2 — Install Oxlint.** Add the package.";
      const required = portfolioGroundingRequiredCoverage();
      const draft = portfolioGroundingDraft(invalidQuote, canonicalMarkdown);

      const grounded = groundPortfolioDraft(canonicalMarkdown, draft);

      expect(grounded.draft.coverageClaims[0]!.evidenceQuotes).toEqual([invalidQuote]);
      expect(() =>
        validatePortfolioDraftExtraction(required, canonicalMarkdown, grounded.draft),
      ).toThrow(/exact markdown substring/);
    },
  );

  it.each([
    ["combined list and bold removal", "- **Add service unit tests.**", "Add service unit tests."],
    ["indentation normalization", "  - Add service unit tests.", "Add service unit tests."],
    ["wrapper whitespace normalization", "-  Add service unit tests.", "Add service unit tests."],
    ["quote whitespace normalization", "- Add service unit tests.", " Add service unit tests."],
  ])("does not perform %s", (_kind, canonicalMarkdown, invalidQuote) => {
    const required = portfolioGroundingRequiredCoverage();
    const draft = portfolioGroundingDraft(invalidQuote, canonicalMarkdown);

    const grounded = groundPortfolioDraft(canonicalMarkdown, draft);

    expect(grounded.draft.coverageClaims[0]!.evidenceQuotes).toEqual([invalidQuote]);
    if (!canonicalMarkdown.includes(invalidQuote)) {
      expect(() =>
        validatePortfolioDraftExtraction(required, canonicalMarkdown, grounded.draft),
      ).toThrow(/exact markdown substring/);
    }
  });

  it("replaces the model markdown echo with harness-owned canonical bytes", () => {
    const canonicalMarkdown = "**Phase 2 — Install Oxlint.** Add the package.";
    const required = portfolioGroundingRequiredCoverage();
    const draft = portfolioGroundingDraft(canonicalMarkdown, `${canonicalMarkdown}\n`);

    const grounded = groundPortfolioDraft(canonicalMarkdown, draft);

    expect(grounded.changed).toBe(true);
    expect(grounded.draft.markdown).toBe(canonicalMarkdown);
    expect(() =>
      validatePortfolioDraftExtraction(required, canonicalMarkdown, grounded.draft),
    ).not.toThrow();
  });

  it("rejects semantic audits with incomplete behaviors or unresolved contradictions", () => {
    const required = {
      practiceIds: ["practice-boundaries"],
      behaviorIds: ["practice-boundaries/behavior-1"],
      proofIds: ["practice-boundaries/proof-1"],
      targetLayersByPracticeId: {
        "practice-boundaries": ["HTTP adapter"],
      },
    };
    const draft = {
      title: "Boundary plan",
      summary: "Validate at ingress.",
      markdown: "# Boundary plan\n\nValidate requests in `src/http.ts`.",
      coverageClaims: [
        {
          practiceId: "practice-boundaries",
          behaviorIds: required.behaviorIds,
          proofIds: required.proofIds,
          targetLayers: ["HTTP adapter"],
          evidenceQuotes: ["Validate requests in `src/http.ts`"],
        },
      ],
    };
    const audit = {
      behaviorAssessments: [
        {
          behaviorId: "practice-boundaries/behavior-1",
          status: "partial" as const,
          responsibleLayer: "HTTP adapter",
          evidenceQuotes: ["Validate requests in `src/http.ts`"],
          gaps: ["No malformed-input integration case"],
          rationale: "Implementation exists but proof is incomplete.",
        },
      ],
      specializedAssessments: [],
      unsupportedClaims: [],
      contradictions: ["Validation layer conflicts with the source."],
      summary: "Incomplete.",
    };

    expect(() => validatePortfolioAudit(required, [], draft, audit)).toThrow(
      /incomplete behaviors.*practice-boundaries\/behavior-1.*contradictions/,
    );
  });

  it("activates immutable tool-integration obligations without duplicating them", () => {
    expect(
      specializedObligationsFor(["tool-integration", "tool-integration"]).map(
        (obligation) => obligation.id,
      ),
    ).toEqual([
      "tool-installation",
      "configuration-translation",
      "compatibility-inventory",
      "workflow-enforcement",
      "migration-and-cleanup",
      "rollback",
    ]);
  });
});

function planningCandidate(id: string, kind: "opportunity" | "bundle", targetLayers: string[]) {
  return {
    id,
    kind,
    behaviorIds: [`practice-${id}/behavior-1`],
    targetLayers,
  };
}

function portfolioGroundingRequiredCoverage() {
  return {
    practiceIds: ["practice-install-config-native"],
    behaviorIds: ["practice-install-config-native/behavior-1"],
    proofIds: ["practice-install-config-native/proof-1"],
    targetLayersByPracticeId: {
      "practice-install-config-native": ["tooling"],
    },
  };
}

function portfolioGroundingDraft(evidenceQuote: string, markdown: string) {
  return {
    title: "Oxlint plan",
    summary: "Install Oxlint.",
    markdown,
    coverageClaims: [
      {
        practiceId: "practice-install-config-native",
        behaviorIds: ["practice-install-config-native/behavior-1"],
        proofIds: ["practice-install-config-native/proof-1"],
        targetLayers: ["tooling"],
        evidenceQuotes: [evidenceQuote],
      },
    ],
  };
}

function coverageCandidate(id: string, behaviorIds: string[], acceptanceScore: number) {
  return {
    id,
    practiceIds: ["practice-safe-write"],
    behaviorIds,
    proofIds: ["practice-safe-write/proof-1"],
    targetLayers: ["HTTP adapter"],
    acceptanceScore,
  };
}

function practiceDraft(id: string, behavior: string) {
  return {
    id,
    title: behavior,
    behavior,
    rationale: "Source-backed improvement.",
    adoptionPreconditions: ["The project exposes the relevant surface."],
    requiredBehaviors: [behavior],
    proofObligations: [`Prove: ${behavior}`],
    evidence: [],
  };
}

function applicableAssessment(practiceId: string, behaviorIds: string[]) {
  return {
    practiceId,
    status: "applicable" as const,
    applicableBehaviorIds: behaviorIds,
    excludedBehaviorIds: [],
    targetLayers: ["adapter"],
    projectEvidence: [{ id: "project-evidence", source: "src/adapter.ts", quote: "route" }],
    contradictionEvidence: [],
    rationale: "The adapter exposes this gap.",
  };
}
