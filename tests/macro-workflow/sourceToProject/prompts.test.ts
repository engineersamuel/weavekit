import { describe, expect, it } from "vitest";
import {
  buildChildPlanPrompt,
  buildDirectPortfolioPlanPrompt,
  buildDirectPortfolioPlanPromptWithDiagnostics,
  buildPlanPrompt,
  buildPortfolioPlanPrompt,
  buildPortfolioSynthesisPrompt,
  buildPortfolioSynthesisPromptWithDiagnostics,
} from "../../../src/macro-workflow/sourceToProject/prompts.js";

describe("source-to-project plan prompts", () => {
  it("keeps canonical compiler prompts focused on coverage without legacy duplicated context", () => {
    const canonicalCompilerContext = {
      originalObjective: "Apply every supported source practice.",
      projectJson: '{"projectId":"todo-app"}',
      practiceLedgerJson: '{"practices":[{"id":"practice-boundaries"}]}',
      applicabilityMatrixJson:
        '{"assessments":[{"practiceId":"practice-boundaries","status":"applicable"}]}',
      requiredCoverageJson:
        '{"behaviorIds":["practice-boundaries/behavior-1"],"proofIds":["practice-boundaries/proof-1"]}',
      acceptedOpportunityCoverageJson:
        '[{"id":"opp-boundaries","behaviorIds":["practice-boundaries/behavior-1"]}]',
      specializedObligationsJson: '[{"id":"obligation-boundary-proof"}]',
    };
    const legacyCompilerContext = {
      ...canonicalCompilerContext,
      sourceAnalysisJson: "REDUNDANT_SOURCE_ANALYSIS_SENTINEL",
      corroborationJson: "REDUNDANT_CORROBORATION_SENTINEL",
      discoveredOpportunities: ["REDUNDANT_DISCOVERED_OPPORTUNITIES_SENTINEL"],
      opportunityDecisions: ["REDUNDANT_OPPORTUNITY_DECISIONS_SENTINEL"],
    };

    const directPrompt = buildDirectPortfolioPlanPrompt(legacyCompilerContext);
    const childPrompt = buildChildPlanPrompt({
      ...legacyCompilerContext,
      candidateJson: '{"id":"opp-boundaries"}',
      assignedBehaviorIds: ["practice-boundaries/behavior-1"],
      assignedProofIds: ["practice-boundaries/proof-1"],
    });
    const synthesisPrompt = buildPortfolioSynthesisPrompt({
      ...legacyCompilerContext,
      childPlans: [
        {
          title: "Boundary plan",
          markdown: "RETAINED_CHILD_PLAN_SENTINEL: Validate the request adapter.",
        },
      ],
      opportunityReviews: [
        {
          title: "Boundary plan",
          status: "accepted",
          rationale: "RETAINED_REVIEW_FINDINGS_SENTINEL",
        },
      ],
    });

    for (const prompt of [directPrompt, childPrompt, synthesisPrompt]) {
      expect(prompt).toContain(canonicalCompilerContext.practiceLedgerJson);
      expect(prompt).toContain(canonicalCompilerContext.applicabilityMatrixJson);
      expect(prompt).toContain(canonicalCompilerContext.requiredCoverageJson);
      expect(prompt).toContain(canonicalCompilerContext.acceptedOpportunityCoverageJson);
      expect(prompt).toContain(canonicalCompilerContext.specializedObligationsJson);
      expect(prompt).not.toContain("REDUNDANT_SOURCE_ANALYSIS_SENTINEL");
      expect(prompt).not.toContain("REDUNDANT_CORROBORATION_SENTINEL");
      expect(prompt).not.toContain("REDUNDANT_DISCOVERED_OPPORTUNITIES_SENTINEL");
      expect(prompt).not.toContain("REDUNDANT_OPPORTUNITY_DECISIONS_SENTINEL");
    }

    expect(directPrompt).not.toContain("Accepted opportunity plans:");
    expect(childPrompt).toContain("Assigned behavior IDs");
    expect(childPrompt).toContain("practice-boundaries/behavior-1");
    expect(synthesisPrompt).toContain("Full required coverage set");
    expect(synthesisPrompt).toContain("Independent child plans");
    expect(synthesisPrompt).toContain("RETAINED_CHILD_PLAN_SENTINEL");
    expect(synthesisPrompt).toContain("RETAINED_REVIEW_FINDINGS_SENTINEL");
  });

  it("measures captured-scale canonical prompts below the direct-route reliability ceiling", () => {
    const compilerContext = {
      originalObjective: "Apply the full source portfolio safely.",
      projectJson: "P".repeat(4_744),
      practiceLedgerJson: "L".repeat(14_944),
      applicabilityMatrixJson: "A".repeat(14_751),
      requiredCoverageJson: "R".repeat(2_814),
      acceptedOpportunityCoverageJson: "C".repeat(4_461),
      specializedObligationsJson: "O".repeat(1_500),
    };

    const direct = buildDirectPortfolioPlanPromptWithDiagnostics(compilerContext);
    const synthesisArgs = {
      ...compilerContext,
      childPlans: [{ title: "Focused child", markdown: "Implement the assigned coverage." }],
      opportunityReviews: [
        { title: "Focused child", status: "accepted", rationale: "Coverage is complete." },
      ],
    };
    const synthesis = buildPortfolioSynthesisPromptWithDiagnostics(synthesisArgs);

    expect(direct.diagnostics.route).toBe("direct");
    expect(direct.diagnostics.totalChars).toBe(direct.prompt.length);
    expect(direct.diagnostics.totalChars).toBeLessThan(60_000);
    expect(buildDirectPortfolioPlanPrompt(compilerContext)).toBe(direct.prompt);
    expect(Object.keys(direct.diagnostics.sections)).toEqual([
      "planningInstructions",
      "routeGuidance",
      "originalObjective",
      "targetProject",
      "practiceLedger",
      "applicabilityMatrix",
      "requiredCoverage",
      "acceptedOpportunityCoverage",
      "specializedObligations",
    ]);
    expect(direct.diagnostics.sections.targetProject).toBe(
      `Target project:\n${compilerContext.projectJson}`.length,
    );
    for (const section of [
      "targetProject",
      "practiceLedger",
      "applicabilityMatrix",
      "requiredCoverage",
      "acceptedOpportunityCoverage",
      "specializedObligations",
    ]) {
      expect(direct.diagnostics.sections[section]).toBeGreaterThan(0);
    }
    expect(synthesis.diagnostics.route).toBe("synthesis");
    expect(synthesis.diagnostics.totalChars).toBe(synthesis.prompt.length);
    expect(buildPortfolioSynthesisPrompt(synthesisArgs)).toBe(synthesis.prompt);
    expect(synthesis.diagnostics.sections.opportunityReviewFindings).toBeGreaterThan(0);
    expect(synthesis.diagnostics.sections.childPlans).toBeGreaterThan(0);
  });

  it("keeps external-tool and content-schema mandates out of ordinary code-change plans", () => {
    const prompt = buildPlanPrompt(
      JSON.stringify({
        kind: "opportunity",
        id: "opp-validation",
        changeKind: "code-change",
        title: "Validate todo request bodies",
        projectChange: "Add request parsers and wire them into Express handlers.",
      }),
      JSON.stringify({ projectId: "todo-app", workingTree: "/tmp/todo-app" }),
    );

    expect(prompt).not.toContain("TOOL INTEGRATION COMPLETENESS");
    expect(prompt).not.toContain("BARE FILE FRONTMATTER SWEEP");
    expect(prompt).not.toContain("RAW/UNPROCESSED SOURCE INCLUSION JUSTIFICATION");
    expect(prompt).not.toContain("ignore file");
    expect(prompt).not.toContain("frontmatter");
    expect(prompt).toContain(
      "derive each input and identifier contract from current project behavior",
    );
    expect(prompt).toContain("malformed input from a well-formed but missing resource");
    expect(prompt).toContain(
      "both its focused unit check and its real adapter or integration check",
    );
    expect(prompt).toContain("Absence of validation is evidence of a boundary gap");
    expect(prompt).toContain("infer the canonical accepted identifier format");
    expect(prompt).toContain("Do not collapse evidence-named invalid cases");
    expect(prompt).toContain("add stable project scripts for those checks");
    expect(prompt).toContain("Perform a final coverage audit before returning the plan");
  });

  it("adds focused adoption guidance for an external-tool integration", () => {
    const prompt = buildPlanPrompt(
      JSON.stringify({
        kind: "opportunity",
        id: "opp-oxlint",
        changeKind: "tool-integration",
        title: "Replace ESLint with Oxlint",
        projectChange: "Adopt Oxlint using its native CLI and configuration.",
      }),
      JSON.stringify({ projectId: "web-app", workingTree: "/tmp/web-app" }),
    );

    expect(prompt).toContain("EXTERNAL TOOL INTEGRATION");
    expect(prompt).toContain("native configuration and ignore/scope mechanism");
    expect(prompt).toContain("existing validation or CI workflow");
    expect(prompt).toContain("existing content or code needs migration");
    expect(prompt).not.toContain("BARE FILE FRONTMATTER SWEEP");
  });

  it("preserves structured source requirements and review findings in portfolio synthesis", () => {
    const prompt = buildPortfolioPlanPrompt({
      originalObjective: "Apply the complete safe mutation and rendering slice.",
      projectJson: JSON.stringify({
        workingTree: "/tmp/todo-app",
        evidence: ["PATCH currently uses Boolean(req.body.completed)"],
      }),
      sourceAnalysisJson: JSON.stringify({
        claims: ["Validate request bodies and route parameters at the HTTP boundary."],
      }),
      corroborationJson: JSON.stringify({
        competingViews: ["Input validation does not replace safe output rendering."],
      }),
      opportunityPlans: [
        { title: "Backend safety", markdown: "Move validation into the service." },
        { title: "Safe rendering", markdown: "Render titles with textContent." },
      ],
      opportunityReviews: [
        {
          title: "Backend safety",
          status: "rejected",
          rationale: "The plan moved an HTTP-boundary responsibility into the service.",
          rejectionReason: "Boundary parser is missing.",
        },
      ],
    });

    expect(prompt).toContain("Current working directory is the target project's working tree");
    expect(prompt).toContain("Build a requirement ledger");
    expect(prompt).toContain("preserve its responsible architectural layer");
    expect(prompt).toContain("Boolean(req.body.completed)");
    expect(prompt).toContain("Validate request bodies and route parameters at the HTTP boundary");
    expect(prompt).toContain("Input validation does not replace safe output rendering");
    expect(prompt).toContain("Boundary parser is missing");
    expect(prompt).toContain("enumerate every invalid, edge, migration, and non-regression case");
  });
});
