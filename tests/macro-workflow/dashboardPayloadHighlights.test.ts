import { describe, expect, it } from "vitest";
import {
  buildCouncilPersonaDisplay,
  buildDeepResearchQuestionBatchSummary,
  buildDeepResearchProviderFailureSummary,
  buildVerificationOpportunityAdvancementSummary,
} from "../../src/macro-workflow/dashboard/payloadHighlights.js";

describe("dashboard payload highlight helpers", () => {
  it("marks which verification opportunities advance to external research", () => {
    const summary = buildVerificationOpportunityAdvancementSummary({
      verificationOpportunityReview: {
        opportunities: [
          opportunity("opp-ci", "Add CI", 0.9),
          opportunity("baseline-lint-format", "Add lint and format", 0.8),
          opportunity("baseline-coverage-threshold", "Add coverage threshold", 0.7),
          opportunity("baseline-git-hooks", "Add git hooks", 0.6),
        ],
        rankingRationale: "CI, lint, and coverage ranked highest.",
      },
      verificationExternalResearchCandidates: [
        {
          opportunityId: "opp-ci",
          runId: "verification-research-opp-ci",
          reportNodeId: "verification-research-opp-ci-report",
        },
        {
          opportunityId: "baseline-coverage-threshold",
          runId: "verification-research-baseline-coverage-threshold",
          reportNodeId: "verification-research-baseline-coverage-threshold-report",
        },
      ],
    });

    expect(summary).toMatchObject({
      totalCount: 4,
      advancedCount: 2,
      notAdvancedCount: 2,
      capLabel: "2 of 4 advancing to external research",
    });
    expect(
      summary?.opportunities.map((item) => ({
        id: item.id,
        status: item.status,
        badgeLabel: item.badgeLabel,
        runId: item.runId,
      })),
    ).toEqual([
      {
        id: "opp-ci",
        status: "advanced",
        badgeLabel: "Advancing to research",
        runId: "verification-research-opp-ci",
      },
      {
        id: "baseline-lint-format",
        status: "not-advanced",
        badgeLabel: "Not advanced",
        runId: undefined,
      },
      {
        id: "baseline-coverage-threshold",
        status: "advanced",
        badgeLabel: "Advancing to research",
        runId: "verification-research-baseline-coverage-threshold",
      },
      {
        id: "baseline-git-hooks",
        status: "not-advanced",
        badgeLabel: "Not advanced",
        runId: undefined,
      },
    ]);
  });

  it("summarizes deep-research question batches and provider execution strategy", () => {
    const summary = buildDeepResearchQuestionBatchSummary({
      deepResearchRunId: "verification-research-baseline-coverage-threshold",
      deepResearchQuestionSet: {
        iteration: 1,
        questions: [
          {
            id: "q1-vitest-coverage",
            text: "How should Vitest coverage be configured?",
            researchMode: "official-docs",
            researchModeRationale: "Coverage setup is a docs/API usage question.",
            providerHints: ["exa"],
            searchQueries: ["Vitest coverage thresholds", "Vitest coverage provider v8"],
          },
          {
            id: "q2-recent-regressions",
            text: "Have there been recent Vitest coverage regressions?",
            researchMode: "recency-social",
            researchModeRationale: "Recent regressions should use community and recency providers.",
            providerHints: ["grok", "copilot-last30days"],
            searchQueries: ["Vitest coverage regression last 30 days"],
          },
        ],
      },
      deepResearchConfig: {
        providers: ["grok", "exa", "copilot-last30days"],
        maxResultsPerQuestion: 5,
      },
    });

    expect(summary).toMatchObject({
      runId: "verification-research-baseline-coverage-threshold",
      iteration: 1,
      questionCount: 2,
      providerCount: 3,
      maxResultsPerQuestion: 5,
      providerStrategy: [
        "official-docs routes to exa.",
        "recency-social routes to grok and copilot-last30days.",
      ],
    });
    expect(summary?.questions).toEqual([
      {
        id: "q1-vitest-coverage",
        text: "How should Vitest coverage be configured?",
        researchMode: "official-docs",
        researchModeLabel: "Official docs",
        researchModeRationale: "Coverage setup is a docs/API usage question.",
        routedProviders: ["exa"],
        providerHints: ["exa"],
        queryCount: 2,
      },
      {
        id: "q2-recent-regressions",
        text: "Have there been recent Vitest coverage regressions?",
        researchMode: "recency-social",
        researchModeLabel: "Recency/social",
        researchModeRationale: "Recent regressions should use community and recency providers.",
        routedProviders: ["grok", "copilot-last30days"],
        providerHints: ["grok", "copilot-last30days"],
        queryCount: 1,
      },
    ]);
  });

  it("summarizes degraded deep-research provider failures", () => {
    const summary = buildDeepResearchProviderFailureSummary({
      deepResearchRunId: "verification-research-opp-ci",
      deepResearchEvidence: [],
      deepResearchProviderFailures: [
        {
          provider: "grok",
          iteration: 1,
          retryCount: 1,
          message: "Command failed: grok -p Use x_search",
          questionIds: ["q1", "q2"],
        },
      ],
    });

    expect(summary).toEqual({
      runId: "verification-research-opp-ci",
      failureCount: 1,
      evidenceCount: 0,
      failures: [
        {
          provider: "grok",
          iteration: 1,
          retryCount: 1,
          message: "Command failed: grok -p Use x_search",
          questionCount: 2,
        },
      ],
    });
  });

  it("shows the real selected personas for a completed council deliberation", () => {
    const summary = buildCouncilPersonaDisplay({
      councilReview: { opportunities: [] },
      councilDeliberation: {
        status: "completed",
        personas: [
          { id: "feynman", name: "Feynman", archetype: "critic" },
          { id: "musashi", name: "Musashi", archetype: "synthesist" },
        ],
        personaSelectionRationale: "Selected personas with strong critique fit.",
        recommendation: "Proceed with the top-ranked opportunities.",
        rationale: ["Evidence is strong for opp-1 and opp-3."],
        strongestObjections: ["opp-2 is speculative and under-evidenced."],
        confidence: 0.82,
        convergence: 0.75,
        nextExperiment: "Validate opp-2 with a small spike before committing.",
        finalReportMarkdown: "# Council Report\n\nProceed.",
        model: "claude-sonnet-5",
      },
    });

    expect(summary).toEqual({
      status: "completed",
      personas: [
        { id: "feynman", name: "Feynman", archetype: "critic" },
        { id: "musashi", name: "Musashi", archetype: "synthesist" },
      ],
      personaSelectionRationale: "Selected personas with strong critique fit.",
      recommendation: "Proceed with the top-ranked opportunities.",
      rationale: ["Evidence is strong for opp-1 and opp-3."],
      strongestObjections: ["opp-2 is speculative and under-evidenced."],
      confidence: 0.82,
      convergence: 0.75,
      nextExperiment: "Validate opp-2 with a small spike before committing.",
      model: "claude-sonnet-5",
    });
  });

  it("surfaces the error message when persona deliberation failed", () => {
    const summary = buildCouncilPersonaDisplay({
      councilDeliberation: { status: "failed", error: "persona session timed out" },
    });

    expect(summary).toEqual({ status: "failed", error: "persona session timed out" });
  });

  it("returns null when no council deliberation ran (e.g. disabled or pre-feature runs)", () => {
    expect(buildCouncilPersonaDisplay({ councilReview: { opportunities: [] } })).toBeNull();
    expect(buildCouncilPersonaDisplay({})).toBeNull();
    expect(buildCouncilPersonaDisplay(null)).toBeNull();
  });

  it("returns null when the completed deliberation has no valid personas", () => {
    const summary = buildCouncilPersonaDisplay({
      councilDeliberation: {
        status: "completed",
        personas: [{ id: "", name: "" }],
        recommendation: "Proceed.",
      },
    });

    expect(summary).toBeNull();
  });
});

function opportunity(id: string, title: string, confidence: number) {
  return {
    id,
    title,
    currentVerificationGap: `${title} is missing.`,
    targetChange: `${title}.`,
    allowedChangeKind: "script",
    score: { confidence, impact: 0.7, risk: 0.2, implementationCost: 0.3 },
    evidence: [{ id: `${id}-evidence`, source: "fixture" }],
    proofCommands: ["nub run test"],
    speculative: false,
  };
}
