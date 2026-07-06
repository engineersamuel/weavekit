import { describe, expect, it } from "vitest";
import { WorkflowHarnessKind, WorkflowNodeKind } from "../../../src/macro-workflow/types.js";
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
  VerificationAudit,
  VerificationOpportunity,
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

    const execution = await registry.get(WorkflowHarnessKind.COPILOT_SDK)?.prepareExecution?.(node, emptyExecutionContext());

    expect(execution?.prompt).toBe(buildVerificationAuditPrompt(options.project));
    expect(execution?.calls?.[0]?.prompt).toBe(execution?.prompt);
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

    const execution = prepareVerificationOptimizerCopilotExecution(node, emptyExecutionContext(), options);

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

    const execution = prepareVerificationOptimizerCopilotExecution(node, emptyExecutionContext(), options);

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

    const implementationExecution = prepareVerificationOptimizerCopilotExecution({
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
    }, context, options);
    const reviewExecution = prepareVerificationOptimizerCopilotExecution({
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
    }, context, options);

    expect(implementationExecution).toMatchObject({
      executor: WorkflowHarnessKind.COPILOT_SDK,
      mode: "implement",
      cwd: "/tmp/verification-wt",
      model: "gpt-impl",
    });
    expect(implementationExecution?.prompt).toContain("Implement the selected verification-only improvement");
    expect(implementationExecution?.prompt).toContain(JSON.stringify(audit));
    expect(implementationExecution?.calls?.[0]?.prompt).toBe(implementationExecution?.prompt);

    expect(reviewExecution).toMatchObject({
      executor: WorkflowHarnessKind.COPILOT_SDK,
      mode: "review",
      cwd: "/tmp/verification-wt",
      model: "gpt-review",
    });
    expect(reviewExecution?.prompt).toContain("Review the implemented verification-only improvement");
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

    const accepted = selectVerificationOpportunity([
      verificationOpportunityFixture({ id: "low-confidence", score: { confidence: 0.84, impact: 0.9, risk: 0.2, implementationCost: 0.2 } }),
      verificationOpportunityFixture({ id: "accepted", title: "Add focused workflow validation", score: { confidence: 0.9, impact: 0.7, risk: 0.2, implementationCost: 0.3 } }),
    ], thresholds);

    expect(accepted.status).toBe("accepted");
    expect(accepted.selectedOpportunity?.id).toBe("accepted");
    expect(accepted.rejections.find((rejection) => rejection.id === "low-confidence")?.reason).toContain("confidence");
  });

  it("rejects speculative or under-evidenced opportunities", () => {
    const selection = selectVerificationOpportunity([
      verificationOpportunityFixture({ id: "speculative", speculative: true }),
      verificationOpportunityFixture({ id: "under-evidenced", evidence: [evidence("one")] }),
      verificationOpportunityFixture({ id: "no-proof", proofCommands: [] }),
    ], defaultThresholds());

    expect(selection.status).toBe("rejected");
    expect(selection.selectedOpportunity).toBeUndefined();
    expect(selection.rejections.map((rejection) => rejection.id)).toEqual(["speculative", "under-evidenced", "no-proof"]);
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
        { id: "lint-scan", source: "repository lint/format config scan", quote: "No ESLint, Prettier, Biome, or Oxlint config detected; no package scripts for lint/format." },
        { id: "hook-scan", source: "repository git hook config scan", quote: "No .husky, lefthook, or lint-staged configuration detected." },
        { id: "coverage-scan", source: "package.json coverage gap", quote: "No coverage script or coverage thresholds were found." },
      ],
    });

    expect(opportunities.map((opportunity) => opportunity.id)).toEqual([
      "baseline-lint-format",
      "baseline-git-hooks",
      "baseline-coverage-threshold",
    ]);
    expect(opportunities.find((opportunity) => opportunity.id === "baseline-coverage-threshold")?.targetChange).toContain("100% threshold");
    expect(opportunities.every((opportunity) => !opportunity.speculative)).toBe(true);
    expect(opportunities.every((opportunity) => opportunity.evidence.length >= 2)).toBe(true);
    expect(opportunities.flatMap((opportunity) => opportunity.proofCommands)).toEqual(expect.arrayContaining([
      "nub run lint",
      "nub run format:check",
      "nub run prepare",
      "nub run coverage",
    ]));
    expect(selectVerificationOpportunity(opportunities, defaultThresholds()).status).toBe("accepted");
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

    const state = await runMacroWorkflow(materializeWorkflowPlan("verification-optimizer", {
      objective: "Optimize verification",
      project: "weavekit",
      mode: "advisory",
    }), {
      harnesses: createVerificationOptimizerHarnessRegistry(options),
      expandAfterNode: createVerificationOptimizerDynamicExpander(options),
    });

    const mapping = state.nodeResults.find((result) => result.nodeId === "verification-opportunity-mapping")?.payload?.verificationOpportunityReview as {
      opportunities?: VerificationOpportunity[];
    } | undefined;
    const review = state.nodeResults.find((result) => result.nodeId === "verification-review")?.payload?.verificationReview as {
      selectedOpportunity?: VerificationOpportunity;
      status?: string;
    } | undefined;
    const report = state.nodeResults.find((result) => result.nodeId === "report-verification-opportunity");

    expect(mapping?.opportunities?.map((opportunity) => opportunity.id)).toEqual([
      "baseline-lint-format",
      "baseline-git-hooks",
      "baseline-coverage-threshold",
    ]);
    expect(review).toMatchObject({
      status: "accepted",
      selectedOpportunity: { id: "baseline-lint-format" },
    });
    expect(state.nodeResults.map((result) => result.nodeId)).toContain("report-verification-opportunity");
    expect(state.nodeResults.map((result) => result.nodeId)).not.toContain("report-no-verification-opportunity");
    expect(report?.output).toContain("baseline-git-hooks");
    expect(report?.output).toContain("baseline-coverage-threshold");
  });

  it("expands a rejected review into a no-op report", async () => {
    const options = verificationOptimizerOptions({
      baml: {
        async MapVerificationOpportunities() {
          return {
            opportunities: [verificationOpportunityFixture({ id: "weak", score: { confidence: 0.5, impact: 0.4, risk: 0.2, implementationCost: 0.2 } })],
            nonApplicableGaps: [],
            rankingRationale: "No high-confidence verification-only improvement exists.",
          };
        },
      },
    });
    const state = await runMacroWorkflow(materializeWorkflowPlan("verification-optimizer", {
      objective: "Optimize verification",
      project: "weavekit",
      mode: "advisory",
    }), {
      harnesses: createVerificationOptimizerHarnessRegistry(options),
      expandAfterNode: createVerificationOptimizerDynamicExpander(options),
    });

    expect(state.status).toBe("passed");
    expect(state.nodeResults.map((result) => result.nodeId)).toContain("report-no-verification-opportunity");
    expect(state.nodeResults.some((result) => result.nodeId === "implement-verification-improvement")).toBe(false);
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
          return { worktreePath: "/tmp/verification-wt", branchName: "verification-optimizer/accepted", baselineCommit: "abc123", copiedEnvFiles: [".env"] };
        },
      },
      shell: {
        async run(command, args) {
          calls.push([command, ...args].join(" "));
          return command === "gh" ? "https://example.com/pr/verification\n" : "ok\n";
        },
      },
    });

    const state = await runMacroWorkflow(materializeWorkflowPlan("verification-optimizer", {
      objective: "Optimize verification",
      project: "weavekit",
      mode: "autonomous-pr",
    }), {
      harnesses: createVerificationOptimizerHarnessRegistry(options),
      expandAfterNode: createVerificationOptimizerDynamicExpander(options),
    });

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
          return { worktreePath: "/tmp/verification-wt", branchName: "verification-optimizer/accepted", baselineCommit: "abc123", copiedEnvFiles: [".env"] };
        },
      },
      shell: {
        async run(command, args) {
          commands.push(command === "gh" ? command : args[1] ?? command);
          return "ok\n";
        },
      },
      baml: {
        async MapVerificationOpportunities() {
          return {
            opportunities: [verificationOpportunityFixture({ proofCommands: ["nub run test -- verification"] })],
            nonApplicableGaps: [],
            rankingRationale: "Proof command is explicit.",
          };
        },
      },
    });

    const state = await runMacroWorkflow(materializeWorkflowPlan("verification-optimizer", {
      objective: "Optimize verification",
      project: "weavekit",
      mode: "autonomous-pr",
    }), {
      harnesses: createVerificationOptimizerHarnessRegistry(options),
      expandAfterNode: createVerificationOptimizerDynamicExpander(options),
    });

    expect(state.status).toBe("passed");
    expect(commands).toEqual([
      "nub run typecheck",
      "nub run test -- verification",
      "gh",
    ]);
    expect(state.nodeResults.find((result) => result.nodeId === "run-verification-commands")?.payload).toMatchObject({
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

function verificationOptimizerOptions(overrides: Partial<Parameters<typeof createVerificationOptimizerHarnessRegistry>[0]> = {}) {
  return {
    project: projectFixture(),
    mode: "advisory" as const,
    ...overrides,
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
    summary: "Verification surface has tests and typecheck, but lacks common fast feedback-loop checks.",
    verificationCommands: ["nub run typecheck", "nub run test"],
    verificationSurfaces: ["tests", "typecheck"],
    gaps: [
      "No lint or format scripts/configuration were found for ESLint, Prettier, Biome, or Oxlint.",
      "No git commit hooks were found under .husky, lefthook, or lint-staged configuration.",
      "No coverage script or coverage threshold configuration was found.",
    ],
    evidence: [
      evidence("package-json"),
      { id: "lint-scan", source: "repository lint/format config scan", quote: "No ESLint, Prettier, Biome, or Oxlint config detected; no package scripts for lint/format." },
      { id: "hook-scan", source: "repository git hook config scan", quote: "No .husky, lefthook, or lint-staged configuration detected." },
      { id: "coverage-scan", source: "package.json coverage gap", quote: "No coverage script or coverage thresholds were found." },
    ],
  };
}

function verificationOpportunityFixture(overrides: Partial<VerificationOpportunity> = {}): VerificationOpportunity {
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

function verificationReviewFixture(overrides: Partial<VerificationRecommendationReview> = {}): VerificationRecommendationReview {
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
