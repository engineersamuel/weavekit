import type { EvaluateSummaryV3 } from "promptfoo";
import { describe, expect, it } from "vitest";
import type { AggregatedPlanQuality } from "../../../src/eval/sourceToProjectVerification/aggregation.js";
import type { ProjectVerificationCase } from "../../../src/eval/sourceToProjectVerification/case.js";
import {
  shouldSwapPairwiseOrder,
  type ResolvedPairwisePanel,
} from "../../../src/eval/sourceToProjectVerification/judge.js";
import type { ProjectVerificationManifest } from "../../../src/eval/sourceToProjectVerification/manifest.js";
import type { PromptfooJudgeTask } from "../../../src/eval/sourceToProjectVerification/promptfooJudgeProvider.js";
import { projectPromptfooJudgeResults } from "../../../src/eval/sourceToProjectVerification/promptfooJudgeResults.js";
import {
  ProjectVerificationProviderId,
  buildProjectVerificationScorecard as buildFreshProjectVerificationScorecard,
  parseProjectVerificationScorecard,
  renderProjectVerificationSummary,
  type ProjectVerificationScorecard,
} from "../../../src/eval/sourceToProjectVerification/scorecard.js";

type FreshScorecardArgs = Extract<
  Parameters<typeof buildFreshProjectVerificationScorecard>[0],
  { judgeEvaluationId: string }
>;

function buildProjectVerificationScorecard(
  args: Omit<FreshScorecardArgs, "judgeEvaluationId"> & { judgeEvaluationId?: string },
): ProjectVerificationScorecard {
  return buildFreshProjectVerificationScorecard({
    ...args,
    judgeEvaluationId: args.judgeEvaluationId ?? "eval-judge-scorecard",
  });
}

const CASE: ProjectVerificationCase = {
  id: "todo-safe-write",
  title: "Safe todo write path",
  objective: "Apply the source practices.",
  projectDir: "/tmp/project",
  sourcePath: "/tmp/source.md",
  expectedPractices: [
    {
      id: "validation",
      title: "Validation",
      sourceExpectation: "Validate input.",
      projectEvidence: ["server trusts input"],
      expectedPlanActions: ["add schema"],
    },
  ],
  antiGoals: [],
  rubric: [
    { criterion: "source-practice-coverage", weight: 0.3, levels: "coverage" },
    { criterion: "project-specific-diagnosis", weight: 0.25, levels: "specific" },
    { criterion: "implementation-completeness", weight: 0.25, levels: "complete" },
    { criterion: "verification-quality", weight: 0.15, levels: "verified" },
    { criterion: "scope-discipline", weight: 0.05, levels: "bounded" },
  ],
};

describe("source-to-project verification scorecard v2", () => {
  it("requires and renders both Promptfoo evaluation identities", () => {
    const scorecard = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: manifest(),
      qualities: [quality(ProjectVerificationProviderId.WEAVEKIT, 0.9)],
      pairwise: [],
      createdAt: "2026-07-12T12:00:00.000Z",
      judgeModels: ["gpt-5.5", "claude-opus-4.8"],
      judgeEvaluationId: "eval-judge-scorecard",
    });

    expect(scorecard.promptfoo).toEqual({
      generationEvaluationId: "eval-generation-scorecard",
      judgeEvaluationId: "eval-judge-scorecard",
    });
    expect(renderProjectVerificationSummary(scorecard)).toContain(
      "- Promptfoo evaluations: generation `eval-generation-scorecard`; judge `eval-judge-scorecard` (open with `nubx promptfoo view`)",
    );
    expect(() =>
      parseProjectVerificationScorecard(JSON.parse(JSON.stringify(scorecard))),
    ).not.toThrow();

    const missing = structuredClone(scorecard) as Partial<ProjectVerificationScorecard>;
    delete missing.promptfoo;
    expect(() => parseProjectVerificationScorecard(missing)).toThrow();
    expect(() =>
      parseProjectVerificationScorecard({ ...scorecard, unexpectedEvaluationId: "ambiguous" }),
    ).toThrow();
  });

  it("keeps a failed provider unscored when the judge projection has zero pairs", () => {
    const failedWeavekit: ProjectVerificationManifest["artifacts"][number] = artifact(
      ProjectVerificationProviderId.WEAVEKIT,
      100,
    );
    failedWeavekit.generationSucceeded = false;
    failedWeavekit.workspaceMutationVerified = true;
    delete failedWeavekit.planPath;
    delete failedWeavekit.sha256;
    failedWeavekit.errors = ["generation failed"];
    const scorecard = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: {
        ...manifest(),
        artifacts: [failedWeavekit, artifact(ProjectVerificationProviderId.CODEX, 200)],
      },
      qualities: [quality(ProjectVerificationProviderId.CODEX, 0.8)],
      pairwise: [],
      createdAt: "2026-07-12T12:00:00.000Z",
      judgeModels: ["gpt-5.5", "claude-opus-4.8"],
    });

    expect(scorecard.providers).toContainEqual(
      expect.objectContaining({
        id: ProjectVerificationProviderId.WEAVEKIT,
        generationSucceeded: false,
        qualityValid: false,
        errors: ["generation failed"],
      }),
    );
    expect(
      scorecard.providers.find(
        (provider) => provider.id === ProjectVerificationProviderId.WEAVEKIT,
      ),
    ).not.toHaveProperty("score");
    expect(scorecard.comparisons.pairs).toEqual([]);
  });

  it("ranks valid quality separately from generation and pairwise preference", () => {
    const scorecard = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: manifest(),
      qualities: [
        quality(ProjectVerificationProviderId.WEAVEKIT, 0.9),
        quality(ProjectVerificationProviderId.CODEX, 0.8),
      ],
      pairwise: [pair(ProjectVerificationProviderId.WEAVEKIT)],
      createdAt: "2026-07-10T12:00:00.000Z",
      judgeModels: ["gpt-5.5", "claude-opus-4.8"],
    });

    expect(scorecard.version).toBe(2);
    expect(scorecard.caseSha256).toBe("e".repeat(64));
    expect(scorecard.providers[0]).toMatchObject({
      id: ProjectVerificationProviderId.WEAVEKIT,
      generationSucceeded: true,
      workspaceMutationVerified: true,
      qualityValid: true,
      score: 0.9,
    });
    expect(scorecard.comparisons.weavekitMinusCodex).toBeCloseTo(0.1);
    expect(scorecard.comparisons.pairs[0]).toMatchObject({
      status: "agreed",
      winner: ProjectVerificationProviderId.WEAVEKIT,
    });
  });

  it("does not mark a generated provider failed when it loses pairwise", () => {
    const scorecard = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: manifest(),
      qualities: [
        quality(ProjectVerificationProviderId.WEAVEKIT, 0.8),
        quality(ProjectVerificationProviderId.CODEX, 0.9),
      ],
      pairwise: [pair(ProjectVerificationProviderId.CODEX)],
      createdAt: "2026-07-10T12:00:00.000Z",
      judgeModels: ["gpt-5.5", "claude-opus-4.8"],
    });

    expect(scorecard.providers.every((provider) => provider.generationSucceeded)).toBe(true);
    expect(scorecard.providers.every((provider) => provider.qualityValid)).toBe(true);
  });

  it("renders quality, pairwise, reliability, and efficiency as separate sections", () => {
    const scorecard = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: manifest(),
      qualities: [
        quality(ProjectVerificationProviderId.WEAVEKIT, 0.9),
        quality(ProjectVerificationProviderId.CODEX, 0.8),
      ],
      pairwise: [pair("tie")],
      createdAt: "2026-07-10T12:00:00.000Z",
      judgeModels: ["gpt-5.5", "claude-opus-4.8"],
    });
    const markdown = renderProjectVerificationSummary(scorecard);

    expect(markdown).toContain("## Absolute plan quality");
    expect(markdown).toContain("## Pairwise preference");
    expect(markdown).toContain("## Generation and mutation safety");
    expect(markdown).toContain("## Efficiency");
    expect(markdown).toContain(
      "| Provider | Latency ms | Tokens | Estimated cost USD | Retries | Model |",
    );
    expect(markdown).toContain("| Weavekit | 100 | 125 | 0.420000 | 2 | gpt-5.5 |");
    expect(markdown).toContain("## Weavekit opportunity diagnostics");
    expect(markdown).toContain("| Discovered opportunities | 3 |");
    expect(markdown).toContain("| Codex vs Weavekit | agreed | Tie |");
  });

  it("renders every provider and pairwise judgment error as one safe failure bullet", () => {
    const sourceManifest = manifest();
    const weavekitArtifact = sourceManifest.artifacts.find(
      (artifact) => artifact.providerId === ProjectVerificationProviderId.WEAVEKIT,
    )!;
    weavekitArtifact.errors = [
      "Generation timed out after retry.",
      "Workspace mutation was detected\n| restore required.",
      "Repeated   failure.",
    ];
    const weavekitQuality = quality(ProjectVerificationProviderId.WEAVEKIT, 0.9);
    weavekitQuality.errors = [
      "Absolute judge validation failed: score missing.",
      "Repeated\nfailure.",
    ];
    const scorecard = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: sourceManifest,
      qualities: [weavekitQuality, quality(ProjectVerificationProviderId.CODEX, 0.8)],
      pairwise: [
        {
          providerIds: [
            ProjectVerificationProviderId.CODEX,
            ProjectVerificationProviderId.WEAVEKIT,
          ],
          status: "single-judge",
          winner: "tie",
          judgments: [
            {
              judgeId: "gpt",
              planAProviderId: ProjectVerificationProviderId.CODEX,
              planBProviderId: ProjectVerificationProviderId.WEAVEKIT,
              elapsedMs: 1,
              mappedWinner: "tie",
            },
            {
              judgeId: "claude",
              planAProviderId: ProjectVerificationProviderId.WEAVEKIT,
              planBProviderId: ProjectVerificationProviderId.CODEX,
              elapsedMs: 1,
              error: "Transport failed on retry\n| socket closed.",
            },
          ],
        },
        {
          providerIds: [
            ProjectVerificationProviderId.CODEX,
            ProjectVerificationProviderId.WEAVEKIT,
          ],
          status: "invalid",
          judgments: [
            {
              judgeId: "parse-judge",
              planAProviderId: ProjectVerificationProviderId.CODEX,
              planBProviderId: ProjectVerificationProviderId.WEAVEKIT,
              elapsedMs: 1,
              error: "Could not parse judge response.",
            },
            {
              judgeId: "validation-judge",
              planAProviderId: ProjectVerificationProviderId.WEAVEKIT,
              planBProviderId: ProjectVerificationProviderId.CODEX,
              elapsedMs: 1,
              error: "Confidence must be between 0 and 1.",
            },
          ],
        },
      ],
      createdAt: "2026-07-10T12:00:00.000Z",
      judgeModels: ["gpt-5.5", "claude-opus-4.8"],
    });

    const markdown = renderProjectVerificationSummary(scorecard);

    expect(markdown).toContain("## Failure details");
    expect(markdown).toContain("- Provider Weavekit: Generation timed out after retry.");
    expect(markdown).toContain(
      "- Provider Weavekit: Workspace mutation was detected \\| restore required.",
    );
    expect(markdown).toContain(
      "- Provider Weavekit: Absolute judge validation failed: score missing.",
    );
    expect(markdown).toContain(
      "- Pairwise Codex vs Weavekit (judge claude): Transport failed on retry \\| socket closed.",
    );
    expect(markdown).toContain(
      "- Pairwise Codex vs Weavekit (judge parse-judge): Could not parse judge response.",
    );
    expect(markdown).toContain(
      "- Pairwise Codex vs Weavekit (judge validation-judge): Confidence must be between 0 and 1.",
    );
    expect(markdown.match(/- Provider Weavekit: Repeated failure\./g)).toHaveLength(1);
    expect(markdown).not.toContain("detected\n|");
    expect(markdown).not.toContain("retry\n|");
  });

  it("renders provider, error, and judge text as inert one-line Markdown", () => {
    const maliciousProviderId = "rogue_*provider*_<script>alert(1)</script>";
    const sourceManifest = manifest();
    const maliciousArtifact = sourceManifest.artifacts[0]!;
    maliciousArtifact.providerId = maliciousProviderId;
    maliciousArtifact.errors = [
      "**boom**\n<script>alert('x')</script> [retry](https://example.com)",
    ];
    const scorecard = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: sourceManifest,
      qualities: [
        quality(maliciousProviderId, 0.9),
        quality(ProjectVerificationProviderId.CODEX, 0.8),
      ],
      pairwise: [
        {
          providerIds: [ProjectVerificationProviderId.CODEX, maliciousProviderId],
          status: "invalid",
          judgments: [
            {
              judgeId: "judge_`hot`_<img src=x onerror=alert(1)>",
              planAProviderId: ProjectVerificationProviderId.CODEX,
              planBProviderId: maliciousProviderId,
              elapsedMs: 1,
              error: "Pairwise _failed_\n<b>now</b>.",
            },
          ],
        },
      ],
      createdAt: "2026-07-10T12:00:00.000Z",
      judgeModels: ["gpt-5.5"],
    });

    const details = failureDetails(renderProjectVerificationSummary(scorecard));

    expect(details).toContain(
      "- Provider rogue\\_\\*provider\\*\\_&lt;script&gt;alert(1)&lt;/script&gt;: \\*\\*boom\\*\\* &lt;script&gt;alert('x')&lt;/script&gt; \\[retry\\](https://example.com)",
    );
    expect(details).toContain(
      "- Pairwise Codex vs rogue\\_\\*provider\\*\\_&lt;script&gt;alert(1)&lt;/script&gt; (judge judge\\_\\`hot\\`\\_&lt;img src=x onerror=alert(1)&gt;): Pairwise \\_failed\\_ &lt;b&gt;now&lt;/b&gt;.",
    );
    expect(details).not.toContain("<script>");
    expect(details).not.toContain("<img");
    expect(details).not.toContain("**boom**");
    expect(details).not.toContain("[retry](https://example.com)");
  });

  it("renders every dynamic summary label as inert Markdown", () => {
    const scorecard = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: manifest(),
      qualities: [
        quality(ProjectVerificationProviderId.WEAVEKIT, 0.9),
        quality(ProjectVerificationProviderId.CODEX, 0.8),
      ],
      pairwise: [pair(ProjectVerificationProviderId.WEAVEKIT)],
      createdAt: "2026-07-10T12:00:00.000Z",
      judgeModels: ["gpt-5.5"],
    });
    scorecard.title = "<script>alert(1)</script> | title";
    scorecard.judgeModels = ["<img src=x> | judge"];
    scorecard.providers[0]!.model = "<svg onload=alert(1)> | model";
    scorecard.comparisons.pairs[0]!.providerIds = ["<b>left</b> | x", "right"];
    scorecard.comparisons.pairs[0]!.winner = "<b>left</b> | x";
    const diagnostics = scorecard.providers.find(
      (provider) => provider.id === ProjectVerificationProviderId.WEAVEKIT,
    )!.opportunityDiagnostics!;
    diagnostics.plannedOpportunityIds = ["<script>op</script> | id"];
    diagnostics.bundles = [{ id: "<b>bundle</b> | id", opportunityIds: ["<i>member</i> | id"] }];
    diagnostics.overlapOrContradictionFindings = ["<u>finding</u> | row"];

    const markdown = renderProjectVerificationSummary(scorecard);

    expect(markdown).not.toMatch(/<(?:script|img|svg|b|i|u)\b/i);
    expect(markdown).not.toContain(" | title");
    expect(markdown).not.toContain(" | judge");
    expect(markdown).not.toContain(" | model");
    expect(markdown).toContain("&lt;script&gt;alert(1)&lt;/script&gt; \\| title");
    expect(markdown).toContain("&lt;b&gt;bundle&lt;/b&gt; \\| id");
  });

  it("renders no failures when providers and pairwise judges have no errors", () => {
    const scorecard = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: manifest(),
      qualities: [
        quality(ProjectVerificationProviderId.WEAVEKIT, 0.9),
        quality(ProjectVerificationProviderId.CODEX, 0.8),
      ],
      pairwise: [
        {
          providerIds: [
            ProjectVerificationProviderId.CODEX,
            ProjectVerificationProviderId.WEAVEKIT,
          ],
          status: "disputed",
          judgments: [
            pairwiseJudgment("gpt", ProjectVerificationProviderId.CODEX, "First rationale."),
            pairwiseJudgment("claude", ProjectVerificationProviderId.WEAVEKIT, "Second rationale."),
          ],
        },
      ],
      createdAt: "2026-07-10T12:00:00.000Z",
      judgeModels: ["gpt-5.5", "claude-opus-4.8"],
    });

    const markdown = renderProjectVerificationSummary(scorecard);

    expect(markdown).toContain("| Codex vs Weavekit | disputed | n/a |");
    expect(markdown).toContain("## Failure details\n\n- None.");
    expect(markdown).not.toContain("First rationale.");
    expect(markdown).not.toContain("Second rationale.");
  });

  it("rejects legacy scorecards instead of reinterpreting them", () => {
    expect(() => parseProjectVerificationScorecard({ version: 1 })).toThrow();
  });

  it("rejects null and malformed stored pairwise judgment records", () => {
    const scorecard = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: manifest(),
      qualities: [
        quality(ProjectVerificationProviderId.WEAVEKIT, 0.9),
        quality(ProjectVerificationProviderId.CODEX, 0.8),
      ],
      pairwise: [
        {
          providerIds: [
            ProjectVerificationProviderId.CODEX,
            ProjectVerificationProviderId.WEAVEKIT,
          ],
          status: "single-judge",
          winner: ProjectVerificationProviderId.CODEX,
          judgments: [
            pairwiseJudgment("gpt", ProjectVerificationProviderId.CODEX, "Complete record."),
          ],
        },
      ],
      createdAt: "2026-07-10T12:00:00.000Z",
      judgeModels: ["gpt-5.5"],
    });
    const stored = JSON.parse(JSON.stringify(scorecard)) as {
      comparisons: { pairs: Array<{ judgments: unknown[] }> };
    };

    expect(() => parseProjectVerificationScorecard(stored)).not.toThrow();
    for (const malformed of [
      null,
      {},
      { judgeId: "judge-only" },
      {
        judgeId: "judge",
        planAProviderId: "a",
        planBProviderId: "b",
        elapsedMs: 1,
        result: { winner: "plan-a" },
      },
    ]) {
      const input = structuredClone(stored);
      input.comparisons.pairs[0]!.judgments = [malformed];
      expect(() => parseProjectVerificationScorecard(input)).toThrow();
    }
  });

  it("round-trips projected successful and failed pairwise accounting evidence", () => {
    const projected = projectedPairwisePanel();
    const scorecard = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: manifest(),
      qualities: [
        quality(ProjectVerificationProviderId.WEAVEKIT, 0.9),
        quality(ProjectVerificationProviderId.CODEX, 0.8),
      ],
      pairwise: projected.pairwise,
      createdAt: "2026-07-10T12:00:00.000Z",
      judgeModels: ["gpt", "claude"],
    });

    const parsed = parseProjectVerificationScorecard(JSON.parse(JSON.stringify(scorecard)));

    expect(parsed.comparisons.pairs).toEqual(projected.pairwise);
    expect(parsed.comparisons.pairs[0]!.judgments).toEqual([
      expect.objectContaining({
        judgeId: "gpt",
        reason: "Promptfoo judge assertion reason: valid",
        tokenUsage: { prompt: 10, completion: 5, total: 15 },
        cost: 0.2,
        result: expect.any(Object),
      }),
      expect.objectContaining({
        judgeId: "claude",
        reason: "Promptfoo judge assertion reason: assertion failed",
        tokenUsage: { prompt: 10, completion: 5, total: 15 },
        cost: 0.3,
        error: expect.stringContaining("transport failed"),
      }),
    ]);
  });

  it.each([
    ["negative cost", { cost: -1 }],
    ["non-finite cost", { cost: Number.POSITIVE_INFINITY }],
    ["negative token usage", { tokenUsage: { prompt: -1 } }],
    ["non-finite token usage", { tokenUsage: { prompt: Number.NaN } }],
  ])("rejects projected accounting metadata with %s", (_name, invalidAccounting) => {
    const stored = storedScorecard();
    Object.assign(stored.comparisons.pairs[0]!.judgments[0]!, invalidAccounting);

    expect(() => parseProjectVerificationScorecard(stored)).toThrow();
  });

  it("rejects pairwise records with invalid outcomes or mappings", () => {
    const stored = storedScorecard();
    const malformedInputs = [
      mutateStored(stored, (pair) => {
        pair.judgments[0]!.result!.confidence = 99;
      }),
      mutateStored(stored, (pair) => {
        pair.judgments[0]!.mappedWinner = "provider-outside-pair";
      }),
      mutateStored(stored, (pair) => {
        pair.judgments[0]!.error = "result and error cannot coexist";
      }),
      mutateStored(stored, (pair) => {
        pair.judgments[0]!.planBProviderId = pair.judgments[0]!.planAProviderId;
      }),
      mutateStored(stored, (pair) => {
        pair.judgments[0]!.mappedWinner = ProjectVerificationProviderId.WEAVEKIT;
      }),
    ];

    for (const malformed of malformedInputs) {
      expect(() => parseProjectVerificationScorecard(malformed)).toThrow();
    }
  });

  it("rejects pairwise panel status and winner inconsistencies", () => {
    const stored = storedScorecard();
    const agreedWithoutWinner = mutateStored(stored, (pair) => {
      delete pair.winner;
    });
    const disputedWithWinner = mutateStored(stored, (pair) => {
      pair.status = "disputed";
    });

    expect(() => parseProjectVerificationScorecard(agreedWithoutWinner)).toThrow();
    expect(() => parseProjectVerificationScorecard(disputedWithWinner)).toThrow();
  });

  it("rejects pairwise panel statuses that disagree with valid judgment outcomes", () => {
    const stored = storedScorecard();
    const agreedWithOneValidJudgment = mutateStored(stored, (pair) => {
      pair.status = "agreed";
    });
    const invalidWithOneValidJudgment = mutateStored(stored, (pair) => {
      pair.status = "invalid";
      delete pair.winner;
    });
    const disputedWithUnanimousJudgments = mutateStored(stored, (pair) => {
      pair.judgments.push(structuredClone(pair.judgments[0]!));
      pair.status = "disputed";
      delete pair.winner;
    });
    const singleJudgeWithTwoValidJudgments = mutateStored(stored, (pair) => {
      pair.judgments.push(structuredClone(pair.judgments[0]!));
    });

    expect(() => parseProjectVerificationScorecard(agreedWithOneValidJudgment)).toThrow();
    expect(() => parseProjectVerificationScorecard(invalidWithOneValidJudgment)).toThrow();
    expect(() => parseProjectVerificationScorecard(disputedWithUnanimousJudgments)).toThrow();
    expect(() => parseProjectVerificationScorecard(singleJudgeWithTwoValidJudgments)).toThrow();
  });

  it("rejects provider quality validity without exactly one finite score", () => {
    const missingScore = storedScorecard();
    const weavekit = missingScore.providers.find(
      (provider) => provider.id === ProjectVerificationProviderId.WEAVEKIT,
    )!;
    delete weavekit.score;

    const invalidWithScore = storedScorecard();
    invalidWithScore.providers.find(
      (provider) => provider.id === ProjectVerificationProviderId.WEAVEKIT,
    )!.qualityValid = false;

    expect(() => parseProjectVerificationScorecard(missingScore)).toThrow();
    expect(() => parseProjectVerificationScorecard(invalidWithScore)).toThrow();
  });

  it("rejects out-of-domain normalized scores and duplicate provider ids", () => {
    const invalidInputs = [
      (() => {
        const scorecard = storedScorecard();
        scorecard.providers[0]!.score = 99;
        return scorecard;
      })(),
      (() => {
        const scorecard = storedScorecard();
        scorecard.providers[0]!.criteria["project-specific-diagnosis"] = -1;
        return scorecard;
      })(),
      (() => {
        const scorecard = storedScorecard();
        scorecard.providers[0]!.practiceScores.validation = 2;
        return scorecard;
      })(),
      (() => {
        const scorecard = storedScorecard();
        scorecard.providers[0]!.requirementScores["validation/action-1"] = 7;
        return scorecard;
      })(),
      (() => {
        const scorecard = storedScorecard();
        scorecard.providers.push(structuredClone(scorecard.providers[0]!));
        return scorecard;
      })(),
      (() => {
        const scorecard = storedScorecard();
        scorecard.providers[0]!.generationSucceeded = false;
        scorecard.providers[0]!.workspaceMutationVerified = false;
        return scorecard;
      })(),
    ];

    for (const invalid of invalidInputs) {
      expect(() => parseProjectVerificationScorecard(invalid)).toThrow();
    }
  });

  it("fails clearly when a requested baseline has no valid Weavekit score", () => {
    const baseline = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: manifest(),
      qualities: [
        quality(ProjectVerificationProviderId.WEAVEKIT, 0.8),
        quality(ProjectVerificationProviderId.CODEX, 0.7),
      ],
      pairwise: [],
      createdAt: "2026-07-09T12:00:00.000Z",
      judgeModels: ["gpt-5.5"],
    });
    const baselineWeavekit = baseline.providers.find(
      (provider) => provider.id === ProjectVerificationProviderId.WEAVEKIT,
    )!;
    baselineWeavekit.qualityValid = false;
    delete baselineWeavekit.score;

    expect(() =>
      buildProjectVerificationScorecard({
        definition: CASE,
        manifest: manifest(),
        qualities: [
          quality(ProjectVerificationProviderId.WEAVEKIT, 0.9),
          quality(ProjectVerificationProviderId.CODEX, 0.8),
        ],
        pairwise: [],
        createdAt: "2026-07-10T12:00:00.000Z",
        judgeModels: ["gpt-5.5"],
        baseline: { path: "previous/scores.json", scorecard: baseline },
      }),
    ).toThrow(/baseline.*weavekit.*valid.*score/i);
  });

  it("preserves valid baseline delta and minimum threshold semantics", () => {
    const baseline = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: manifest(),
      qualities: [
        quality(ProjectVerificationProviderId.WEAVEKIT, 0.8),
        quality(ProjectVerificationProviderId.CODEX, 0.7),
      ],
      pairwise: [],
      createdAt: "2026-07-09T12:00:00.000Z",
      judgeModels: ["gpt-5.5"],
    });

    const scorecard = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: manifest(),
      qualities: [
        quality(ProjectVerificationProviderId.WEAVEKIT, 0.9),
        quality(ProjectVerificationProviderId.CODEX, 0.8),
      ],
      pairwise: [],
      createdAt: "2026-07-10T12:00:00.000Z",
      judgeModels: ["gpt-5.5"],
      baseline: { path: "previous/scores.json", scorecard: baseline },
      minimumWeavekitDelta: 0.05,
    });

    expect(scorecard.baselineComparison).toEqual({
      path: "previous/scores.json",
      baselineScore: 0.8,
      currentScore: 0.9,
      delta: 0.1,
      minimumDelta: 0.05,
      passed: true,
    });
  });

  it("rejects baselines from a different case fingerprint or judge panel", () => {
    const baseline = buildProjectVerificationScorecard({
      definition: CASE,
      manifest: manifest(),
      qualities: [quality(ProjectVerificationProviderId.WEAVEKIT, 0.8)],
      pairwise: [],
      createdAt: "2026-07-09T12:00:00.000Z",
      judgeModels: ["gpt-5.5"],
    });
    const current = {
      definition: CASE,
      manifest: manifest(),
      qualities: [quality(ProjectVerificationProviderId.WEAVEKIT, 0.9)],
      pairwise: [],
      createdAt: "2026-07-10T12:00:00.000Z",
      judgeModels: ["gpt-5.5"],
      baseline: { path: "previous/scores.json", scorecard: baseline },
    };

    baseline.caseSha256 = "f".repeat(64);
    expect(() => buildProjectVerificationScorecard(current)).toThrow(/fingerprint/i);

    baseline.caseSha256 = current.manifest.caseSha256;
    baseline.judgeModels = ["claude-opus-4.8"];
    expect(() => buildProjectVerificationScorecard(current)).toThrow(/judge panel/i);
  });
});

type StoredPair = {
  providerIds: [string, string];
  status: "agreed" | "disputed" | "single-judge" | "invalid";
  winner?: string;
  judgments: Array<{
    judgeId: string;
    planAProviderId: string;
    planBProviderId: string;
    elapsedMs: number;
    mappedWinner?: string;
    result?: { winner: "plan-a" | "plan-b" | "tie"; confidence: number };
    error?: string;
  }>;
};

type StoredScorecard = ProjectVerificationScorecard & {
  comparisons: ProjectVerificationScorecard["comparisons"] & { pairs: StoredPair[] };
};

function storedScorecard(): StoredScorecard {
  const scorecard = buildProjectVerificationScorecard({
    definition: CASE,
    manifest: manifest(),
    qualities: [
      quality(ProjectVerificationProviderId.WEAVEKIT, 0.9),
      quality(ProjectVerificationProviderId.CODEX, 0.8),
    ],
    pairwise: [
      {
        providerIds: [ProjectVerificationProviderId.CODEX, ProjectVerificationProviderId.WEAVEKIT],
        status: "single-judge",
        winner: ProjectVerificationProviderId.CODEX,
        judgments: [
          pairwiseJudgment("gpt", ProjectVerificationProviderId.CODEX, "Complete record."),
        ],
      },
    ],
    createdAt: "2026-07-10T12:00:00.000Z",
    judgeModels: ["gpt-5.5"],
  });
  return structuredClone(scorecard) as StoredScorecard;
}

function mutateStored(
  scorecard: StoredScorecard,
  mutate: (pair: StoredPair) => void,
): StoredScorecard {
  const mutated = structuredClone(scorecard);
  mutate(mutated.comparisons.pairs[0]!);
  return mutated;
}

function manifest(): ProjectVerificationManifest {
  return {
    version: 2,
    caseId: CASE.id,
    caseSha256: "e".repeat(64),
    createdAt: "2026-07-10T12:00:00.000Z",
    promptfooGenerationEvaluationId: "eval-generation-scorecard",
    artifacts: [
      artifact(ProjectVerificationProviderId.WEAVEKIT, 100),
      artifact(ProjectVerificationProviderId.CODEX, 200),
    ],
  };
}

function artifact(providerId: string, latencyMs: number) {
  return {
    providerId,
    generationSucceeded: true,
    workspaceMutationVerified: true,
    planPath: `/tmp/${providerId}.md`,
    sha256: "a".repeat(64),
    latencyMs,
    tokenUsage: { prompt: 100, completion: 25, total: 125 },
    estimatedCostUsd: 0.42,
    retries: 2,
    model: "gpt-5.5",
    ...(providerId === ProjectVerificationProviderId.WEAVEKIT
      ? {
          opportunityDiagnostics: {
            discoveredOpportunityCount: 3,
            acceptedOpportunityCount: 2,
            rejectedOpportunityCount: 1,
            bundleCount: 1,
            bundles: [{ id: "bundle-1", opportunityIds: ["o1", "o2"] }],
            plannedOpportunityIds: ["o1", "o2"],
            expectedPracticeRecallBeforePlanning: null,
            acceptedOpportunityRetention: 1,
            acceptedPracticeRetention: null,
            rejectedOpportunityIdsRestored: [],
            rejectedGroundedPracticesRestored: null,
            overlapOrContradictionFindings: [],
            unavailableMetrics: ["Requirement ids unavailable."],
          },
        }
      : {}),
    errors: [],
  };
}

function quality(providerId: string, score: number): AggregatedPlanQuality {
  return {
    providerId,
    valid: true,
    score,
    criteria: {
      "source-practice-coverage": score,
      "project-specific-diagnosis": score,
      "implementation-completeness": score,
      "verification-quality": score,
      "scope-discipline": score,
    },
    practiceScores: { validation: score },
    requirementScores: { "validation/action-1": score },
    contradictions: [],
    unsupportedRecommendations: [],
    errors: [],
    judgments: [],
  };
}

function pair(winner: string): ResolvedPairwisePanel {
  return {
    providerIds: [ProjectVerificationProviderId.CODEX, ProjectVerificationProviderId.WEAVEKIT],
    status: "agreed",
    winner,
    judgments: [],
  };
}

function pairwiseJudgment(judgeId: string, mappedWinner: string, rationale: string) {
  return {
    judgeId,
    planAProviderId: ProjectVerificationProviderId.CODEX,
    planBProviderId: ProjectVerificationProviderId.WEAVEKIT,
    elapsedMs: 1,
    mappedWinner,
    result: {
      winner: "plan-a" as const,
      confidence: 0.8,
      decidingFactors: [],
      planAStrengths: [],
      planAGaps: [],
      planBStrengths: [],
      planBGaps: [],
      rationale,
    },
  };
}

function projectedPairwisePanel() {
  const judgeIds = ["gpt", "claude"];
  const task = {
    kind: "pairwise",
    caseId: CASE.id,
    trialId: "trial-1",
    caseJson: JSON.stringify({ id: CASE.id, requirements: [], criteria: [] }),
    providerIds: [ProjectVerificationProviderId.CODEX, ProjectVerificationProviderId.WEAVEKIT],
    plans: {
      [ProjectVerificationProviderId.CODEX]: "Codex plan",
      [ProjectVerificationProviderId.WEAVEKIT]: "Weavekit plan",
    },
  } satisfies PromptfooJudgeTask;
  const rows = judgeIds.map((judgeId, index) =>
    projectedPairwiseRow(task, judgeIds, judgeId, index),
  );
  const summary = {
    version: 3,
    timestamp: "2026-07-10T12:00:00.000Z",
    results: rows,
    prompts: [],
    stats: {},
  } as unknown as EvaluateSummaryV3;
  return projectPromptfooJudgeResults({ summary, tasks: [task], judgeIds });
}

function projectedPairwiseRow(
  task: Extract<PromptfooJudgeTask, { kind: "pairwise" }>,
  judgeIds: string[],
  judgeId: string,
  index: number,
) {
  const swap = shouldSwapPairwiseOrder({
    caseId: task.caseId,
    trialId: task.trialId,
    leftProviderId: task.providerIds[0],
    rightProviderId: task.providerIds[1],
    judgeId,
    judgeIds,
  });
  const [planAProviderId, planBProviderId] = swap
    ? [task.providerIds[1], task.providerIds[0]]
    : [task.providerIds[0], task.providerIds[1]];
  const result = {
    winner: "plan-a" as const,
    confidence: 0.8,
    decidingFactors: [],
    planAStrengths: [],
    planAGaps: [],
    planBStrengths: [],
    planBGaps: [],
    rationale: "comparison",
  };
  const responseMetadata = {
    kind: "pairwise",
    judgeId,
    providerIds: task.providerIds,
    planAProviderId,
    planBProviderId,
    anonymousOrder: { planAProviderId, planBProviderId },
    ...(index === 0 ? { anonymousWinner: result.winner, mappedWinner: planAProviderId } : {}),
  };
  const providerId = `source-to-project-judge:${judgeId}`;
  return {
    success: index === 0,
    error: index === 0 ? undefined : "transport failed",
    failureReason: index === 0 ? 0 : 2,
    score: index === 0 ? 1 : 0,
    latencyMs: 20 + index,
    cost: index === 0 ? 0.2 : 0.3,
    tokenUsage: { prompt: 10, completion: 5, total: 15 },
    namedScores: {},
    promptIdx: 0,
    testIdx: 0,
    promptId: "prompt-1",
    provider: { id: providerId },
    prompt: { raw: JSON.stringify(task), label: "judge task" },
    vars: { task: JSON.stringify(task) },
    response: {
      ...(index === 0 ? { output: JSON.stringify(result) } : { error: "transport failed" }),
      metadata: responseMetadata,
    },
    gradingResult: {
      pass: index === 0,
      score: index === 0 ? 1 : 0,
      reason: index === 0 ? "valid" : "assertion failed",
    },
    metadata: responseMetadata,
    testCase: {
      description: `pairwise:${task.trialId}:${task.providerIds.join(":")}`,
      vars: { task: JSON.stringify(task) },
      metadata: {
        taskKind: task.kind,
        taskProviderIds: task.providerIds,
        judgeProviderIds: judgeIds.map((id) => `source-to-project-judge:${id}`),
        artifactHashes: Object.fromEntries(task.providerIds.map((id) => [id, "hash"])),
        caseId: task.caseId,
        trialId: task.trialId,
      },
    },
  };
}

function failureDetails(markdown: string): string {
  return markdown.split("## Failure details\n\n")[1]!.split("\n\n## Efficiency")[0]!;
}
