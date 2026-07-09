import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { b } from "../../generated/baml_client/index.js";
import type {
  DeepResearchReport,
  EvidenceReference,
  VerificationAudit,
  VerificationOpportunity,
  VerificationOpportunityReview,
  VerificationOpportunityResearchReport,
  VerificationRecommendationReview,
} from "../../generated/baml_client/index.js";
import type {
  ProjectCatalogEntry,
  VerificationOptimizerDefaults,
  VerificationOptimizerMode,
  VerificationOptimizerThresholds,
} from "../../config.js";
import type {
  HarnessAdapter,
  HarnessExecutionResult,
  HarnessRegistry,
  WorkflowExecutionContext,
} from "../harness.js";
import { createStaticHarnessRegistry, resolveHarnessAdapter } from "../harness.js";
import type { WorkflowDynamicExpander } from "../runner.js";
import type {
  RuntimeWorkflowNode,
  WorkflowExecutionCall,
  WorkflowExecutionMetadata,
} from "../types.js";
import { WorkflowGateKind, WorkflowHarnessKind, WorkflowNodeKind } from "../types.js";
import {
  prepareAutonomousWorktree,
  type WorktreePreparationResult,
} from "../sourceToProject/worktree.js";
import {
  buildDeepResearchSeedQuestionNode,
  createDeepResearchDynamicExpander,
  createDeepResearchHarnessRegistry,
  normalizeDeepResearchConfig,
  type DeepResearchHarnessOptions,
} from "../deepResearch/harnesses.js";
import {
  buildVerificationAuditPrompt,
  buildVerificationImplementationPrompt,
  buildVerificationImplementationReviewPrompt,
} from "./prompts.js";

const execFileAsync = promisify(execFile);

const DEFAULT_THRESHOLDS: VerificationOptimizerThresholds = {
  minConfidence: 0.85,
  minImpact: 0.6,
  maxRisk: 0.35,
  maxImplementationCost: 0.45,
  minEvidenceReferences: 2,
  requireNonSpeculative: true,
  requireProofCommands: true,
};
const MAX_EXTERNAL_RESEARCH_OPPORTUNITIES = 3;
const REFINEMENT_REPORT_MARKDOWN_LIMIT = 6_000;
const REFINEMENT_REPORT_TEXT_LIMIT = 1_500;
const REFINEMENT_REPORT_LIST_LIMIT = 8;
const REFINEMENT_REPORT_SOURCE_LIMIT = 12;

export type VerificationExternalResearchCandidate = {
  opportunityId: string;
  runId: string;
  reportNodeId: string;
  objective: string;
};

export type VerificationOptimizerBamlClient = {
  DistillVerificationAudit(projectJson: string, rawAudit: string): Promise<VerificationAudit>;
  MapVerificationOpportunities(audit: VerificationAudit): Promise<VerificationOpportunityReview>;
  RefineVerificationOpportunitiesWithResearch(
    audit: VerificationAudit,
    initialReview: VerificationOpportunityReview,
    researchReports: VerificationOpportunityResearchReport[],
  ): Promise<VerificationOpportunityReview>;
  ReviewVerificationRecommendation(
    audit: VerificationAudit,
    selectedOpportunity: VerificationOpportunity | undefined,
  ): Promise<VerificationRecommendationReview>;
};

export type VerificationOptimizerCopilotClient = {
  run(args: {
    cwd?: string;
    prompt: string;
    mode: "research" | "implement" | "review";
    model?: string;
    operation?: string;
    nodeId?: string;
    label?: string;
  }): Promise<string>;
};

export type VerificationOptimizerShellClient = {
  run(command: string, args: string[], options: { cwd: string }): Promise<string>;
};

export type VerificationOpportunitySelection = {
  status: "accepted" | "rejected";
  reason: string;
  selectedOpportunity?: VerificationOpportunity;
  rejections: Array<{ id: string; reason: string }>;
};

export type VerificationOptimizerHarnessOptions = {
  project: ProjectCatalogEntry;
  mode: VerificationOptimizerMode;
  verificationOptimizer?: VerificationOptimizerDefaults;
  thresholds?: Partial<VerificationOptimizerThresholds>;
  copilot?: VerificationOptimizerCopilotClient;
  baml?: Partial<VerificationOptimizerBamlClient>;
  worktree?: {
    prepare(): Promise<WorktreePreparationResult>;
  };
  shell?: VerificationOptimizerShellClient;
  deepResearch?: DeepResearchHarnessOptions;
};

export function createOfflineVerificationOptimizerHarnessClient(): VerificationOptimizerCopilotClient {
  return {
    async run(args) {
      return [`Mode: ${args.mode}`, args.cwd ? `Cwd: ${args.cwd}` : undefined, args.prompt]
        .filter(Boolean)
        .join("\n\n");
    },
  };
}

export function createLiveVerificationOptimizerBamlClient(): VerificationOptimizerBamlClient {
  return {
    DistillVerificationAudit: (projectJson, rawAudit) =>
      b.DistillVerificationAudit(projectJson, rawAudit),
    MapVerificationOpportunities: (audit) => b.MapVerificationOpportunities(audit),
    RefineVerificationOpportunitiesWithResearch: (audit, initialReview, researchReports) =>
      b.RefineVerificationOpportunitiesWithResearch(audit, initialReview, researchReports),
    ReviewVerificationRecommendation: (audit, selectedOpportunity) =>
      b.ReviewVerificationRecommendation(audit, selectedOpportunity ?? null),
  };
}

export function prepareVerificationOptimizerCopilotExecution(
  node: RuntimeWorkflowNode,
  context: WorkflowExecutionContext,
  options: VerificationOptimizerHarnessOptions,
): WorkflowExecutionMetadata | undefined {
  if (node.id === "project-verification-audit") {
    const prompt = buildVerificationAuditPrompt(options.project);
    return buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
      copilotCall({
        mode: "research",
        cwd: options.project.workingTree,
        prompt,
        model: node.model,
      }),
    ]);
  }

  if (node.id === "implement-verification-improvement") {
    const worktreePath = readOptionalWorktreePath(context);
    const audit = getOptionalPayloadValue<VerificationAudit>(
      context,
      "project-verification-audit",
      "verificationAudit",
    );
    const review = getOptionalPayloadValue<VerificationRecommendationReview>(
      context,
      "verification-review",
      "verificationReview",
    );
    const opportunity = review?.selectedOpportunity ?? undefined;
    if (!worktreePath || !audit || !review || !opportunity) {
      return undefined;
    }
    const prompt = buildVerificationImplementationPrompt({
      project: options.project,
      audit,
      opportunity,
      review,
    });
    return buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
      copilotCall({ mode: "implement", cwd: worktreePath, prompt, model: node.model }),
    ]);
  }

  if (node.id === "review-verification-implementation") {
    const worktreePath = readOptionalWorktreePath(context);
    const review = getOptionalPayloadValue<VerificationRecommendationReview>(
      context,
      "verification-review",
      "verificationReview",
    );
    const opportunity = review?.selectedOpportunity ?? undefined;
    if (!worktreePath || !review || !opportunity) {
      return undefined;
    }
    const proofCommands = readProofCommands(review, opportunity);
    const prompt = buildVerificationImplementationReviewPrompt({ opportunity, proofCommands });
    return buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
      copilotCall({ mode: "review", cwd: worktreePath, prompt, model: node.model }),
    ]);
  }

  return undefined;
}

function prepareVerificationOptimizerResearchExecution(
  node: RuntimeWorkflowNode,
  context: WorkflowExecutionContext,
): WorkflowExecutionMetadata | undefined {
  if (node.id === "verification-opportunity-mapping") {
    const audit = context.payloads.get("project-verification-audit")?.verificationAudit;
    if (!audit) {
      return undefined;
    }
    return buildExecutionMetadata(WorkflowHarnessKind.RESEARCH, [
      bamlCall(
        "MapVerificationOpportunities",
        buildMapVerificationOpportunitiesPromptPreview(audit),
      ),
    ]);
  }
  if (isVerificationOpportunityRefinementNode(node)) {
    const audit = context.payloads.get("project-verification-audit")?.verificationAudit;
    const initialReview = context.payloads.get(
      "verification-opportunity-mapping",
    )?.verificationOpportunityReview;
    const candidates = readExternalResearchCandidates(
      context.payloads.get("verification-opportunity-mapping"),
    );
    const reports = compactVerificationOpportunityResearchReports(
      candidates.flatMap((candidate) => {
        const report = context.payloads.get(candidate.reportNodeId)?.deepResearchReport;
        return isDeepResearchReport(report)
          ? [{ opportunityId: candidate.opportunityId, objective: candidate.objective, report }]
          : [];
      }),
    );
    if (!audit || !initialReview) {
      return undefined;
    }
    return buildExecutionMetadata(WorkflowHarnessKind.RESEARCH, [
      bamlCall(
        "RefineVerificationOpportunitiesWithResearch",
        buildRefineVerificationOpportunitiesPromptPreview(audit, initialReview, reports),
      ),
    ]);
  }
  return undefined;
}

export function createVerificationOptimizerHarnessRegistry(
  options: VerificationOptimizerHarnessOptions,
): HarnessRegistry {
  const registry = createStaticHarnessRegistry();
  const copilot = options.copilot ?? createOfflineVerificationOptimizerHarnessClient();
  const bamlClient = resolveBamlClient(options);
  const deepResearchHarnesses = createDeepResearchHarnessRegistry(options.deepResearch);

  const copilotAdapter: HarnessAdapter = Object.assign(
    async (
      node: RuntimeWorkflowNode,
      context: WorkflowExecutionContext,
    ): Promise<HarnessExecutionResult> => {
      if (isDeepResearchNode(node)) {
        return resolveHarnessAdapter(deepResearchHarnesses, WorkflowHarnessKind.COPILOT_SDK)(
          node,
          context,
        );
      }

      if (node.id === "project-verification-audit") {
        const prompt = buildVerificationAuditPrompt(options.project);
        const rawAudit = await copilot.run({
          cwd: options.project.workingTree,
          prompt,
          mode: "research",
          model: node.model,
          operation: node.id,
          nodeId: node.id,
          label: "Copilot verification audit",
        });
        const audit = augmentVerificationAuditWithLocalBestPracticeScan(
          await bamlClient.DistillVerificationAudit(JSON.stringify(options.project), rawAudit),
          options.project.workingTree,
        );
        return {
          status: "passed",
          output: `Verification audit complete for ${audit.projectId}.`,
          payload: { verificationAudit: audit },
          execution: buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
            copilotCall({
              mode: "research",
              cwd: options.project.workingTree,
              prompt,
              model: node.model,
            }),
            bamlCall("DistillVerificationAudit"),
          ]),
        };
      }

      if (node.id === "implement-verification-improvement") {
        const worktreePath = readWorktreePath(context);
        const audit = getPayloadValue<VerificationAudit>(
          context,
          "project-verification-audit",
          "verificationAudit",
        );
        const review = getPayloadValue<VerificationRecommendationReview>(
          context,
          "verification-review",
          "verificationReview",
        );
        const opportunity = readSelectedOpportunity(review);
        const prompt = buildVerificationImplementationPrompt({
          project: options.project,
          audit,
          opportunity,
          review,
        });
        const raw = await copilot.run({
          cwd: worktreePath,
          prompt,
          mode: "implement",
          model: node.model,
          operation: node.id,
          nodeId: node.id,
          label: "Copilot verification implementation",
        });
        return {
          status: "passed",
          output: "Verification improvement implementation complete.",
          payload: { implementationSummary: raw },
          execution: buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
            copilotCall({ mode: "implement", cwd: worktreePath, prompt, model: node.model }),
          ]),
        };
      }

      if (node.id === "review-verification-implementation") {
        const worktreePath = readWorktreePath(context);
        const review = getPayloadValue<VerificationRecommendationReview>(
          context,
          "verification-review",
          "verificationReview",
        );
        const opportunity = readSelectedOpportunity(review);
        const proofCommands = readProofCommands(review, opportunity);
        const prompt = buildVerificationImplementationReviewPrompt({ opportunity, proofCommands });
        const raw = await copilot.run({
          cwd: worktreePath,
          prompt,
          mode: "review",
          model: node.model,
          operation: node.id,
          nodeId: node.id,
          label: "Copilot verification implementation review",
        });
        return {
          status: "passed",
          output: "Verification implementation review complete.",
          payload: { implementationReview: raw },
          execution: buildExecutionMetadata(WorkflowHarnessKind.COPILOT_SDK, [
            copilotCall({ mode: "review", cwd: worktreePath, prompt, model: node.model }),
          ]),
        };
      }

      return {
        status: "passed",
        output: `Copilot SDK harness skipped unsupported node ${node.id}.`,
      };
    },
    {
      prepareExecution(node: RuntimeWorkflowNode, context: WorkflowExecutionContext) {
        return prepareVerificationOptimizerCopilotExecution(node, context, options);
      },
    },
  );

  const researchAdapter: HarnessAdapter = Object.assign(
    async (
      node: RuntimeWorkflowNode,
      context: WorkflowExecutionContext,
    ): Promise<HarnessExecutionResult> => {
      if (isDeepResearchNode(node)) {
        return resolveHarnessAdapter(deepResearchHarnesses, WorkflowHarnessKind.RESEARCH)(
          node,
          context,
        );
      }

      if (isVerificationOpportunityRefinementNode(node)) {
        const audit = getPayloadValue<VerificationAudit>(
          context,
          "project-verification-audit",
          "verificationAudit",
        );
        const initialReview = getPayloadValue<VerificationOpportunityReview>(
          context,
          "verification-opportunity-mapping",
          "verificationOpportunityReview",
        );
        const candidates = getPayloadValue<VerificationExternalResearchCandidate[]>(
          context,
          "verification-opportunity-mapping",
          "verificationExternalResearchCandidates",
        );
        const researchReports = compactVerificationOpportunityResearchReports(
          candidates.map((candidate) => ({
            opportunityId: candidate.opportunityId,
            objective: candidate.objective,
            report: getPayloadValue<DeepResearchReport>(
              context,
              candidate.reportNodeId,
              "deepResearchReport",
            ),
          })),
        );
        const refined = await bamlClient.RefineVerificationOpportunitiesWithResearch(
          audit,
          initialReview,
          researchReports,
        );
        const opportunityReview = applyExternalResearchRefinement(initialReview, refined);
        return {
          status: "passed",
          output: `Refined ${opportunityReview.opportunities.length} verification opportunities with ${researchReports.length} external research report(s).`,
          payload: {
            verificationOpportunityReview: opportunityReview,
            verificationExternalResearchReports: researchReports,
          },
          execution: buildExecutionMetadata(WorkflowHarnessKind.RESEARCH, [
            bamlCall("RefineVerificationOpportunitiesWithResearch"),
          ]),
        };
      }

      if (node.id !== "verification-opportunity-mapping") {
        return {
          status: "failed",
          output: `Research harness does not support node ${node.id}.`,
          error: `Research harness does not support node ${node.id}.`,
        };
      }
      const audit = getPayloadValue<VerificationAudit>(
        context,
        "project-verification-audit",
        "verificationAudit",
      );
      const opportunityReview = mergeBestPracticeOpportunities(
        await bamlClient.MapVerificationOpportunities(audit),
        audit,
      );
      const researchCandidates = options.verificationOptimizer?.externalResearch
        ? buildExternalResearchCandidates(audit, opportunityReview.opportunities)
        : [];
      return {
        status: "passed",
        output: `Mapped ${opportunityReview.opportunities.length} verification opportunities.`,
        payload: {
          verificationOpportunityReview: opportunityReview,
          verificationExternalResearchCandidates: researchCandidates,
        },
        execution: buildExecutionMetadata(WorkflowHarnessKind.RESEARCH, [
          bamlCall("MapVerificationOpportunities"),
        ]),
      };
    },
    {
      prepareExecution(node: RuntimeWorkflowNode, context: WorkflowExecutionContext) {
        if (isDeepResearchNode(node)) {
          return resolveHarnessAdapter(
            deepResearchHarnesses,
            WorkflowHarnessKind.RESEARCH,
          ).prepareExecution?.(node, context);
        }
        return prepareVerificationOptimizerResearchExecution(node, context);
      },
    },
  );

  const councilAdapter: HarnessAdapter = async (node, context) => {
    if (node.id !== "verification-review") {
      return { status: "passed", output: `Council harness skipped unsupported node ${node.id}.` };
    }
    const audit = getPayloadValue<VerificationAudit>(
      context,
      "project-verification-audit",
      "verificationAudit",
    );
    const opportunityReview = readCurrentOpportunityReview(context);
    const selection = selectVerificationOpportunity(
      opportunityReview.opportunities,
      resolveThresholds(options),
    );
    const verificationReview = selection.selectedOpportunity
      ? normalizeAcceptedReview(
          await bamlClient.ReviewVerificationRecommendation(audit, selection.selectedOpportunity),
          selection.selectedOpportunity,
        )
      : buildRejectedReview(selection.reason);
    const strictReview =
      verificationReview.status === "accepted"
        ? verificationReview
        : { ...verificationReview, selectedOpportunity: undefined, proofCommands: [] };
    return {
      status: "passed",
      output:
        strictReview.status === "accepted"
          ? `Verification review accepted ${strictReview.selectedOpportunity?.id}.`
          : `Verification review rejected all opportunities: ${strictReview.rejectionReason ?? strictReview.rationale}`,
      payload: { verificationReview: strictReview, verificationOpportunitySelection: selection },
      execution: buildExecutionMetadata(WorkflowHarnessKind.DECISION_COUNCIL, [
        {
          executor: "decision-council",
          operation: "StrictVerificationReview",
          prompt: node.prompt,
        },
        ...(selection.selectedOpportunity ? [bamlCall("ReviewVerificationRecommendation")] : []),
      ]),
    };
  };

  const verifierAdapter: HarnessAdapter = async (node, context) => {
    if (node.id === "prepare-worktree") {
      const worktreePreparation = await (options.worktree?.prepare() ??
        prepareAutonomousWorktree({
          sourceWorkingTree: options.project.workingTree,
          worktreeRoot: join(options.project.workingTree, ".."),
          branchName: `verification-optimizer/${Date.now()}`,
          mainline: options.project.mainline,
        }));
      return {
        status: "passed",
        output: `Prepared worktree ${worktreePreparation.worktreePath} at ${worktreePreparation.baselineCommit}.`,
        payload: { worktreePreparation },
      };
    }

    if (node.id === "run-verification-commands") {
      const worktreePath = readWorktreePath(context);
      const review = getPayloadValue<VerificationRecommendationReview>(
        context,
        "verification-review",
        "verificationReview",
      );
      const opportunity = readSelectedOpportunity(review);
      const verificationCommands = uniqueCommands([
        ...options.project.validationCommands,
        ...readProofCommands(review, opportunity),
      ]);
      const verificationSummary = await runValidationCommands(
        verificationCommands,
        worktreePath,
        options.shell,
      );
      return {
        status: "passed",
        output: "Verification commands complete.",
        payload: { verificationSummary, verificationCommands },
        execution: buildExecutionMetadata(
          WorkflowHarnessKind.VERIFIER,
          verificationCommands.map((command) => ({
            executor: "shell",
            operation: command,
            cwd: worktreePath,
          })),
        ),
      };
    }

    return { status: "passed", output: "Verification complete." };
  };

  const reporterAdapter: HarnessAdapter = async (
    node,
    context,
  ): Promise<HarnessExecutionResult> => {
    if (isDeepResearchNode(node)) {
      return resolveHarnessAdapter(deepResearchHarnesses, WorkflowHarnessKind.REPORTER)(
        node,
        context,
      );
    }

    if (node.id === "open-pr") {
      const worktreePath = readWorktreePath(context);
      const prUrl = await openPullRequest(worktreePath, options.shell);
      return {
        status: "passed",
        output: "Pull request prepared.",
        payload: { prUrl },
        execution: reporterExecution(node),
      };
    }

    if (node.id === "report-no-verification-opportunity") {
      const selection = getPayloadValue<VerificationOpportunitySelection>(
        context,
        "verification-review",
        "verificationOpportunitySelection",
      );
      return {
        status: "passed",
        output: `No verification opportunity selected: ${selection.reason}`,
        payload: { verificationOptimizerReport: { status: "rejected", selection } },
        execution: reporterExecution(node),
      };
    }

    if (node.id === "report-verification-opportunity") {
      const review = getPayloadValue<VerificationRecommendationReview>(
        context,
        "verification-review",
        "verificationReview",
      );
      const opportunityReview = readCurrentOpportunityReview(context);
      const selectedId = review.selectedOpportunity?.id;
      const otherOpportunities = opportunityReview.opportunities.filter(
        (opportunity) => opportunity.id !== selectedId,
      );
      return {
        status: "passed",
        output: [
          `Verification opportunity selected: ${review.selectedOpportunity?.title ?? "unknown"}`,
          selectedId ? `Selected candidate: ${selectedId}` : undefined,
          otherOpportunities.length > 0
            ? `Other discovered feedback-loop opportunities: ${otherOpportunities.map((opportunity) => `${opportunity.id} (${opportunity.title})`).join(", ")}`
            : undefined,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        payload: {
          verificationOptimizerReport: {
            status: "accepted",
            review,
            opportunities: opportunityReview.opportunities,
          },
        },
        execution: reporterExecution(node),
      };
    }

    return { status: "passed", output: `Reporter skipped unsupported node ${node.id}.` };
  };

  registry.set(WorkflowHarnessKind.COPILOT_SDK, copilotAdapter);
  registry.set(WorkflowHarnessKind.RESEARCH, researchAdapter);
  registry.set(WorkflowHarnessKind.DECISION_COUNCIL, councilAdapter);
  registry.set(WorkflowHarnessKind.VERIFIER, verifierAdapter);
  registry.set(WorkflowHarnessKind.REPORTER, reporterAdapter);
  return registry;
}

export function createVerificationOptimizerDynamicExpander(
  options: VerificationOptimizerHarnessOptions,
): WorkflowDynamicExpander {
  const deepResearchExpander = createDeepResearchDynamicExpander();
  return async (args) => {
    const { node, result, payloads, completedNodeIds } = args;
    if (result.status !== "passed") {
      return undefined;
    }

    if (
      node.id === "verification-opportunity-mapping" &&
      options.verificationOptimizer?.externalResearch
    ) {
      const candidates = readExternalResearchCandidates(result.payload);
      if (candidates.length === 0) {
        return [buildVerificationReviewNode("verification-opportunity-mapping")];
      }
      const config = normalizeDeepResearchConfig(options.deepResearch?.config);
      return candidates.map((candidate) =>
        buildDeepResearchSeedQuestionNode({
          deepResearchRunId: candidate.runId,
          objective: candidate.objective,
          config,
          dependsOn: ["verification-opportunity-mapping"],
        }),
      );
    }

    if (isDeepResearchNode(node)) {
      const deepResearchExpansion = await deepResearchExpander(args);
      if (
        deepResearchExpansion &&
        !(Array.isArray(deepResearchExpansion) && deepResearchExpansion.length === 0)
      ) {
        return deepResearchExpansion;
      }
      const candidates = readExternalResearchCandidates(
        payloads.get("verification-opportunity-mapping"),
      );
      if (!candidates.some((candidate) => candidate.reportNodeId === node.id)) {
        return undefined;
      }
      const completedWithCurrent = new Set([...completedNodeIds, node.id]);
      if (candidates.every((candidate) => completedWithCurrent.has(candidate.reportNodeId))) {
        return [
          buildOpportunityRefinementNode(candidates.map((candidate) => candidate.reportNodeId)),
        ];
      }
      return undefined;
    }

    if (isVerificationOpportunityRefinementNode(node)) {
      return [buildVerificationReviewNode(node.id)];
    }

    if (node.id !== "verification-review") {
      return undefined;
    }

    const review = result.payload?.verificationReview as
      | VerificationRecommendationReview
      | undefined;
    if (!review || review.status !== "accepted" || !review.selectedOpportunity) {
      return [buildNoOpportunityReportNode()];
    }
    return options.mode === "autonomous-pr"
      ? buildAutonomousPrNodes(review.selectedOpportunity)
      : [buildAcceptedAdvisoryReportNode()];
  };
}

export function selectVerificationOpportunity(
  opportunities: VerificationOpportunity[],
  thresholds: VerificationOptimizerThresholds = DEFAULT_THRESHOLDS,
): VerificationOpportunitySelection {
  const rejections: VerificationOpportunitySelection["rejections"] = [];
  const accepted = opportunities
    .filter((opportunity) => {
      const reason = rejectionReason(opportunity, thresholds);
      if (reason) {
        rejections.push({ id: opportunity.id, reason });
        return false;
      }
      return true;
    })
    .sort(compareVerificationOpportunities);

  const selectedOpportunity = accepted[0];
  if (!selectedOpportunity) {
    return {
      status: "rejected",
      reason:
        rejections.length > 0
          ? `No opportunities passed strict gates: ${rejections.map((rejection) => `${rejection.id}: ${rejection.reason}`).join("; ")}`
          : "No verification opportunities were proposed.",
      rejections,
    };
  }

  return {
    status: "accepted",
    reason: `Accepted ${selectedOpportunity.id} as the highest-ranked strict verification-only opportunity.`,
    selectedOpportunity,
    rejections,
  };
}

export function deriveBestPracticeVerificationOpportunities(
  audit: VerificationAudit,
): VerificationOpportunity[] {
  const text = auditText(audit);
  const opportunities: VerificationOpportunity[] = [];

  if (mentionsMissingLintOrFormat(text)) {
    opportunities.push({
      id: "baseline-lint-format",
      title: "Add check-only lint and format verification",
      currentVerificationGap:
        "The project lacks a lint/format verification surface, so agents do not get fast static feedback before typecheck and tests.",
      targetChange: [
        "Add Oxc-based lint and formatter configuration plus check-only package scripts such as `lint` and `format:check`.",
        "Keep this verification-only: do not perform a broad repository reformat in the same change.",
      ].join(" "),
      allowedChangeKind: "lint",
      score: { confidence: 0.92, impact: 0.75, risk: 0.25, implementationCost: 0.35 },
      evidence: bestPracticeEvidence(
        audit,
        ["lint", "format", "oxlint", "oxc", "prettier", "biome", "eslint"],
        "No lint or formatter verification surface was found.",
      ),
      proofCommands: ["nub run lint", "nub run format:check"],
      speculative: false,
    });
  }

  if (mentionsMissingGitHooks(text)) {
    opportunities.push({
      id: "baseline-git-hooks",
      title: "Add git commit hooks for local verification",
      currentVerificationGap:
        "The project lacks commit-time hooks, so agents and humans can create commits without the fastest local verification checks running first.",
      targetChange:
        "Add a git hook setup such as Husky or lefthook that runs lightweight validation before commits, wired through a package script such as `prepare`.",
      allowedChangeKind: "script",
      score: { confidence: 0.9, impact: 0.68, risk: 0.3, implementationCost: 0.35 },
      evidence: bestPracticeEvidence(
        audit,
        ["hook", "husky", "lefthook", "lint-staged", "commit"],
        "No git commit hook verification surface was found.",
      ),
      proofCommands: ["nub run prepare", "nub run lint", "nub run typecheck"],
      speculative: false,
    });
  }

  if (mentionsMissingCoverage(text)) {
    opportunities.push({
      id: "baseline-coverage-threshold",
      title: "Add 100% coverage threshold verification",
      currentVerificationGap:
        "The project lacks a coverage command or threshold, so test presence is not tied to measurable coverage feedback.",
      targetChange:
        "Add a coverage script and 100% threshold configuration for the existing Vitest test surface so coverage regressions are visible to agents and CI.",
      allowedChangeKind: "script",
      score: { confidence: 0.88, impact: 0.65, risk: 0.2, implementationCost: 0.25 },
      evidence: bestPracticeEvidence(
        audit,
        ["coverage", "vitest", "test"],
        "No coverage verification surface was found.",
      ),
      proofCommands: ["nub run coverage"],
      speculative: false,
    });
  }

  return opportunities;
}

function mergeBestPracticeOpportunities(
  review: VerificationOpportunityReview,
  audit: VerificationAudit,
): VerificationOpportunityReview {
  const byId = new Map(review.opportunities.map((opportunity) => [opportunity.id, opportunity]));
  for (const opportunity of deriveBestPracticeVerificationOpportunities(audit)) {
    byId.set(
      opportunity.id,
      normalizeBestPracticeOpportunity(byId.get(opportunity.id), opportunity),
    );
  }
  return {
    ...review,
    opportunities: [...byId.values()],
    rankingRationale: [
      review.rankingRationale,
      "Baseline feedback-loop opportunities are added deterministically when repository evidence shows missing lint/format, commit hooks, or coverage verification.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function buildExternalResearchCandidates(
  audit: VerificationAudit,
  opportunities: VerificationOpportunity[],
): VerificationExternalResearchCandidate[] {
  return topExternalResearchCandidates(opportunities).map((opportunity) => {
    const runId = `verification-research-${normalizeNodeId(opportunity.id)}`;
    return {
      opportunityId: opportunity.id,
      runId,
      reportNodeId: `${runId}-report`,
      objective: buildVerificationOpportunityResearchObjective(audit, opportunity),
    };
  });
}

function topExternalResearchCandidates(
  opportunities: VerificationOpportunity[],
): VerificationOpportunity[] {
  return opportunities
    .filter((opportunity) => opportunity.evidence.length > 0)
    .slice()
    .sort(compareVerificationOpportunities)
    .slice(0, MAX_EXTERNAL_RESEARCH_OPPORTUNITIES);
}

function normalizeNodeId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/(^-|-$)/gu, "");
  return normalized || "candidate";
}

function buildVerificationOpportunityResearchObjective(
  audit: VerificationAudit,
  opportunity: VerificationOpportunity,
): string {
  return [
    "Research the best external verification approach for one repository-evidenced candidate.",
    `Project ID: ${audit.projectId}`,
    `Opportunity ID: ${opportunity.id}`,
    `Title: ${opportunity.title}`,
    `Local gap: ${opportunity.currentVerificationGap}`,
    `Current target change: ${opportunity.targetChange}`,
    `Allowed change kind: ${opportunity.allowedChangeKind}`,
    `Proof commands under consideration: ${opportunity.proofCommands.join("; ") || "none"}`,
    "",
    "Use external sources only to improve the tool, library, framework, risk, cost, and proof-command approach.",
    "Do not use external sources to prove the local gap exists; that must remain based on repository evidence.",
  ].join("\n");
}

function applyExternalResearchRefinement(
  initialReview: VerificationOpportunityReview,
  refinedReview: VerificationOpportunityReview,
): VerificationOpportunityReview {
  const initialById = new Map(
    initialReview.opportunities.map((opportunity) => [opportunity.id, opportunity]),
  );
  const seen = new Set<string>();
  const refinedOpportunities = refinedReview.opportunities.flatMap((refined) => {
    const initial = initialById.get(refined.id);
    if (!initial) {
      return [];
    }
    seen.add(refined.id);
    return [
      {
        ...initial,
        ...refined,
        score: refined.score,
        evidence: initial.evidence,
      },
    ];
  });
  const remaining = initialReview.opportunities.filter((opportunity) => !seen.has(opportunity.id));
  return {
    ...refinedReview,
    opportunities: [...refinedOpportunities, ...remaining],
    nonApplicableGaps: uniqueStrings([
      ...initialReview.nonApplicableGaps,
      ...refinedReview.nonApplicableGaps,
    ]),
    rankingRationale: [
      refinedReview.rankingRationale,
      "External research refined candidate approach and ranking only; repository evidence from the initial local audit was preserved for gap proof.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function compactVerificationOpportunityResearchReports(
  reports: VerificationOpportunityResearchReport[],
): VerificationOpportunityResearchReport[] {
  return reports.map((entry) => ({
    ...entry,
    objective: clipWhitespace(entry.objective, REFINEMENT_REPORT_TEXT_LIMIT),
    report: compactDeepResearchReport(entry.report),
  }));
}

function compactDeepResearchReport(report: DeepResearchReport): DeepResearchReport {
  return {
    ...report,
    objective: clipWhitespace(report.objective, REFINEMENT_REPORT_TEXT_LIMIT),
    methodology: clipWhitespace(report.methodology, REFINEMENT_REPORT_TEXT_LIMIT),
    findings: report.findings.slice(0, REFINEMENT_REPORT_LIST_LIMIT).map((finding) => ({
      ...finding,
      title: clipWhitespace(finding.title, 240),
      summary: clipWhitespace(finding.summary, REFINEMENT_REPORT_TEXT_LIMIT),
      evidenceIds: finding.evidenceIds.slice(0, REFINEMENT_REPORT_LIST_LIMIT),
    })),
    evidenceMatrix: report.evidenceMatrix.slice(0, REFINEMENT_REPORT_LIST_LIMIT).map((entry) => ({
      ...entry,
      relevance: clipWhitespace(entry.relevance, 500),
      quality: clipWhitespace(entry.quality, 240),
    })),
    contradictions: report.contradictions
      .slice(0, REFINEMENT_REPORT_LIST_LIMIT)
      .map((item) => clipWhitespace(item, REFINEMENT_REPORT_TEXT_LIMIT)),
    gaps: report.gaps
      .slice(0, REFINEMENT_REPORT_LIST_LIMIT)
      .map((item) => clipWhitespace(item, REFINEMENT_REPORT_TEXT_LIMIT)),
    confidence: clipWhitespace(report.confidence, REFINEMENT_REPORT_TEXT_LIMIT),
    sources: report.sources.slice(0, REFINEMENT_REPORT_SOURCE_LIMIT).map((source) => ({
      ...source,
      title: clipWhitespace(source.title, 300),
      url: clipWhitespace(source.url, 500),
      quality: clipWhitespace(source.quality, 120),
    })),
    markdown: clipWhitespace(report.markdown, REFINEMENT_REPORT_MARKDOWN_LIMIT),
  };
}

function isDeepResearchNode(node: RuntimeWorkflowNode): boolean {
  return typeof node.input?.deepResearchStep === "string";
}

function isDeepResearchReport(value: unknown): value is DeepResearchReport {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return (
    typeof record.objective === "string" &&
    typeof record.methodology === "string" &&
    Array.isArray(record.findings) &&
    Array.isArray(record.evidenceMatrix) &&
    Array.isArray(record.contradictions) &&
    Array.isArray(record.gaps) &&
    typeof record.confidence === "string" &&
    Array.isArray(record.sources) &&
    typeof record.markdown === "string"
  );
}

function isVerificationOpportunityRefinementNode(node: RuntimeWorkflowNode): boolean {
  return (
    node.id === "verification-opportunity-refinement" ||
    node.id.startsWith("verification-opportunity-refinement-") ||
    node.input?.verificationOptimizerStep === "opportunity-refinement"
  );
}

function readExternalResearchCandidates(payload: unknown): VerificationExternalResearchCandidate[] {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const candidates = record.verificationExternalResearchCandidates;
  if (!Array.isArray(candidates)) {
    return [];
  }
  return candidates.filter((candidate): candidate is VerificationExternalResearchCandidate => {
    const record =
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : {};
    return (
      typeof record.opportunityId === "string" &&
      typeof record.runId === "string" &&
      typeof record.reportNodeId === "string" &&
      typeof record.objective === "string"
    );
  });
}

function readCurrentOpportunityReview(
  context: WorkflowExecutionContext,
): VerificationOpportunityReview {
  return (
    getOptionalPayloadValue<VerificationOpportunityReview>(
      context,
      "verification-opportunity-refinement",
      "verificationOpportunityReview",
    ) ??
    getPayloadValue<VerificationOpportunityReview>(
      context,
      "verification-opportunity-mapping",
      "verificationOpportunityReview",
    )
  );
}

function normalizeBestPracticeOpportunity(
  existing: VerificationOpportunity | undefined,
  baseline: VerificationOpportunity,
): VerificationOpportunity {
  if (!existing) {
    return baseline;
  }
  return {
    ...baseline,
    ...existing,
    score: {
      confidence: Math.max(existing.score.confidence, baseline.score.confidence),
      impact: Math.max(existing.score.impact, baseline.score.impact),
      risk: Math.min(existing.score.risk, baseline.score.risk),
      implementationCost: Math.min(
        existing.score.implementationCost,
        baseline.score.implementationCost,
      ),
    },
    evidence: mergeEvidence(existing.evidence, baseline.evidence),
    proofCommands: uniqueCommands([...existing.proofCommands, ...baseline.proofCommands]),
    speculative: false,
  };
}

function rejectionReason(
  opportunity: VerificationOpportunity,
  thresholds: VerificationOptimizerThresholds,
): string | undefined {
  if (thresholds.requireNonSpeculative && opportunity.speculative) {
    return "speculative opportunities are not allowed";
  }
  if (opportunity.evidence.length < thresholds.minEvidenceReferences) {
    return `requires at least ${thresholds.minEvidenceReferences} evidence references`;
  }
  if (thresholds.requireProofCommands && opportunity.proofCommands.length === 0) {
    return "requires non-empty proof commands";
  }
  if (opportunity.score.confidence < thresholds.minConfidence) {
    return `confidence ${opportunity.score.confidence.toFixed(2)} is below ${thresholds.minConfidence.toFixed(2)}`;
  }
  if (opportunity.score.impact < thresholds.minImpact) {
    return `impact ${opportunity.score.impact.toFixed(2)} is below ${thresholds.minImpact.toFixed(2)}`;
  }
  if (opportunity.score.risk > thresholds.maxRisk) {
    return `risk ${opportunity.score.risk.toFixed(2)} exceeds ${thresholds.maxRisk.toFixed(2)}`;
  }
  if (opportunity.score.implementationCost > thresholds.maxImplementationCost) {
    return `implementation cost ${opportunity.score.implementationCost.toFixed(2)} exceeds ${thresholds.maxImplementationCost.toFixed(2)}`;
  }
  return undefined;
}

function compareVerificationOpportunities(
  left: VerificationOpportunity,
  right: VerificationOpportunity,
): number {
  const leftScore = opportunityQualityScore(left);
  const rightScore = opportunityQualityScore(right);
  return rightScore - leftScore;
}

function opportunityQualityScore(opportunity: VerificationOpportunity): number {
  return (
    opportunity.score.confidence * 0.35 +
    opportunity.score.impact * 0.3 -
    opportunity.score.risk * 0.2 -
    opportunity.score.implementationCost * 0.15 +
    Math.min(0.1, opportunity.evidence.length * 0.02)
  );
}

function augmentVerificationAuditWithLocalBestPracticeScan(
  audit: VerificationAudit,
  workingTree: string,
): VerificationAudit {
  const scan = scanLocalBestPracticeGaps(workingTree);
  if (scan.gaps.length === 0 && scan.evidence.length === 0) {
    return audit;
  }
  return {
    ...audit,
    gaps: uniqueStrings([...audit.gaps, ...scan.gaps]),
    evidence: mergeEvidence(audit.evidence, scan.evidence),
  };
}

function scanLocalBestPracticeGaps(workingTree: string): {
  gaps: string[];
  evidence: EvidenceReference[];
} {
  if (!existsSync(workingTree)) {
    return { gaps: [], evidence: [] };
  }

  const packageJson = readPackageJson(workingTree);
  const scripts =
    packageJson && typeof packageJson.scripts === "object" && packageJson.scripts
      ? (packageJson.scripts as Record<string, unknown>)
      : {};
  const packageKeys = Object.keys(packageJson ?? {});
  const gaps: string[] = [];
  const evidence: EvidenceReference[] = [];

  const hasLintScript = hasScript(scripts, /^lint(?::|$)/u);
  const hasFormatScript = hasScript(scripts, /^format(?::|$)/u);
  const hasLintConfig = anyPathExists(workingTree, [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.js",
    "oxlint.json",
    ".oxlintrc.json",
    "biome.json",
    "biome.jsonc",
  ]);
  const hasFormatConfig = anyPathExists(workingTree, [
    "prettier.config.js",
    "prettier.config.mjs",
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yml",
    ".prettierrc.yaml",
    "oxfmt.json",
    ".oxfmtrc.json",
    "biome.json",
    "biome.jsonc",
  ]);
  if (!hasLintScript && !hasFormatScript && !hasLintConfig && !hasFormatConfig) {
    gaps.push(
      "No lint or format scripts/configuration were found for ESLint, Prettier, Biome, or Oxlint.",
    );
    evidence.push({
      id: "local-lint-format-scan",
      source: "repository lint/format config scan",
      quote: "No lint/format package scripts or common lint/format config files were found.",
    });
  }

  const hasHookConfig =
    anyPathExists(workingTree, [
      ".husky",
      "lefthook.yml",
      "lefthook.yaml",
      ".lefthook.yml",
      ".lefthook.yaml",
      "lint-staged.config.js",
      "lint-staged.config.mjs",
      "lint-staged.config.cjs",
    ]) ||
    hasScriptValue(scripts, /(?:husky|lefthook)\s+(?:install|run|add)/u) ||
    packageKeys.includes("lint-staged");
  if (!hasHookConfig) {
    gaps.push(
      "No git commit hooks were found under .husky, lefthook, or lint-staged configuration.",
    );
    evidence.push({
      id: "local-git-hook-scan",
      source: "repository git hook config scan",
      quote:
        "No .husky, lefthook, lint-staged config, or hook installation package script was found.",
    });
  }

  const hasCoverageScript =
    hasScript(scripts, /^coverage(?::|$)/u) ||
    hasScriptValue(scripts, /\b(?:vitest|c8|nyc|v8)\b.*\bcoverage\b/u);
  const vitestConfig = readFirstExistingText(workingTree, [
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mjs",
  ]);
  const hasCoverageThreshold = Boolean(
    vitestConfig &&
    /\bcoverage\b[\s\S]*\b(?:threshold|thresholds|lines|branches|functions|statements)\b/u.test(
      vitestConfig,
    ),
  );
  if (!hasCoverageScript || !hasCoverageThreshold) {
    gaps.push("No coverage script or coverage threshold configuration was found.");
    evidence.push({
      id: "local-coverage-scan",
      source: "repository coverage config scan",
      quote: "No package coverage script and coverage threshold configuration were both present.",
    });
  }

  if (packageJson) {
    evidence.push({
      id: "local-package-json",
      source: "package.json",
      quote: "package.json scripts were inspected for lint, format, hook, and coverage commands.",
    });
  }

  return { gaps, evidence };
}

function readPackageJson(workingTree: string): Record<string, unknown> | undefined {
  const path = join(workingTree, "package.json");
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function hasScript(scripts: Record<string, unknown>, pattern: RegExp): boolean {
  return Object.keys(scripts).some((name) => pattern.test(name));
}

function hasScriptValue(scripts: Record<string, unknown>, pattern: RegExp): boolean {
  return Object.values(scripts).some(
    (script) => typeof script === "string" && pattern.test(script),
  );
}

function anyPathExists(workingTree: string, relativePaths: string[]): boolean {
  return relativePaths.some((relativePath) => existsSync(join(workingTree, relativePath)));
}

function readFirstExistingText(workingTree: string, relativePaths: string[]): string | undefined {
  for (const relativePath of relativePaths) {
    const path = join(workingTree, relativePath);
    if (!existsSync(path)) {
      continue;
    }
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function auditText(audit: VerificationAudit): string {
  return [
    audit.summary,
    ...audit.verificationCommands,
    ...audit.verificationSurfaces,
    ...audit.gaps,
    ...audit.evidence.flatMap((entry) => [entry.source, entry.quote ?? ""]),
  ]
    .join("\n")
    .toLowerCase();
}

function mentionsMissingLintOrFormat(text: string): boolean {
  return (
    /\bno\b[\s\S]{0,80}\b(?:lint|format|eslint|prettier|biome|oxlint|oxc)\b/u.test(text) ||
    /\bmissing\b[\s\S]{0,80}\b(?:lint|format|eslint|prettier|biome|oxlint|oxc)\b/u.test(text) ||
    /\black(?:s|ing)?\b[\s\S]{0,80}\b(?:lint|format|eslint|prettier|biome|oxlint|oxc)\b/u.test(text)
  );
}

function mentionsMissingGitHooks(text: string): boolean {
  return (
    /\bno\b[\s\S]{0,80}\b(?:git hook|commit hook|husky|lefthook|lint-staged)\b/u.test(text) ||
    /\bmissing\b[\s\S]{0,80}\b(?:git hook|commit hook|husky|lefthook|lint-staged)\b/u.test(text) ||
    /\black(?:s|ing)?\b[\s\S]{0,80}\b(?:git hook|commit hook|husky|lefthook|lint-staged)\b/u.test(
      text,
    )
  );
}

function mentionsMissingCoverage(text: string): boolean {
  return (
    /\bno\b[\s\S]{0,80}\b(?:coverage|threshold)\b/u.test(text) ||
    /\bmissing\b[\s\S]{0,80}\b(?:coverage|threshold)\b/u.test(text) ||
    /\black(?:s|ing)?\b[\s\S]{0,80}\b(?:coverage|threshold)\b/u.test(text)
  );
}

function bestPracticeEvidence(
  audit: VerificationAudit,
  keywords: string[],
  fallbackQuote: string,
): EvidenceReference[] {
  const matching = audit.evidence.filter((entry) => {
    const text = `${entry.source} ${entry.quote ?? ""}`.toLowerCase();
    return keywords.some((keyword) => text.includes(keyword));
  });
  return mergeEvidence(matching, [
    {
      id: `best-practice-${keywords[0] ?? "evidence"}`,
      source: "verification audit gap analysis",
      quote: fallbackQuote,
    },
    ...audit.evidence
      .filter((entry) =>
        /package\.json|config|scan|tests?|vitest/u.test(
          `${entry.source} ${entry.quote ?? ""}`.toLowerCase(),
        ),
      )
      .slice(0, 2),
  ]).slice(0, 4);
}

function mergeEvidence(left: EvidenceReference[], right: EvidenceReference[]): EvidenceReference[] {
  const byKey = new Map<string, EvidenceReference>();
  for (const entry of [...left, ...right]) {
    byKey.set(entry.id || `${entry.source}:${entry.quote ?? ""}`, entry);
  }
  return [...byKey.values()];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clipWhitespace(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildOpportunityRefinementNode(reportNodeIds: string[]): RuntimeWorkflowNode {
  return {
    id: "verification-opportunity-refinement",
    kind: WorkflowNodeKind.PLANNING,
    harness: WorkflowHarnessKind.RESEARCH,
    title: "Refine verification opportunities",
    description:
      "Refine repository-evidenced verification opportunities using completed external research reports.",
    model: "gpt-5.5",
    modelRationale:
      "Opportunity refinement uses typed BAML synthesis while preserving local repository evidence.",
    prompt: "Refine verification opportunities with external deep research.",
    input: { verificationOptimizerStep: "opportunity-refinement", reportNodeIds },
    dependsOn: reportNodeIds,
    gates: [WorkflowGateKind.OUTPUT_CONTRACT],
    writeMode: "read-only",
    replanPolicy: "on-contract-failure",
  };
}

function buildVerificationReviewNode(dependency: string): RuntimeWorkflowNode {
  return {
    id: "verification-review",
    kind: WorkflowNodeKind.DELIBERATION,
    harness: WorkflowHarnessKind.DECISION_COUNCIL,
    title: "Review verification recommendation",
    description:
      "Apply strict gates and select at most one high-confidence verification-only improvement.",
    model: "deterministic",
    modelRationale: "Strict review is deterministic after typed opportunity mapping.",
    prompt: "Review verification opportunities against strict acceptance gates.",
    dependsOn: [dependency],
    gates: [WorkflowGateKind.REVIEW_ACCEPTED],
    writeMode: "read-only",
    replanPolicy: "on-review-rejection",
  };
}

function buildNoOpportunityReportNode(): RuntimeWorkflowNode {
  return {
    id: "report-no-verification-opportunity",
    kind: WorkflowNodeKind.REPORT,
    harness: WorkflowHarnessKind.REPORTER,
    title: "Report no verification opportunity",
    description:
      "Publish a deterministic report explaining why no strict verification opportunity was accepted.",
    model: "deterministic",
    modelRationale: "No-op reporting formats the deterministic strict-gate result.",
    prompt: "Report that no strict verification-only opportunity was selected.",
    dependsOn: ["verification-review"],
    gates: [WorkflowGateKind.OUTPUT_CONTRACT],
    writeMode: "read-only",
    replanPolicy: "never",
  };
}

function buildAcceptedAdvisoryReportNode(): RuntimeWorkflowNode {
  return {
    id: "report-verification-opportunity",
    kind: WorkflowNodeKind.REPORT,
    harness: WorkflowHarnessKind.REPORTER,
    title: "Report verification opportunity",
    description:
      "Publish the selected strict verification-only recommendation without making changes.",
    model: "deterministic",
    modelRationale: "Advisory mode reports the accepted recommendation without a writer node.",
    prompt: "Report the selected strict verification-only opportunity.",
    dependsOn: ["verification-review"],
    gates: [WorkflowGateKind.OUTPUT_CONTRACT],
    writeMode: "read-only",
    replanPolicy: "never",
  };
}

function buildAutonomousPrNodes(opportunity: VerificationOpportunity): RuntimeWorkflowNode[] {
  return [
    {
      id: "prepare-worktree",
      kind: WorkflowNodeKind.PLANNING,
      harness: WorkflowHarnessKind.VERIFIER,
      title: "Prepare verification worktree",
      description: "Prepare an isolated worktree for the verification-only improvement.",
      model: "deterministic",
      modelRationale: "Worktree preparation is deterministic shell orchestration.",
      prompt: "Prepare an isolated worktree before modifying verification assets.",
      input: { opportunity },
      dependsOn: ["verification-review"],
      gates: [WorkflowGateKind.OUTPUT_CONTRACT],
      writeMode: "read-only",
      replanPolicy: "never",
    },
    {
      id: "implement-verification-improvement",
      kind: WorkflowNodeKind.IMPLEMENTATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Implement verification improvement",
      description: "Implement the selected verification-only improvement in the prepared worktree.",
      model: "gpt-5.3-codex",
      modelRationale: "Implementation uses the Codex implementation tier.",
      prompt: `Implement selected verification-only opportunity ${opportunity.id}.`,
      input: { opportunity },
      dependsOn: ["prepare-worktree"],
      gates: [WorkflowGateKind.VERIFICATION],
      writeMode: "single-writer",
      replanPolicy: "on-verification-failure",
    },
    {
      id: "run-verification-commands",
      kind: WorkflowNodeKind.VERIFICATION,
      harness: WorkflowHarnessKind.VERIFIER,
      title: "Run verification commands",
      description: "Run configured project validation plus selected proof commands.",
      model: "deterministic",
      modelRationale: "Verification executes shell commands.",
      prompt: "Run project validation commands and candidate proof commands.",
      input: { opportunity },
      dependsOn: ["implement-verification-improvement"],
      gates: [WorkflowGateKind.VERIFICATION],
      writeMode: "read-only",
      replanPolicy: "on-verification-failure",
    },
    {
      id: "review-verification-implementation",
      kind: WorkflowNodeKind.DELIBERATION,
      harness: WorkflowHarnessKind.COPILOT_SDK,
      title: "Review verification implementation",
      description:
        "Review that the implementation stayed verification-only and passed proof commands.",
      model: "gpt-5.5",
      modelRationale: "Post-implementation review uses a strong review model.",
      prompt: "Review the verification-only implementation.",
      input: { opportunity },
      dependsOn: ["run-verification-commands"],
      gates: [WorkflowGateKind.REVIEW_ACCEPTED],
      writeMode: "read-only",
      replanPolicy: "never",
    },
    {
      id: "open-pr",
      kind: WorkflowNodeKind.REPORT,
      harness: WorkflowHarnessKind.REPORTER,
      title: "Open verification pull request",
      description: "Open or prepare a pull request for the verified verification-only improvement.",
      model: "deterministic",
      modelRationale: "PR creation uses deterministic shell integration.",
      prompt: "Open a pull request for the verified verification-only improvement.",
      input: { opportunity },
      dependsOn: ["review-verification-implementation"],
      gates: [WorkflowGateKind.OUTPUT_CONTRACT],
      writeMode: "read-only",
      replanPolicy: "never",
    },
  ];
}

function resolveThresholds(
  options: VerificationOptimizerHarnessOptions,
): VerificationOptimizerThresholds {
  return {
    ...DEFAULT_THRESHOLDS,
    ...options.verificationOptimizer?.thresholds,
    ...options.thresholds,
  };
}

function resolveBamlClient(
  options: VerificationOptimizerHarnessOptions,
): VerificationOptimizerBamlClient {
  const deterministic = createDeterministicBamlClient(options);
  const injected = options.baml;
  return {
    DistillVerificationAudit:
      injected?.DistillVerificationAudit?.bind(injected) ?? deterministic.DistillVerificationAudit,
    MapVerificationOpportunities:
      injected?.MapVerificationOpportunities?.bind(injected) ??
      deterministic.MapVerificationOpportunities,
    RefineVerificationOpportunitiesWithResearch:
      injected?.RefineVerificationOpportunitiesWithResearch?.bind(injected) ??
      deterministic.RefineVerificationOpportunitiesWithResearch,
    ReviewVerificationRecommendation:
      injected?.ReviewVerificationRecommendation?.bind(injected) ??
      deterministic.ReviewVerificationRecommendation,
  };
}

function createDeterministicBamlClient(
  options: VerificationOptimizerHarnessOptions,
): VerificationOptimizerBamlClient {
  return {
    async DistillVerificationAudit(projectJson) {
      const project = readJsonRecord(projectJson);
      return {
        projectId: String(project.id ?? options.project.id),
        summary: "Offline verification audit summarized the configured validation surface.",
        verificationCommands: options.project.validationCommands,
        verificationSurfaces: ["tests", "typecheck", "scripts"],
        gaps: ["A focused verification improvement can make workflow behavior easier to prove."],
        evidence: [
          { id: "audit-e1", source: "package.json", quote: "test" },
          { id: "audit-e2", source: "tests", quote: "verification" },
        ],
      };
    },
    async MapVerificationOpportunities(audit) {
      return {
        opportunities: [
          {
            id: "verification-1",
            title: "Add focused workflow verification",
            currentVerificationGap: audit.gaps[0] ?? "Verification coverage can be improved.",
            targetChange: "Add a focused verification test and explicit proof command.",
            allowedChangeKind: "test",
            score: { confidence: 0.9, impact: 0.7, risk: 0.2, implementationCost: 0.3 },
            evidence: audit.evidence.slice(0, 2),
            proofCommands:
              audit.verificationCommands.length > 0 ? audit.verificationCommands : ["nub run test"],
            speculative: false,
          },
        ],
        nonApplicableGaps: [],
        rankingRationale: "Offline harness emits one strict verification-only opportunity.",
      };
    },
    async RefineVerificationOpportunitiesWithResearch(_audit, initialReview) {
      return {
        ...initialReview,
        rankingRationale: [
          initialReview.rankingRationale,
          "Offline harness did not apply external deep research refinement.",
        ]
          .filter(Boolean)
          .join(" "),
      };
    },
    async ReviewVerificationRecommendation(_audit, selectedOpportunity) {
      if (!selectedOpportunity) {
        return buildRejectedReview("No selected verification opportunity.");
      }
      return {
        status: "accepted",
        selectedOpportunity,
        rationale:
          "The selected opportunity is verification-only, evidenced, and has explicit proof commands.",
        rejectionReason: null,
        proofCommands: selectedOpportunity.proofCommands,
      };
    },
  };
}

function normalizeAcceptedReview(
  review: VerificationRecommendationReview,
  selectedOpportunity: VerificationOpportunity,
): VerificationRecommendationReview {
  if (review.status !== "accepted") {
    return review;
  }
  return {
    ...review,
    selectedOpportunity: review.selectedOpportunity ?? selectedOpportunity,
    proofCommands:
      review.proofCommands.length > 0 ? review.proofCommands : selectedOpportunity.proofCommands,
  };
}

function buildRejectedReview(reason: string): VerificationRecommendationReview {
  return {
    status: "rejected",
    selectedOpportunity: null,
    rationale: reason,
    rejectionReason: reason,
    proofCommands: [],
  };
}

function readSelectedOpportunity(
  review: VerificationRecommendationReview,
): VerificationOpportunity {
  if (!review.selectedOpportunity) {
    throw new Error("Verification review did not include a selected opportunity.");
  }
  return review.selectedOpportunity;
}

function readProofCommands(
  review: VerificationRecommendationReview,
  opportunity: VerificationOpportunity,
): string[] {
  return review.proofCommands.length > 0 ? review.proofCommands : opportunity.proofCommands;
}

function uniqueCommands(commands: string[]): string[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const normalized = command.trim();
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

async function runValidationCommands(
  commands: string[],
  cwd: string,
  shell?: VerificationOptimizerShellClient,
): Promise<string> {
  if (commands.length === 0) {
    return "No verification commands configured.";
  }
  const run = shell?.run ?? defaultShellRun;
  const outputs: string[] = [];
  for (const command of commands) {
    outputs.push(await run("sh", ["-lc", command], { cwd }));
  }
  return outputs.join("\n");
}

async function openPullRequest(
  cwd: string,
  shell?: VerificationOptimizerShellClient,
): Promise<string> {
  if (!shell) {
    return "not-opened-by-test-harness";
  }
  const output = await shell.run("gh", ["pr", "create", "--fill"], { cwd });
  return output.trim() || "not-opened";
}

async function defaultShellRun(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<string> {
  const result = await execFileAsync(command, args, { cwd: options.cwd });
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function readWorktreePath(context: WorkflowExecutionContext): string {
  return getPayloadValue<WorktreePreparationResult>(
    context,
    "prepare-worktree",
    "worktreePreparation",
  ).worktreePath;
}

function readOptionalWorktreePath(context: WorkflowExecutionContext): string | undefined {
  return getOptionalPayloadValue<WorktreePreparationResult>(
    context,
    "prepare-worktree",
    "worktreePreparation",
  )?.worktreePath;
}

function getPayloadValue<T>(context: WorkflowExecutionContext, nodeId: string, key: string): T {
  const payload = context.payloads.get(nodeId);
  if (!payload || !(key in payload)) {
    throw new Error(`Missing payload ${nodeId}.${key}`);
  }
  return payload[key] as T;
}

function getOptionalPayloadValue<T>(
  context: WorkflowExecutionContext,
  nodeId: string,
  key: string,
): T | undefined {
  const payload = context.payloads.get(nodeId);
  return payload && key in payload ? (payload[key] as T) : undefined;
}

function readJsonRecord(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function buildExecutionMetadata(
  executor: string,
  calls: WorkflowExecutionCall[],
): WorkflowExecutionMetadata {
  const firstCall = calls[0];
  return {
    executor,
    operation: firstCall?.operation,
    mode: firstCall?.mode,
    prompt: firstCall?.prompt,
    cwd: firstCall?.cwd,
    model: firstCall?.model,
    calls,
  };
}

function copilotCall(args: {
  mode: "research" | "implement" | "review";
  cwd?: string;
  prompt: string;
  model?: string;
}): WorkflowExecutionCall {
  return {
    executor: "copilot-sdk",
    mode: args.mode,
    cwd: args.cwd,
    prompt: args.prompt,
    model: args.model,
  };
}

function bamlCall(operation: string, prompt?: string): WorkflowExecutionCall {
  return {
    executor: "baml",
    operation,
    model: process.env.BAML_MODEL,
    prompt,
  };
}

function buildMapVerificationOpportunitiesPromptPreview(audit: unknown): string {
  return [
    "Map the verification audit into strict verification-only opportunities.",
    "Preserve repository evidence for each gap and reject speculative opportunities.",
    "",
    "Verification audit:",
    JSON.stringify(audit, null, 2),
  ].join("\n");
}

function buildRefineVerificationOpportunitiesPromptPreview(
  audit: unknown,
  initialReview: unknown,
  researchReports: unknown[],
): string {
  return [
    "Refine verification opportunities with external research reports.",
    "External research may refine tool choice, risk, cost, and proof commands, but must not supply repository evidence for local gaps.",
    "",
    "Verification audit:",
    JSON.stringify(audit, null, 2),
    "",
    "Initial opportunity review:",
    JSON.stringify(initialReview, null, 2),
    "",
    "External research reports:",
    JSON.stringify(researchReports, null, 2),
  ].join("\n");
}

function reporterExecution(node: RuntimeWorkflowNode): WorkflowExecutionMetadata {
  return buildExecutionMetadata(WorkflowHarnessKind.REPORTER, [
    {
      executor: WorkflowHarnessKind.REPORTER,
      operation: node.id,
      mode: "report",
      prompt: node.prompt,
      model: node.model ?? "deterministic",
    },
  ]);
}
