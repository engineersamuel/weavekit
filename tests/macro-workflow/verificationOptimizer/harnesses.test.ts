import { describe, expect, it } from "vitest";
import {
  WorkflowGateKind,
  WorkflowHarnessKind,
  WorkflowNodeKind,
  WorkflowNodeStatus,
} from "../../../src/macro-workflow/types.js";
import { runMacroWorkflow } from "../../../src/macro-workflow/runner.js";
import { materializeWorkflowPlan } from "../../../src/macro-workflow/templates.js";
import {
  createVerificationOptimizerDynamicExpander,
  createVerificationOptimizerHarnessRegistry,
  deriveBestPracticeVerificationOpportunities,
  prepareVerificationOptimizerCopilotExecution,
  selectVerificationOpportunity,
} from "../../../src/macro-workflow/verificationOptimizer/harnesses.js";
import { buildVerificationAuditPrompt } from "../../../src/macro-workflow/verificationOptimizer/prompts.js";
import type { ProjectCatalogEntry, VerificationOptimizerThresholds } from "../../../src/config.js";
import type {
  DeepResearchReport,
  VerificationAudit,
  VerificationOpportunity,
  VerificationOpportunityReview,
  VerificationRecommendationReview,
} from "../../../src/generated/baml_client/index.js";
import type { RuntimeWorkflowNode } from "../../../src/macro-workflow/types.js";
import type { WorkflowExecutionContext } from "../../../src/macro-workflow/harness.js";

describe("verification-optimizer harnesses", () => {
  it("prepares the full project verification audit prompt before Copilot execution", () => {
    const options = verificationOptimizerOptions();
    const plan = materializeWorkflowPlan("verification-optimizer", {
      objective: "Optimize verification",
      project: "weavekit",
      mode: "advisory",
    });
    const node = plan.nodes.find((candidate) => candidate.id === "project-verification-audit")!;
    const context = emptyExecutionContext();

    const execution = prepareVerificationOptimizerCopilotExecution(node, context, options);

    const expectedPrompt = buildVerificationAuditPrompt(options.project);
    expect(node.prompt).not.toBe(expectedPrompt);
    expect(execution).toMatchObject({
      executor: WorkflowHarnessKind.COPILOT_SDK,
      mode: "research",
      cwd: options.project.workingTree,
      model: node.model,
    });
    expect(execution?.prompt).toBe(expectedPrompt);
    expect(execution?.calls).toHaveLength(1);
    expect(execution?.calls?.[0]).toMatchObject({
      executor: "copilot-sdk",
      mode: "research",
      cwd: options.project.workingTree,
      model: node.model,
      prompt: expectedPrompt,
    });
    expect(execution?.calls?.[0]?.prompt).toBe(execution?.prompt);
  });

  it("publishes prepared execution metadata through the Copilot harness adapter", async () => {
    const options = verificationOptimizerOptions();
    const registry = createVerificationOptimizerHarnessRegistry(options);
    const plan = materializeWorkflowPlan("verification-optimizer", {
      objective: "Optimize verification",
      project: "weavekit",
      mode: "advisory",
    });
    const node = plan.nodes.find((candidate) => candidate.id === "project-verification-audit")!;

    const execution = await registry
      .get(WorkflowHarnessKind.COPILOT_SDK)
      ?.prepareExecution?.(node, emptyExecutionContext());

    expect(execution?.prompt).toBe(buildVerificationAuditPrompt(options.project));
    expect(execution?.calls?.[0]?.prompt).toBe(execution?.prompt);
  });

  it("delegates prepared execution metadata for embedded deep research nodes", async () => {
    const registry = createVerificationOptimizerHarnessRegistry(verificationOptimizerOptions());
    const execution = await registry
      .get(WorkflowHarnessKind.RESEARCH)
      ?.prepareExecution?.(
        embeddedProviderNodeFixture("copilot-last30days"),
        emptyExecutionContext(),
      );

    expect(execution?.calls?.[0]).toMatchObject({
      executor: "copilot-last30days",
      operation: "search",
      mode: "research",
      model: "claude-sonnet-5",
      prompt: expect.stringContaining("/last30days"),
    });
    expect(execution?.calls?.[0]?.prompt).toContain("What CI workflow should this repository use?");
    expect(execution?.calls?.[0]?.prompt).not.toBe(
      "Run copilot-last30days research for deep research iteration 1.",
    );
  });

  it("publishes actual BAML prompts for verification research nodes before they run", async () => {
    const registry = createVerificationOptimizerHarnessRegistry(verificationOptimizerOptions());
    const context = emptyExecutionContext();
    context.payloads.set("project-verification-audit", {
      verificationAudit: verificationAuditFixture(),
    });
    const execution = await registry.get(WorkflowHarnessKind.RESEARCH)?.prepareExecution?.(
      {
        id: "verification-opportunity-mapping",
        kind: WorkflowNodeKind.PLANNING,
        harness: WorkflowHarnessKind.RESEARCH,
        title: "Map verification opportunities",
        prompt: "Map the verification audit into strict verification-only opportunities.",
        dependsOn: ["project-verification-audit"],
        gates: [WorkflowGateKind.OUTPUT_CONTRACT],
        writeMode: "read-only",
        replanPolicy: "on-contract-failure",
      },
      context,
    );

    expect(execution?.calls?.[0]).toMatchObject({
      executor: "baml",
      operation: "MapVerificationOpportunities",
      prompt: expect.stringContaining("Verification audit:"),
    });
    expect(execution?.calls?.[0]?.prompt).toContain("No focused workflow verification fixture.");
    expect(execution?.calls?.[0]?.prompt).not.toBe(
      "Map the verification audit into strict verification-only opportunities.",
    );
  });

  it("runs replanned verification opportunity refinement retry nodes and compacts research reports", async () => {
    let capturedReports: Array<{ opportunityId: string; report: DeepResearchReport }> | undefined;
    const options = verificationOptimizerOptions({
      baml: {
        async RefineVerificationOpportunitiesWithResearch(
          _audit: VerificationAudit,
          initialReview: VerificationOpportunityReview,
          reports: Array<{ opportunityId: string; report: DeepResearchReport }>,
        ) {
          capturedReports = reports;
          return {
            ...initialReview,
            rankingRationale: "Retried and refined.",
          };
        },
      } as never,
    });
    const registry = createVerificationOptimizerHarnessRegistry(options);
    const context = emptyExecutionContext();
    context.payloads.set("project-verification-audit", {
      verificationAudit: verificationAuditFixture(),
    });
    context.payloads.set("verification-opportunity-mapping", {
      verificationOpportunityReview: {
        opportunities: [verificationOpportunityFixture({ id: "opp-ci" })],
        nonApplicableGaps: [],
        rankingRationale: "Initial local ranking.",
      },
      verificationExternalResearchCandidates: [
        {
          opportunityId: "opp-ci",
          runId: "verification-research-opp-ci",
          reportNodeId: "verification-research-opp-ci-report",
          objective: "Research CI verification",
        },
      ],
    });
    context.payloads.set("verification-research-opp-ci-report", {
      deepResearchReport: deepResearchReportFixture({
        markdown: "A".repeat(30_000),
        sources: Array.from({ length: 30 }, (_, index) => ({
          id: `source-${index}`,
          provider: "exa",
          url: `https://example.com/${index}`,
          title: `Source ${index}`,
          quality: "primary",
        })),
      }),
    });

    const result = await registry.get(WorkflowHarnessKind.RESEARCH)!(
      {
        id: "verification-opportunity-refinement-retry-1",
        kind: WorkflowNodeKind.PLANNING,
        harness: WorkflowHarnessKind.RESEARCH,
        title: "Refine verification opportunities (retry after transient client error)",
        prompt: "Retry: Refine verification opportunities with external deep research.",
        dependsOn: ["verification-research-opp-ci-report"],
        gates: [WorkflowGateKind.OUTPUT_CONTRACT],
        writeMode: "read-only",
        replanPolicy: "on-contract-failure",
      },
      context,
    );

    expect(result).toMatchObject({
      status: "passed",
      output: "Refined 1 verification opportunities with 1 external research report(s).",
      payload: {
        verificationOpportunityReview: {
          rankingRationale: expect.stringContaining("Retried and refined."),
        },
      },
    });
    expect(capturedReports?.[0]?.opportunityId).toBe("opp-ci");
    expect(capturedReports?.[0]?.report.markdown.length).toBeLessThan(8_000);
    expect(capturedReports?.[0]?.report.sources).toHaveLength(12);
  });

  it("expands replanned verification opportunity refinement retries into strict review", async () => {
    const options = verificationOptimizerOptions();
    const expansion = await createVerificationOptimizerDynamicExpander(options)({
      node: {
        id: "verification-opportunity-refinement-retry-1",
        kind: WorkflowNodeKind.PLANNING,
        harness: WorkflowHarnessKind.RESEARCH,
        title: "Refine verification opportunities (retry after transient client error)",
        prompt: "Retry: Refine verification opportunities with external deep research.",
        dependsOn: ["verification-research-opp-ci-report"],
        gates: [WorkflowGateKind.OUTPUT_CONTRACT],
        writeMode: "read-only",
        replanPolicy: "on-contract-failure",
      },
      result: {
        nodeId: "verification-opportunity-refinement-retry-1",
        status: WorkflowNodeStatus.PASSED,
        output: "Refined 1 verification opportunities.",
        payload: {
          verificationOpportunityReview: {
            opportunities: [verificationOpportunityFixture()],
            nonApplicableGaps: [],
            rankingRationale: "Retried and refined.",
          },
        },
      },
      currentPlan: {
        id: "plan-1",
        objective: "Optimize verification",
        templateId: "verification-optimizer",
        maxReplans: 0,
        nodes: [],
      },
      payloads: new Map(),
      completedNodeIds: new Set(),
    });

    expect(expansion?.map((node) => ({ id: node.id, dependsOn: node.dependsOn }))).toEqual([
      {
        id: "verification-review",
        dependsOn: ["verification-opportunity-refinement-retry-1"],
      },
    ]);
  });

  it("fails closed for unsupported verification optimizer research nodes", async () => {
    const registry = createVerificationOptimizerHarnessRegistry(verificationOptimizerOptions());

    const result = await registry.get(WorkflowHarnessKind.RESEARCH)!(
      {
        id: "verification-opportunity-unknown-retry-1",
        kind: WorkflowNodeKind.PLANNING,
        harness: WorkflowHarnessKind.RESEARCH,
        title: "Unknown research retry",
        prompt: "Retry an unknown research step.",
        dependsOn: [],
        gates: [WorkflowGateKind.OUTPUT_CONTRACT],
        writeMode: "read-only",
        replanPolicy: "on-contract-failure",
      },
      emptyExecutionContext(),
    );

    expect(result).toMatchObject({
      status: "failed",
      error: "Research harness does not support node verification-opportunity-unknown-retry-1.",
    });
  });

  it("does not prepare implementation execution metadata until upstream payloads exist", () => {
    const options = verificationOptimizerOptions({ mode: "autonomous-pr" });
    const node: RuntimeWorkflowNode = {
      id: "implement-verification-improvement",
      kind: WorkflowNodeKind.IMPLEMENTATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Implement verification improvement",
      prompt: "Implement the planned verification improvement.",
      dependsOn: [],
      gates: [],
      writeMode: "single-writer",
      replanPolicy: "on-verification-failure",
    };

    const execution = prepareVerificationOptimizerCopilotExecution(
      node,
      emptyExecutionContext(),
      options,
    );

    expect(execution).toBeUndefined();
  });

  it("does not prepare implementation review metadata until upstream review inputs exist", () => {
    const options = verificationOptimizerOptions({ mode: "autonomous-pr" });
    const node: RuntimeWorkflowNode = {
      id: "review-verification-implementation",
      kind: WorkflowNodeKind.DELIBERATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Review verification implementation",
      prompt: "Review the implemented verification improvement.",
      dependsOn: [],
      gates: [],
      writeMode: "read-only",
      replanPolicy: "never",
    };

    const execution = prepareVerificationOptimizerCopilotExecution(
      node,
      emptyExecutionContext(),
      options,
    );

    expect(execution).toBeUndefined();
  });

  it("prepares implementation and review prompts from available upstream payloads", () => {
    const options = verificationOptimizerOptions({ mode: "autonomous-pr" });
    const audit = verificationAuditFixture();
    const review = verificationReviewFixture();
    const context: WorkflowExecutionContext = {
      payloads: new Map([
        ["prepare-worktree", { worktreePreparation: { worktreePath: "/tmp/verification-wt" } }],
        ["project-verification-audit", { verificationAudit: audit }],
        ["verification-review", { verificationReview: review }],
      ]),
      artifacts: new Map(),
    };

    const implementationExecution = prepareVerificationOptimizerCopilotExecution(
      {
        id: "implement-verification-improvement",
        kind: WorkflowNodeKind.IMPLEMENTATION,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Implement verification improvement",
        model: "gpt-impl",
        prompt: "Implement the planned verification improvement.",
        dependsOn: [],
        gates: [],
        writeMode: "single-writer",
        replanPolicy: "on-verification-failure",
      },
      context,
      options,
    );
    const reviewExecution = prepareVerificationOptimizerCopilotExecution(
      {
        id: "review-verification-implementation",
        kind: WorkflowNodeKind.DELIBERATION,
        harness: WorkflowHarnessKind.COPILOT_SDK,
        title: "Review verification implementation",
        model: "gpt-review",
        prompt: "Review the implemented verification improvement.",
        dependsOn: [],
        gates: [],
        writeMode: "read-only",
        replanPolicy: "never",
      },
      context,
      options,
    );

    expect(implementationExecution).toMatchObject({
      executor: WorkflowHarnessKind.COPILOT_SDK,
      mode: "implement",
      cwd: "/tmp/verification-wt",
      model: "gpt-impl",
    });
    expect(implementationExecution?.prompt).toContain(
      "Implement the selected verification-only improvement",
    );
    expect(implementationExecution?.prompt).toContain(JSON.stringify(audit));
    expect(implementationExecution?.calls?.[0]?.prompt).toBe(implementationExecution?.prompt);

    expect(reviewExecution).toMatchObject({
      executor: WorkflowHarnessKind.COPILOT_SDK,
      mode: "review",
      cwd: "/tmp/verification-wt",
      model: "gpt-review",
    });
    expect(reviewExecution?.prompt).toContain(
      "Review the implemented verification-only improvement",
    );
    expect(reviewExecution?.prompt).toContain(JSON.stringify(review.proofCommands));
    expect(reviewExecution?.calls?.[0]?.prompt).toBe(reviewExecution?.prompt);
  });

  it("accepts only strict high-confidence verification opportunities", () => {
    const thresholds: VerificationOptimizerThresholds = {
      minConfidence: 0.85,
      minImpact: 0.6,
      maxRisk: 0.35,
      maxImplementationCost: 0.45,
      minEvidenceReferences: 2,
      requireNonSpeculative: true,
      requireProofCommands: true,
    };

    const accepted = selectVerificationOpportunity(
      [
        verificationOpportunityFixture({
          id: "low-confidence",
          score: { confidence: 0.84, impact: 0.9, risk: 0.2, implementationCost: 0.2 },
        }),
        verificationOpportunityFixture({
          id: "accepted",
          title: "Add focused workflow validation",
          score: { confidence: 0.9, impact: 0.7, risk: 0.2, implementationCost: 0.3 },
        }),
      ],
      thresholds,
    );

    expect(accepted.status).toBe("accepted");
    expect(accepted.selectedOpportunity?.id).toBe("accepted");
    expect(
      accepted.rejections.find((rejection) => rejection.id === "low-confidence")?.reason,
    ).toContain("confidence");
  });

  it("rejects speculative or under-evidenced opportunities", () => {
    const selection = selectVerificationOpportunity(
      [
        verificationOpportunityFixture({ id: "speculative", speculative: true }),
        verificationOpportunityFixture({ id: "under-evidenced", evidence: [evidence("one")] }),
        verificationOpportunityFixture({ id: "no-proof", proofCommands: [] }),
      ],
      defaultThresholds(),
    );

    expect(selection.status).toBe("rejected");
    expect(selection.selectedOpportunity).toBeUndefined();
    expect(selection.rejections.map((rejection) => rejection.id)).toEqual([
      "speculative",
      "under-evidenced",
      "no-proof",
    ]);
  });

  it("derives baseline feedback-loop opportunities from missing lint, hooks, and coverage evidence", () => {
    const opportunities = deriveBestPracticeVerificationOpportunities({
      ...verificationAuditFixture(),
      gaps: [
        "No lint or format scripts/configuration were found for ESLint, Prettier, Biome, or Oxlint.",
        "No git commit hooks were found under .husky, lefthook, or lint-staged configuration.",
        "No coverage script or coverage threshold configuration was found.",
      ],
      evidence: [
        evidence("package-json"),
        {
          id: "lint-scan",
          source: "repository lint/format config scan",
          quote:
            "No ESLint, Prettier, Biome, or Oxlint config detected; no package scripts for lint/format.",
        },
        {
          id: "hook-scan",
          source: "repository git hook config scan",
          quote: "No .husky, lefthook, or lint-staged configuration detected.",
        },
        {
          id: "coverage-scan",
          source: "package.json coverage gap",
          quote: "No coverage script or coverage thresholds were found.",
        },
      ],
    });

    expect(opportunities.map((opportunity) => opportunity.id)).toEqual([
      "baseline-lint-format",
      "baseline-git-hooks",
      "baseline-coverage-threshold",
    ]);
    expect(
      opportunities.find((opportunity) => opportunity.id === "baseline-coverage-threshold")
        ?.targetChange,
    ).toContain("100% threshold");
    expect(opportunities.every((opportunity) => !opportunity.speculative)).toBe(true);
    expect(opportunities.every((opportunity) => opportunity.evidence.length >= 2)).toBe(true);
    expect(opportunities.flatMap((opportunity) => opportunity.proofCommands)).toEqual(
      expect.arrayContaining([
        "nub run lint",
        "nub run format:check",
        "nub run prepare",
        "nub run coverage",
      ]),
    );
    expect(selectVerificationOpportunity(opportunities, defaultThresholds()).status).toBe(
      "accepted",
    );
  });

  it("promotes best-practice feedback-loop gaps even when BAML mapping returns no opportunities", async () => {
    const options = verificationOptimizerOptions({
      baml: {
        async DistillVerificationAudit() {
          return auditWithFeedbackLoopGaps();
        },
        async MapVerificationOpportunities() {
          return {
            opportunities: [],
            nonApplicableGaps: [],
            rankingRationale: "The model did not map baseline validation gaps.",
          };
        },
      },
    });

    const state = await runMacroWorkflow(
      materializeWorkflowPlan("verification-optimizer", {
        objective: "Optimize verification",
        project: "weavekit",
        mode: "advisory",
      }),
      {
        harnesses: createVerificationOptimizerHarnessRegistry(options),
        expandAfterNode: createVerificationOptimizerDynamicExpander(options),
      },
    );

    const mapping = state.nodeResults.find(
      (result) => result.nodeId === "verification-opportunity-mapping",
    )?.payload?.verificationOpportunityReview as
      | {
          opportunities?: VerificationOpportunity[];
        }
      | undefined;
    const review = state.nodeResults.find((result) => result.nodeId === "verification-review")
      ?.payload?.verificationReview as
      | {
          selectedOpportunity?: VerificationOpportunity;
          status?: string;
        }
      | undefined;
    const report = state.nodeResults.find(
      (result) => result.nodeId === "report-verification-opportunity",
    );

    expect(mapping?.opportunities?.map((opportunity) => opportunity.id)).toEqual([
      "baseline-lint-format",
      "baseline-git-hooks",
      "baseline-coverage-threshold",
    ]);
    expect(review).toMatchObject({
      status: "accepted",
      selectedOpportunity: { id: "baseline-lint-format" },
    });
    expect(state.nodeResults.map((result) => result.nodeId)).toContain(
      "report-verification-opportunity",
    );
    expect(state.nodeResults.map((result) => result.nodeId)).not.toContain(
      "report-no-verification-opportunity",
    );
    expect(report?.output).toContain("baseline-git-hooks");
    expect(report?.output).toContain("baseline-coverage-threshold");
  });

  it("does not dynamically insert external deep research when the opt-in flag is disabled", async () => {
    const options = verificationOptimizerOptions({
      verificationOptimizer: {
        mode: "advisory",
        externalResearch: false,
        thresholds: defaultThresholds(),
      },
      baml: {
        async MapVerificationOpportunities() {
          return {
            opportunities: [verificationOpportunityFixture({ id: "first" })],
            nonApplicableGaps: [],
            rankingRationale: "Initial local mapping.",
          };
        },
        async RefineVerificationOpportunitiesWithResearch() {
          throw new Error("refinement should not run when external research is disabled");
        },
      } as never,
    } as never);

    const state = await runMacroWorkflow(
      materializeWorkflowPlan("verification-optimizer", {
        objective: "Optimize verification",
        project: "weavekit",
        mode: "advisory",
        externalResearch: false,
      }),
      {
        harnesses: createVerificationOptimizerHarnessRegistry(options),
        expandAfterNode: createVerificationOptimizerDynamicExpander(options),
      },
    );

    expect(state.status).toBe("passed");
    expect(state.currentPlan.nodes.map((node) => node.id)).not.toContain(
      "verification-opportunity-refinement",
    );
    expect(
      state.currentPlan.nodes
        .map((node) => node.id)
        .filter((id) => id.startsWith("verification-research-")),
    ).toEqual([]);
  });

  it("inserts visible top-three candidate research DAGs before refinement and review", async () => {
    const providerObjectives: string[] = [];
    const compiledReports: Array<{ objective: string; evidenceIds: string[] }> = [];
    const refinedInputs: Array<{ opportunityId: string; objective: string }> = [];
    const opportunities = [
      verificationOpportunityFixture({
        id: "one",
        score: { confidence: 0.95, impact: 0.9, risk: 0.1, implementationCost: 0.1 },
      }),
      verificationOpportunityFixture({
        id: "two",
        score: { confidence: 0.94, impact: 0.85, risk: 0.1, implementationCost: 0.1 },
      }),
      verificationOpportunityFixture({
        id: "three",
        score: { confidence: 0.93, impact: 0.8, risk: 0.1, implementationCost: 0.1 },
      }),
      verificationOpportunityFixture({
        id: "four",
        score: { confidence: 0.7, impact: 0.6, risk: 0.2, implementationCost: 0.2 },
      }),
    ];
    const options = verificationOptimizerOptions({
      verificationOptimizer: {
        mode: "advisory",
        externalResearch: true,
        thresholds: defaultThresholds(),
      },
      deepResearch: {
        config: {
          providers: ["exa"],
          maxIterations: 1,
          questionsPerIteration: 1,
          maxResultsPerQuestion: 1,
        },
        providers: {
          exa: {
            async search(args: {
              objective: string;
              questions: Array<{ id: string }>;
              queries: string[];
            }) {
              providerObjectives.push(args.objective);
              const opportunityId =
                args.objective.match(/Opportunity ID: ([^\n]+)/u)?.[1] ?? "unknown";
              return [
                {
                  provider: "exa",
                  questionId: args.questions[0]?.id ?? `${opportunityId}-q1`,
                  query: args.queries[0] ?? "",
                  url: `https://example.com/${opportunityId}`,
                  title: `${opportunityId} research`,
                  excerpt: `External guidance for ${opportunityId}.`,
                  content: `External guidance for ${opportunityId}.`,
                  sourceQuality: "secondary",
                  provenance: "test provider",
                },
              ];
            },
          },
        },
        baml: {
          async GenerateResearchQuestions(prompt: string) {
            const opportunityId = prompt.match(/Opportunity ID: ([^\n]+)/u)?.[1] ?? "unknown";
            return {
              iteration: 1,
              questions: [
                {
                  id: `${opportunityId}-q1`,
                  text: `How should ${opportunityId} be verified?`,
                  rationale: "Need external approach guidance.",
                  priority: 1,
                  providerHints: ["exa"],
                  searchQueries: [`${opportunityId} verification approach`],
                  completionCriteria: ["Find one approach."],
                  status: "pending",
                  dependencies: [],
                },
              ],
            };
          },
          async AssessResearchIteration(
            questionSet: { questions: Array<{ id: string }> },
            evidence: Array<{ questionId: string }>,
          ) {
            expect(evidence.map((item) => item.questionId)).toEqual([questionSet.questions[0]?.id]);
            return {
              iteration: 1,
              questionCoverage: [
                {
                  questionId: questionSet.questions[0]?.id ?? "q1",
                  coverageScore: 0.9,
                  evidenceQuality: "medium",
                  contradictions: [],
                  gaps: [],
                },
              ],
              contradictions: [],
              newFollowUpQuestions: [],
              answerSufficient: true,
              stopReason: "complete",
            };
          },
          async CompileDeepResearchReport(
            prompt: string,
            finalState: { evidence: Array<{ id: string }> },
          ) {
            compiledReports.push({
              objective: prompt,
              evidenceIds: finalState.evidence.map((item) => item.id),
            });
            return { markdown: "# Deep Research Report\n\nCandidate guidance." };
          },
        },
      },
      baml: {
        async MapVerificationOpportunities() {
          return {
            opportunities,
            nonApplicableGaps: [],
            rankingRationale: "Initial local mapping.",
          };
        },
        async RefineVerificationOpportunitiesWithResearch(
          _audit: VerificationAudit,
          initialReview: VerificationOpportunityReview,
          reports: Array<{ opportunityId: string; objective: string }>,
        ) {
          refinedInputs.push(...reports);
          return {
            ...initialReview,
            opportunities: initialReview.opportunities.map((opportunity) =>
              opportunity.id === "one"
                ? {
                    ...opportunity,
                    targetChange: "Use externally researched verification approach.",
                  }
                : opportunity,
            ),
            rankingRationale: "Refined after visible research nodes.",
          };
        },
      } as never,
    } as never);

    const state = await runMacroWorkflow(
      materializeWorkflowPlan("verification-optimizer", {
        objective: "Optimize verification",
        project: "weavekit",
        mode: "advisory",
        externalResearch: true,
      }),
      {
        harnesses: createVerificationOptimizerHarnessRegistry(options),
        expandAfterNode: createVerificationOptimizerDynamicExpander(options),
      },
    );

    expect(state.status).toBe("passed");
    expect(
      providerObjectives.map((objective) => objective.match(/Opportunity ID: ([^\n]+)/u)?.[1]),
    ).toEqual(["one", "two", "three"]);
    expect(providerObjectives.some((objective) => objective.includes("Opportunity ID: four"))).toBe(
      false,
    );
    expect(refinedInputs.map((input) => input.opportunityId)).toEqual(["one", "two", "three"]);
    expect(state.currentPlan.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "verification-research-one-questions-1",
        "verification-research-one-exa-1",
        "verification-research-one-assess-1",
        "verification-research-one-report",
        "verification-research-two-report",
        "verification-research-three-report",
        "verification-opportunity-refinement",
        "verification-review",
        "report-verification-opportunity",
      ]),
    );
    expect(state.currentPlan.nodes.map((node) => node.id)).not.toContain(
      "verification-research-four-questions-1",
    );
    expect(
      state.currentPlan.nodes.find((node) => node.id === "verification-opportunity-refinement")
        ?.dependsOn,
    ).toEqual([
      "verification-research-one-report",
      "verification-research-two-report",
      "verification-research-three-report",
    ]);
    expect(
      state.currentPlan.nodes.find((node) => node.id === "verification-review")?.dependsOn,
    ).toEqual(["verification-opportunity-refinement"]);
    expect(
      state.nodeResults
        .map((result) => result.nodeId)
        .indexOf("verification-opportunity-refinement"),
    ).toBeGreaterThan(
      state.nodeResults
        .map((result) => result.nodeId)
        .indexOf("verification-research-three-report"),
    );
    expect(
      state.nodeResults.map((result) => result.nodeId).indexOf("verification-review"),
    ).toBeGreaterThan(
      state.nodeResults
        .map((result) => result.nodeId)
        .indexOf("verification-opportunity-refinement"),
    );
    expect(compiledReports).toEqual([
      { objective: expect.stringContaining("Opportunity ID: one"), evidenceIds: ["exa-1-1"] },
      { objective: expect.stringContaining("Opportunity ID: two"), evidenceIds: ["exa-1-1"] },
      { objective: expect.stringContaining("Opportunity ID: three"), evidenceIds: ["exa-1-1"] },
    ]);
    expect(
      state.nodeResults.find((result) => result.nodeId === "verification-opportunity-refinement")
        ?.payload?.verificationOpportunityReview,
    ).toMatchObject({
      opportunities: expect.arrayContaining([
        expect.objectContaining({
          id: "one",
          targetChange: "Use externally researched verification approach.",
          evidence: [
            expect.objectContaining({ id: "audit-1" }),
            expect.objectContaining({ id: "audit-2" }),
          ],
        }),
      ]),
    });
  });

  it("does not let external research supply repository evidence for strict gates", async () => {
    const options = verificationOptimizerOptions({
      verificationOptimizer: {
        mode: "advisory",
        externalResearch: true,
        thresholds: defaultThresholds(),
      },
      deepResearch: {
        config: {
          providers: ["exa"],
          maxIterations: 1,
          questionsPerIteration: 1,
          maxResultsPerQuestion: 1,
        },
        providers: {
          exa: {
            async search(args: {
              objective: string;
              questions: Array<{ id: string }>;
              queries: string[];
            }) {
              return [
                {
                  provider: "exa",
                  questionId: args.questions[0]?.id ?? "q1",
                  query: args.queries[0] ?? "",
                  url: "https://example.com/external",
                  title: "External research",
                  excerpt: args.objective,
                  content: args.objective,
                  sourceQuality: "secondary",
                  provenance: "test provider",
                },
              ];
            },
          },
        },
        baml: {
          async GenerateResearchQuestions() {
            return {
              iteration: 1,
              questions: [
                {
                  id: "q1",
                  text: "Which external tool should be used?",
                  rationale: "Need external approach guidance.",
                  priority: 1,
                  providerHints: ["exa"],
                  searchQueries: ["external verification tool"],
                  completionCriteria: ["Find one source."],
                  status: "pending",
                  dependencies: [],
                },
              ],
            };
          },
          async AssessResearchIteration() {
            return {
              iteration: 1,
              questionCoverage: [
                {
                  questionId: "q1",
                  coverageScore: 0.9,
                  evidenceQuality: "medium",
                  contradictions: [],
                  gaps: [],
                },
              ],
              contradictions: [],
              newFollowUpQuestions: [],
              answerSufficient: true,
              stopReason: "complete",
            };
          },
          async CompileDeepResearchReport() {
            return { markdown: "# Deep Research Report\n\nExternal tool guidance." };
          },
        },
      },
      baml: {
        async MapVerificationOpportunities() {
          return {
            opportunities: [
              verificationOpportunityFixture({
                id: "under-evidenced",
                evidence: [evidence("local-only")],
              }),
            ],
            nonApplicableGaps: [],
            rankingRationale: "Initial local mapping.",
          };
        },
        async RefineVerificationOpportunitiesWithResearch() {
          return {
            opportunities: [
              verificationOpportunityFixture({
                id: "under-evidenced",
                targetChange: "Use externally recommended verification tooling.",
                evidence: [evidence("external-1"), evidence("external-2"), evidence("external-3")],
              }),
            ],
            nonApplicableGaps: [],
            rankingRationale: "External research suggests a tool.",
          };
        },
      } as never,
    } as never);

    const state = await runMacroWorkflow(
      materializeWorkflowPlan("verification-optimizer", {
        objective: "Optimize verification",
        project: "weavekit",
        mode: "advisory",
        externalResearch: true,
      }),
      {
        harnesses: createVerificationOptimizerHarnessRegistry(options),
        expandAfterNode: createVerificationOptimizerDynamicExpander(options),
      },
    );

    const refinement = state.nodeResults.find(
      (result) => result.nodeId === "verification-opportunity-refinement",
    )?.payload?.verificationOpportunityReview as
      | {
          opportunities?: VerificationOpportunity[];
        }
      | undefined;
    const selection = state.nodeResults.find((result) => result.nodeId === "verification-review")
      ?.payload?.verificationOpportunitySelection as
      | {
          status?: string;
          rejections?: Array<{ id: string; reason: string }>;
        }
      | undefined;

    expect(refinement?.opportunities?.[0]?.targetChange).toBe(
      "Use externally recommended verification tooling.",
    );
    expect(refinement?.opportunities?.[0]?.evidence.map((entry) => entry.id)).toEqual([
      "local-only",
    ]);
    expect(selection?.status).toBe("rejected");
    expect(selection?.rejections?.[0]).toMatchObject({
      id: "under-evidenced",
      reason: expect.stringContaining("requires at least 2 evidence references"),
    });
  });

  it("inserts review directly when external research has no candidates", async () => {
    const options = verificationOptimizerOptions({
      verificationOptimizer: {
        mode: "advisory",
        externalResearch: true,
        thresholds: defaultThresholds(),
      },
      baml: {
        async MapVerificationOpportunities() {
          return {
            opportunities: [],
            nonApplicableGaps: ["No evidenced candidates."],
            rankingRationale: "No candidates.",
          };
        },
      },
    });

    const state = await runMacroWorkflow(
      materializeWorkflowPlan("verification-optimizer", {
        objective: "Optimize verification",
        project: "weavekit",
        mode: "advisory",
        externalResearch: true,
      }),
      {
        harnesses: createVerificationOptimizerHarnessRegistry(options),
        expandAfterNode: createVerificationOptimizerDynamicExpander(options),
      },
    );

    expect(state.status).toBe("passed");
    expect(state.currentPlan.nodes.map((node) => node.id)).toContain("verification-review");
    expect(
      state.currentPlan.nodes.find((node) => node.id === "verification-review")?.dependsOn,
    ).toEqual(["verification-opportunity-mapping"]);
    expect(state.currentPlan.nodes.map((node) => node.id)).not.toContain(
      "verification-opportunity-refinement",
    );
    expect(state.nodeResults.map((result) => result.nodeId)).toContain(
      "report-no-verification-opportunity",
    );
  });

  it("expands a rejected review into a no-op report", async () => {
    const options = verificationOptimizerOptions({
      baml: {
        async MapVerificationOpportunities() {
          return {
            opportunities: [
              verificationOpportunityFixture({
                id: "weak",
                score: { confidence: 0.5, impact: 0.4, risk: 0.2, implementationCost: 0.2 },
              }),
            ],
            nonApplicableGaps: [],
            rankingRationale: "No high-confidence verification-only improvement exists.",
          };
        },
      },
    });
    const state = await runMacroWorkflow(
      materializeWorkflowPlan("verification-optimizer", {
        objective: "Optimize verification",
        project: "weavekit",
        mode: "advisory",
      }),
      {
        harnesses: createVerificationOptimizerHarnessRegistry(options),
        expandAfterNode: createVerificationOptimizerDynamicExpander(options),
      },
    );

    expect(state.status).toBe("passed");
    expect(state.nodeResults.map((result) => result.nodeId)).toContain(
      "report-no-verification-opportunity",
    );
    expect(
      state.nodeResults.some((result) => result.nodeId === "implement-verification-improvement"),
    ).toBe(false);
  });

  it("expands an accepted review into worktree, implementation, verification, review, and PR nodes", async () => {
    const calls: string[] = [];
    const options = verificationOptimizerOptions({
      mode: "autonomous-pr",
      project: { ...projectFixture(), autonomousPrAllowed: true },
      copilot: {
        async run(args) {
          calls.push(args.mode);
          return args.mode === "review" ? "review accepted" : "raw output";
        },
      },
      worktree: {
        async prepare() {
          calls.push("prepare-worktree");
          return {
            worktreePath: "/tmp/verification-wt",
            branchName: "verification-optimizer/accepted",
            baselineCommit: "abc123",
            copiedEnvFiles: [".env"],
          };
        },
      },
      shell: {
        async run(command, args) {
          calls.push([command, ...args].join(" "));
          return command === "gh" ? "https://example.com/pr/verification\n" : "ok\n";
        },
      },
    });

    const state = await runMacroWorkflow(
      materializeWorkflowPlan("verification-optimizer", {
        objective: "Optimize verification",
        project: "weavekit",
        mode: "autonomous-pr",
      }),
      {
        harnesses: createVerificationOptimizerHarnessRegistry(options),
        expandAfterNode: createVerificationOptimizerDynamicExpander(options),
      },
    );

    expect(state.status).toBe("passed");
    expect(state.nodeResults.map((result) => result.nodeId)).toEqual([
      "project-verification-audit",
      "verification-opportunity-mapping",
      "verification-review",
      "prepare-worktree",
      "implement-verification-improvement",
      "run-verification-commands",
      "review-verification-implementation",
      "open-pr",
    ]);
    expect(calls.indexOf("prepare-worktree")).toBeLessThan(calls.indexOf("implement"));
    expect(state.nodeResults.find((result) => result.nodeId === "open-pr")?.payload).toEqual({
      prUrl: "https://example.com/pr/verification",
    });
  });

  it("runs project validation commands plus selected proof commands", async () => {
    const commands: string[] = [];
    const options = verificationOptimizerOptions({
      mode: "autonomous-pr",
      project: {
        ...projectFixture(),
        validationCommands: ["nub run typecheck"],
        autonomousPrAllowed: true,
      },
      worktree: {
        async prepare() {
          return {
            worktreePath: "/tmp/verification-wt",
            branchName: "verification-optimizer/accepted",
            baselineCommit: "abc123",
            copiedEnvFiles: [".env"],
          };
        },
      },
      shell: {
        async run(command, args) {
          commands.push(command === "gh" ? command : (args[1] ?? command));
          return "ok\n";
        },
      },
      baml: {
        async MapVerificationOpportunities() {
          return {
            opportunities: [
              verificationOpportunityFixture({ proofCommands: ["nub run test -- verification"] }),
            ],
            nonApplicableGaps: [],
            rankingRationale: "Proof command is explicit.",
          };
        },
      },
    });

    const state = await runMacroWorkflow(
      materializeWorkflowPlan("verification-optimizer", {
        objective: "Optimize verification",
        project: "weavekit",
        mode: "autonomous-pr",
      }),
      {
        harnesses: createVerificationOptimizerHarnessRegistry(options),
        expandAfterNode: createVerificationOptimizerDynamicExpander(options),
      },
    );

    expect(state.status).toBe("passed");
    expect(commands).toEqual(["nub run typecheck", "nub run test -- verification", "gh"]);
    expect(
      state.nodeResults.find((result) => result.nodeId === "run-verification-commands")?.payload,
    ).toMatchObject({
      verificationCommands: ["nub run typecheck", "nub run test -- verification"],
    });
  });
});

function emptyExecutionContext(): WorkflowExecutionContext {
  return {
    payloads: new Map(),
    artifacts: new Map(),
  };
}

function verificationOptimizerOptions(
  overrides: Partial<Parameters<typeof createVerificationOptimizerHarnessRegistry>[0]> = {},
) {
  return {
    project: projectFixture(),
    mode: "advisory" as const,
    ...overrides,
  };
}

function embeddedProviderNodeFixture(provider: string): RuntimeWorkflowNode {
  return {
    id: `verification-research-opp-ci-${provider}-1`,
    kind: WorkflowNodeKind.RESEARCH,
    harness: WorkflowHarnessKind.RESEARCH,
    title: `Research with ${provider}`,
    prompt: `Run ${provider} research for deep research iteration 1.`,
    input: {
      deepResearchStep: "provider-research",
      deepResearchRunId: "verification-research-opp-ci",
      objective: "Research CI verification",
      provider,
      iteration: 1,
      questions: [
        {
          id: "q1",
          text: "What CI workflow should this repository use?",
          rationale: "Need CI evidence.",
          priority: 1,
          providerHints: [provider],
          searchQueries: ["Node TypeScript GitHub Actions CI"],
          completionCriteria: ["Find CI guidance."],
          status: "pending",
          dependencies: [],
        },
      ],
      queries: ["Node TypeScript GitHub Actions CI"],
      maxResultsPerQuestion: 5,
      questionNodeId: "verification-research-opp-ci-questions-1",
      config: {
        providers: ["grok", "copilot-last30days", "exa"],
        maxIterations: 1,
        questionsPerIteration: 1,
        maxResultsPerQuestion: 5,
        providerRetryAttempts: 1,
        visualize: false,
      },
    },
    dependsOn: ["verification-research-opp-ci-questions-1"],
    gates: [WorkflowGateKind.OUTPUT_CONTRACT],
    writeMode: "read-only",
    replanPolicy: "never",
  };
}

function projectFixture(): ProjectCatalogEntry {
  return {
    id: "weavekit",
    displayName: "Weavekit",
    workingTree: "/repo/weavekit",
    mainline: "origin main",
    remote: "origin",
    contextDocs: ["CONTEXT.md"],
    validationCommands: ["nub run typecheck"],
    autonomousPrAllowed: false,
    notification: "cli",
    knowledgeExport: "off",
  };
}

function defaultThresholds(): VerificationOptimizerThresholds {
  return {
    minConfidence: 0.85,
    minImpact: 0.6,
    maxRisk: 0.35,
    maxImplementationCost: 0.45,
    minEvidenceReferences: 2,
    requireNonSpeculative: true,
    requireProofCommands: true,
  };
}

function verificationAuditFixture(): VerificationAudit {
  return {
    projectId: "weavekit",
    summary: "Verification surface includes typecheck and tests.",
    verificationCommands: ["nub run typecheck"],
    verificationSurfaces: ["tests", "typecheck"],
    gaps: ["No focused workflow verification fixture."],
    evidence: [evidence("audit-1"), evidence("audit-2")],
  };
}

function auditWithFeedbackLoopGaps(): VerificationAudit {
  return {
    projectId: "weavekit",
    summary:
      "Verification surface has tests and typecheck, but lacks common fast feedback-loop checks.",
    verificationCommands: ["nub run typecheck", "nub run test"],
    verificationSurfaces: ["tests", "typecheck"],
    gaps: [
      "No lint or format scripts/configuration were found for ESLint, Prettier, Biome, or Oxlint.",
      "No git commit hooks were found under .husky, lefthook, or lint-staged configuration.",
      "No coverage script or coverage threshold configuration was found.",
    ],
    evidence: [
      evidence("package-json"),
      {
        id: "lint-scan",
        source: "repository lint/format config scan",
        quote:
          "No ESLint, Prettier, Biome, or Oxlint config detected; no package scripts for lint/format.",
      },
      {
        id: "hook-scan",
        source: "repository git hook config scan",
        quote: "No .husky, lefthook, or lint-staged configuration detected.",
      },
      {
        id: "coverage-scan",
        source: "package.json coverage gap",
        quote: "No coverage script or coverage thresholds were found.",
      },
    ],
  };
}

function verificationOpportunityFixture(
  overrides: Partial<VerificationOpportunity> = {},
): VerificationOpportunity {
  return {
    id: "accepted",
    title: "Add focused workflow validation",
    currentVerificationGap: "Workflow template validation has no focused fixture.",
    targetChange: "Add a focused test fixture and verification command.",
    allowedChangeKind: "test",
    score: {
      confidence: 0.9,
      impact: 0.7,
      risk: 0.2,
      implementationCost: 0.3,
    },
    evidence: [evidence("audit-1"), evidence("audit-2")],
    proofCommands: ["nub run test -- verification"],
    speculative: false,
    ...overrides,
  };
}

function deepResearchReportFixture(
  overrides: Partial<DeepResearchReport> = {},
): DeepResearchReport {
  return {
    objective: "Research CI verification",
    methodology: "Read external sources.",
    findings: [
      {
        title: "Use CI to run validation commands.",
        summary: "Use CI to run validation commands.",
        confidence: "high",
        evidenceIds: ["e1"],
      },
    ],
    evidenceMatrix: [
      {
        questionId: "q1",
        evidenceId: "e1",
        relevance: "Supports adding CI.",
        quality: "primary",
      },
    ],
    contradictions: [],
    gaps: [],
    confidence: "medium",
    sources: [
      {
        id: "e1",
        provider: "exa",
        url: "https://example.com/ci",
        title: "CI guidance",
        quality: "primary",
      },
    ],
    markdown: "# Deep Research Report\n\nUse CI.",
    ...overrides,
  };
}

function verificationReviewFixture(
  overrides: Partial<VerificationRecommendationReview> = {},
): VerificationRecommendationReview {
  return {
    status: "accepted",
    selectedOpportunity: verificationOpportunityFixture(),
    rationale: "Accepted as a narrow verification-only improvement.",
    rejectionReason: null,
    proofCommands: ["nub run test -- verification"],
    ...overrides,
  };
}

function evidence(id: string) {
  return {
    id,
    source: `tests/${id}.test.ts`,
    quote: "verification evidence",
  };
}
