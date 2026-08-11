import type { Span } from "@opentelemetry/api";
import type { WeavekitConfig } from "../../config.js";
import {
  ReviewOpenItemKind,
  ReviewOpenItemOwner,
  ReviewReadiness,
  type MastermindNextActionDecision,
  type MastermindReviewDecisionContext,
} from "../../generated/baml_client/index.js";
import { resolveMastermindProjectPolicy } from "../config.js";
import { eventForRecommendedAction, transitionMastermindState } from "../domain/machine.js";
import { resolveMastermindFailureReasons } from "../failure.js";
import {
  MastermindAction,
  MastermindEventType,
  MastermindState,
  type MastermindEvent,
  type MastermindState as MastermindStateValue,
} from "../domain/events.js";
import {
  applyReviewProposal,
  generateReviewProposal,
  toBamlTicket,
} from "../actions/reviewTicket.js";
import type { MastermindDecisionProvider } from "./bamlAdapters.js";
import type { LinearGateway } from "../linear/client.js";
import type { TicketReviewHarness } from "../review/harness.js";
import { getStoredReviewDispositionGapReason, hashLinearTicketContent } from "../review/policy.js";
import type {
  LinearTicketSnapshot,
  MastermindStore,
  MastermindWorkItem,
  StoredReview,
} from "../store/store.js";
import {
  addMastermindProgressEvent,
  createLeaseTelemetryAccumulator,
  setMastermindSpanOutput,
  setMastermindWorkAttributes,
  traceMastermindWork,
  withMastermindSpan,
} from "../telemetry.js";

export class MastermindDecisionLoop {
  constructor(
    private readonly config: WeavekitConfig,
    private readonly store: MastermindStore,
    private readonly linear: LinearGateway,
    private readonly decisions: MastermindDecisionProvider,
    private readonly reviewHarness: TicketReviewHarness,
    private readonly onProgress?: (message: string) => void,
  ) {}

  async process(workId: string): Promise<void> {
    await traceMastermindWork(
      workId,
      (traceInfo) => {
        this.emitProgress(
          traceInfo.url
            ? `Langfuse trace: ${traceInfo.url}`
            : `Langfuse trace ID: ${traceInfo.traceId}. Set LANGFUSE_PROJECT_ID for a direct URL.`,
        );
      },
      async (span) => {
        await this.processWithinTrace(workId, span);
        const finalWork = await this.store.getWork(workId);
        if (finalWork) {
          const failureReasons =
            finalWork.state === MastermindState.FAILED
              ? await resolveMastermindFailureReasons(this.store, workId)
              : [];
          setMastermindWorkAttributes(span, finalWork);
          const result = {
            workId,
            issueId: finalWork.issueId,
            state: finalWork.state,
            plannedAction: finalWork.plannedAction,
            ...(failureReasons.length ? { failureReasons } : {}),
          };
          setMastermindSpanOutput(span, result);
          return result;
        }
        const result = { workId, state: "lease_not_acquired" };
        setMastermindSpanOutput(span, result);
        return result;
      },
    );
  }

  private async processWithinTrace(workId: string, rootSpan: Span): Promise<void> {
    let work = await withMastermindSpan(
      "mastermind.acquire_lease",
      {
        "langfuse.observation.type": "span",
        "weavekit.mastermind.work_id": workId,
      },
      async (span) => {
        const acquired = await this.store.acquireLease(
          workId,
          this.config.mastermind.instanceId,
          new Date(),
          this.config.mastermind.leaseDurationMs,
        );
        setMastermindSpanOutput(span, { acquired: Boolean(acquired) });
        return acquired;
      },
    );
    if (!work) {
      return;
    }
    const lease = createLeaseHeartbeat({
      store: this.store,
      workId,
      owner: this.config.mastermind.instanceId,
      durationMs: this.config.mastermind.leaseDurationMs,
      rootSpan,
    });
    try {
      const entryWork = work;
      work = await withMastermindSpan(
        "mastermind.normalize_entry_state",
        {
          "langfuse.observation.type": "chain",
          "weavekit.mastermind.work_id": entryWork.id,
          "weavekit.mastermind.state": entryWork.state,
        },
        () => this.normalizeEntryState(entryWork),
      );
      const normalizedWork = work;
      work = await withMastermindSpan(
        "mastermind.review_freshness",
        {
          "langfuse.observation.type": "chain",
          "weavekit.mastermind.work_id": normalizedWork.id,
          "weavekit.mastermind.state": normalizedWork.state,
        },
        () => this.reopenReviewIfStale(normalizedWork),
      );
      let decisionIterations = 0;
      const maxSteps = this.config.mastermind.maxDecisionIterations * 4 + 4;
      for (let step = 0; step < maxSteps; step += 1) {
        if (isTerminal(work.state)) {
          return;
        }
        if (work.state === MastermindState.REVIEWING) {
          work = await this.generateReview(work, lease);
          continue;
        }
        if (work.state === MastermindState.APPLYING_REVIEW) {
          work = await this.applyReview(work, lease);
          continue;
        }
        if (work.state !== MastermindState.DECIDING) {
          throw new Error(`Unsupported Mastermind loop state: ${work.state}`);
        }
        if (decisionIterations >= this.config.mastermind.maxDecisionIterations) {
          work = await this.applyTransition(work, {
            type: MastermindEventType.REQUIRE_HUMAN,
          });
          return;
        }
        decisionIterations += 1;
        work = await this.decide(work);
      }
      if (!isTerminal(work.state)) {
        await this.applyTransition(work, { type: MastermindEventType.REQUIRE_HUMAN });
      }
    } finally {
      await lease.stop();
      await this.store.releaseLease(workId, this.config.mastermind.instanceId);
    }
  }

  private async normalizeEntryState(work: MastermindWorkItem): Promise<MastermindWorkItem> {
    if (work.state === MastermindState.RECEIVED) {
      work = await this.applyTransition(work, { type: MastermindEventType.CLAIM });
    } else if (work.state === MastermindState.RETRY_WAIT) {
      work = await this.applyTransition(work, { type: MastermindEventType.RETRY_READY });
    }
    if (work.state === MastermindState.CLAIMED) {
      work = await this.applyTransition(work, { type: MastermindEventType.DECIDE });
    }
    return work;
  }

  private async reopenReviewIfStale(work: MastermindWorkItem): Promise<MastermindWorkItem> {
    if (
      work.state !== MastermindState.ACTION_PLANNED &&
      work.state !== MastermindState.NEEDS_HUMAN &&
      work.state !== MastermindState.FAILED
    ) {
      return work;
    }
    const ticket = await this.linear.fetchIssue(work.issueId);
    const review = await this.store.getLatestReview(work.id);
    const expectedLabelId =
      work.state === MastermindState.ACTION_PLANNED
        ? this.config.mastermind.reviewedLabelId
        : work.state === MastermindState.NEEDS_HUMAN
          ? this.config.mastermind.needsInputLabelId
          : this.config.mastermind.reviewFailedLabelId;
    const expectedLabelPresent = ticket.labels.some((label) => label.id === expectedLabelId);
    const latestObservedSnapshot =
      review?.appliedSnapshot ??
      (work.state === MastermindState.FAILED
        ? await this.store.getLatestTicketSnapshot(work.id)
        : undefined);
    const contentIsFresh =
      latestObservedSnapshot !== undefined &&
      hashLinearTicketContent(latestObservedSnapshot) === hashLinearTicketContent(ticket);
    const reviewDispositionGapReason = review ? getStoredReviewDispositionGapReason(review) : null;
    if (work.state === MastermindState.FAILED && review === undefined) {
      if (latestObservedSnapshot === undefined || contentIsFresh) {
        this.emitProgress(
          formatTicketFreshnessProgress({
            work,
            ticket,
            expectedLabelName: expectedLabelNameForState(this.config, work.state),
            next: nextStepForCurrentReview(work),
          }),
        );
        return work;
      }
      this.emitProgress(
        formatTicketFreshnessProgress({
          work,
          ticket,
          expectedLabelName: expectedLabelNameForState(this.config, work.state),
          next: "Reopen review because the Linear ticket content changed after the last observed failed review attempt; clear Mastermind labels and generate a fresh review.",
        }),
      );
      await this.linear.replaceIssueLabels(work.issueId, {
        remove: [
          this.config.mastermind.reviewedLabelId,
          this.config.mastermind.readyLabelId,
          this.config.mastermind.needsInputLabelId,
          this.config.mastermind.reviewFailedLabelId,
        ],
        add: [],
      });
      return this.applyTransition(work, {
        type: MastermindEventType.REOPEN_REVIEW,
      });
    }
    if (
      expectedLabelPresent &&
      review !== undefined &&
      contentIsFresh &&
      !reviewDispositionGapReason
    ) {
      this.emitProgress(
        formatTicketFreshnessProgress({
          work,
          ticket,
          expectedLabelName: expectedLabelNameForState(this.config, work.state),
          next: nextStepForCurrentReview(work),
        }),
      );
      return work;
    }
    const staleReasons = [
      ...(expectedLabelPresent
        ? []
        : [
            `the expected "${expectedLabelNameForState(this.config, work.state)}" label is missing`,
          ]),
      ...(review === undefined
        ? [
            `no current stored review exists for the "${expectedLabelNameForState(
              this.config,
              work.state,
            )}" ticket`,
          ]
        : []),
      ...(reviewDispositionGapReason ? [reviewDispositionGapReason] : []),
      ...(review && !contentIsFresh
        ? ["the Linear ticket content changed after the stored review was applied"]
        : []),
    ];
    this.emitProgress(
      formatTicketFreshnessProgress({
        work,
        ticket,
        expectedLabelName: expectedLabelNameForState(this.config, work.state),
        next: `Reopen review because ${staleReasons.join(" and ")}; ${
          review
            ? "invalidate the stored review, clear Mastermind labels, and generate a fresh review."
            : "clear Mastermind labels and generate a fresh review."
        }`,
      }),
    );
    if (review) {
      await this.store.invalidateReview(
        review.id,
        reviewDispositionGapReason
          ? `Stored review ${review.id} requires regeneration: ${reviewDispositionGapReason}.`
          : `Linear issue ${work.issueId} changed after review completion.`,
      );
    }
    await this.linear.replaceIssueLabels(work.issueId, {
      remove: [
        this.config.mastermind.reviewedLabelId,
        this.config.mastermind.readyLabelId,
        this.config.mastermind.needsInputLabelId,
        this.config.mastermind.reviewFailedLabelId,
      ],
      add: [],
    });
    return this.applyTransition(work, {
      type: MastermindEventType.REOPEN_REVIEW,
    });
  }

  private async decide(work: MastermindWorkItem): Promise<MastermindWorkItem> {
    return withMastermindSpan(
      "mastermind.decide",
      {
        "langfuse.observation.type": "chain",
        "weavekit.mastermind.work_id": work.id,
        "weavekit.mastermind.issue_id": work.issueId,
      },
      async (span) => {
        const ticket = await this.linear.fetchIssue(work.issueId);
        await this.store.saveTicketSnapshot(work.id, ticket);
        const policy = resolveMastermindProjectPolicy(this.config, ticket);
        if (!policy) {
          return this.applyTransition(work, { type: MastermindEventType.REQUIRE_HUMAN });
        }
        if (work.projectPolicyId !== policy.project.id) {
          await this.store.setProjectPolicy(work.id, policy.project.id);
          work = (await this.store.getWork(work.id)) ?? work;
        }
        const hasCurrentReview = hasReviewedLabel(
          ticket,
          this.config.mastermind.reviewedLabelId,
          this.config.mastermind.reviewedLabelName,
        );
        const reviewDecisionInput = buildReviewDecisionInput({
          hasCurrentReview,
          review: await this.store.getLatestReview(work.id),
        });
        this.emitProgress(
          hasCurrentReview
            ? "Selecting the next action for the reviewed ticket."
            : "Selecting the initial review action.",
        );
        const decision =
          reviewDecisionInput.mode === "deterministic"
            ? reviewDecisionInput.decision
            : await this.decisions.decideNextAction(
                toBamlTicket(ticket),
                policy.baml,
                reviewDecisionInput.context,
              );
        const recommendedAction = validateRecommendedAction(reviewDecisionInput.context, decision);
        await this.store.saveDecision(work.id, decision);
        const event = eventForRecommendedAction(
          recommendedAction.action,
          this.config.mastermind.allowedActions,
        );
        const next = await this.applyTransition(work, event, {
          decision,
          reviewContext: reviewDecisionInput.context,
          ...(reviewDecisionInput.mode === "deterministic"
            ? {
                deterministicRouting: {
                  reason: reviewDecisionInput.reason,
                  action: decision.action,
                },
              }
            : recommendedAction.override
              ? { decisionOverride: recommendedAction.override }
              : {}),
          plannedAction:
            event.type === MastermindEventType.PLAN_ACTION ? recommendedAction.action : undefined,
        });
        setMastermindSpanOutput(span, {
          decision,
          reviewContext: reviewDecisionInput.context,
          ...(recommendedAction.override ? { decisionOverride: recommendedAction.override } : {}),
          nextState: next.state,
          plannedAction: next.plannedAction,
        });
        return next;
      },
    );
  }

  private async generateReview(
    work: MastermindWorkItem,
    lease: LeaseHeartbeat,
  ): Promise<MastermindWorkItem> {
    const ticket = await this.linear.fetchIssue(work.issueId);
    const policy = resolveMastermindProjectPolicy(this.config, ticket);
    if (!policy) {
      return this.applyTransition(work, { type: MastermindEventType.FAIL });
    }
    let review: StoredReview;
    try {
      review = await generateReviewProposal({
        workId: work.id,
        ticket,
        project: policy.baml,
        harness: this.reviewHarness,
        decisions: this.decisions,
        store: this.store,
        assertLease: () => lease.assertActive(),
        onProgress: (message) => this.emitProgress(message),
      });
    } catch (error) {
      await lease.assertActive();
      await this.linear.replaceIssueLabels(work.issueId, {
        remove: [
          this.config.mastermind.reviewedLabelId,
          this.config.mastermind.readyLabelId,
          this.config.mastermind.needsInputLabelId,
        ],
        add: [this.config.mastermind.reviewFailedLabelId],
      });
      await this.store.saveTicketSnapshot(work.id, await this.linear.fetchIssue(work.issueId));
      return this.applyTransition(
        work,
        { type: MastermindEventType.FAIL },
        {
          reviewError: error instanceof Error ? error.message : "Unknown ticket review failure.",
        },
      );
    }
    return this.applyTransition(
      work,
      { type: MastermindEventType.REVIEW_GENERATED },
      {
        reviewId: review.id,
      },
    );
  }

  private async applyReview(
    work: MastermindWorkItem,
    lease: LeaseHeartbeat,
  ): Promise<MastermindWorkItem> {
    const review = await this.store.getLatestReview(work.id);
    if (!review) {
      throw new Error(`Mastermind work item ${work.id} has no review proposal.`);
    }
    this.emitProgress("Applying the governed review result to Linear.");
    const result = await applyReviewProposal({
      issueId: work.issueId,
      review,
      statusLabelIds: {
        reviewed: this.config.mastermind.reviewedLabelId,
        ready: this.config.mastermind.readyLabelId,
        needsInput: this.config.mastermind.needsInputLabelId,
        failed: this.config.mastermind.reviewFailedLabelId,
      },
      linear: this.linear,
      store: this.store,
      assertLease: () => lease.assertActive(),
    });
    if (result.stale) {
      return this.applyTransition(work, {
        type: MastermindEventType.REVIEW_INVALIDATED,
      });
    }
    if (result.failed) {
      return this.applyTransition(
        work,
        {
          type: MastermindEventType.FAIL,
        },
        {
          reviewId: review.id,
          reviewFailureReasons: result.failureReasons ?? ["Review application failed."],
        },
      );
    }
    if (result.requiresHumanApproval) {
      this.emitProgress("Review requires human input; ticket content was not rewritten.");
      return this.applyTransition(work, {
        type: MastermindEventType.REQUIRE_HUMAN,
      });
    }
    this.emitProgress("Linear update complete; selecting the next bounded action.");
    return this.applyTransition(
      work,
      { type: MastermindEventType.REVIEW_APPLIED },
      {
        reviewId: review.id,
      },
    );
  }

  private applyTransition(
    work: MastermindWorkItem,
    event: MastermindEvent,
    metadata?: Record<string, unknown>,
  ): Promise<MastermindWorkItem> {
    const nextState = transitionMastermindState(work.state, event);
    return withMastermindSpan(
      "mastermind.state_transition",
      {
        "langfuse.observation.type": "span",
        "weavekit.mastermind.work_id": work.id,
        "weavekit.mastermind.event": event.type,
        "weavekit.mastermind.prior_state": work.state,
        "weavekit.mastermind.next_state": nextState,
      },
      async (span) => {
        const transitioned = await this.store.transition(work, this.config.mastermind.instanceId, {
          eventType: event.type,
          priorState: work.state,
          nextState,
          metadata,
        });
        setMastermindSpanOutput(span, {
          event: event.type,
          priorState: work.state,
          nextState: transitioned.state,
        });
        return transitioned;
      },
    );
  }

  private emitProgress(message: string): void {
    addMastermindProgressEvent(message);
    this.onProgress?.(message);
  }
}

function expectedLabelNameForState(
  config: WeavekitConfig,
  state:
    | typeof MastermindState.ACTION_PLANNED
    | typeof MastermindState.NEEDS_HUMAN
    | typeof MastermindState.FAILED,
): string {
  if (state === MastermindState.ACTION_PLANNED) {
    return config.mastermind.reviewedLabelName;
  }
  if (state === MastermindState.NEEDS_HUMAN) {
    return config.mastermind.needsInputLabelName;
  }
  return config.mastermind.reviewFailedLabelName;
}

function formatTicketFreshnessProgress(input: {
  work: MastermindWorkItem;
  ticket: LinearTicketSnapshot;
  expectedLabelName: string;
  next: string;
}): string {
  return [
    `Pulled Linear ticket ${input.ticket.identifier} — ${input.ticket.title}`,
    `URL: ${input.ticket.url}`,
    `Reason: ${ticketFetchReason(input.work, input.expectedLabelName)}`,
    `Next: ${input.next}`,
  ].join("\n");
}

function ticketFetchReason(work: MastermindWorkItem, expectedLabelName: string): string {
  if (work.state === MastermindState.ACTION_PLANNED) {
    return `Work item ${work.id} is action_planned. Mastermind is verifying that the completed review and "${expectedLabelName}" label still match Linear before reusing the planned action.`;
  }
  if (work.state === MastermindState.NEEDS_HUMAN) {
    return `Work item ${work.id} is needs_human. Mastermind is checking for human ticket edits or removal of the "${expectedLabelName}" label before deciding whether to review again.`;
  }
  return `Work item ${work.id} is failed. Mastermind is checking for ticket edits or removal of the "${expectedLabelName}" label before deciding whether the failed review should be retried.`;
}

function nextStepForCurrentReview(work: MastermindWorkItem): string {
  if (work.state === MastermindState.ACTION_PLANNED) {
    return `The ticket still matches the completed review; keep action_planned and continue with ${work.plannedAction ?? "the planned action"}.`;
  }
  if (work.state === MastermindState.NEEDS_HUMAN) {
    return "The ticket has not changed; keep needs_human and wait for human input.";
  }
  return "The ticket has not changed; keep failed and wait for an explicit retry condition.";
}

function hasReviewedLabel(
  ticket: LinearTicketSnapshot,
  labelId: string,
  labelName: string,
): boolean {
  return ticket.labels.some(
    (label) => label.id === labelId || label.name.toLowerCase() === labelName.toLowerCase(),
  );
}

function isTerminal(state: MastermindStateValue): boolean {
  const terminalStates: readonly MastermindStateValue[] = [
    MastermindState.ACTION_PLANNED,
    MastermindState.NEEDS_HUMAN,
    MastermindState.IGNORED,
    MastermindState.FAILED,
  ];
  return terminalStates.includes(state);
}

export type { MastermindNextActionDecision };

type ReviewDecisionInput =
  | {
      mode: "deterministic";
      reason: string;
      decision: MastermindNextActionDecision;
      context: MastermindReviewDecisionContext;
    }
  | {
      mode: "llm";
      context: MastermindReviewDecisionContext;
    };

type RecommendedActionValidation = {
  action: MastermindAction;
  override?: {
    originalAction: MastermindAction;
    overriddenAction: MastermindAction;
    reason: string;
    missingExecutorPreflightItems?: string[];
  };
};

export type LeaseHeartbeat = {
  assertActive(): Promise<void>;
  stop(): Promise<void>;
};

function buildReviewDecisionInput(args: {
  hasCurrentReview: boolean;
  review?: StoredReview;
}): ReviewDecisionInput {
  if (!args.hasCurrentReview) {
    return {
      mode: "llm",
      context: emptyReviewDecisionContext(false),
    };
  }

  const review = args.review;
  if (!review?.validation?.accepted || !review.labelApplied || !review.appliedSnapshot) {
    return {
      mode: "deterministic",
      reason: "Reviewed label exists without an accepted applied stored review.",
      context: emptyReviewDecisionContext(false),
      decision: buildDeterministicDecision(
        MastermindAction.REVIEW_TICKET,
        "Mastermind must regenerate the review before planning the next action.",
        [
          "Mastermind requires an accepted, applied, non-invalidated review before implementation planning.",
        ],
      ),
    };
  }

  const storedReviewDispositionGapReason = getStoredReviewDispositionGapReason(review);
  if (storedReviewDispositionGapReason) {
    return {
      mode: "deterministic",
      reason: storedReviewDispositionGapReason,
      context: emptyReviewDecisionContext(false),
      decision: buildDeterministicDecision(
        MastermindAction.REVIEW_TICKET,
        "Mastermind must regenerate the stored review before planning the next action.",
        [
          "Stored reviews without complete open-item ownership cannot drive implementation planning.",
          storedReviewDispositionGapReason,
        ],
      ),
    };
  }

  const context: MastermindReviewDecisionContext = {
    hasCurrentReview: true,
    readiness: review.patch.readiness,
    requiresHumanApproval:
      review.validation.requiresHumanApproval || review.patch.requiresHumanApproval,
    blockingReasons: review.patch.blockingReasons,
    warnings: review.patch.warnings,
    unansweredQuestions: review.patch.unansweredQuestions,
    openItemDispositions: review.patch.openItemDispositions,
    reviewConfidence: review.patch.confidence,
  };

  if (context.requiresHumanApproval) {
    return {
      mode: "deterministic",
      reason: "Stored review still requires human approval.",
      context,
      decision: buildDeterministicDecision(
        MastermindAction.NEEDS_HUMAN,
        "The current stored review already requires human approval.",
        [
          "Mastermind routes accepted reviews that still require human approval to NEEDS_HUMAN.",
          ...context.blockingReasons,
        ],
      ),
    };
  }

  const humanItems = listReviewItemsByOwner(context, ReviewOpenItemOwner.HUMAN);
  if (humanItems.length > 0) {
    return {
      mode: "deterministic",
      reason: "Stored review contains human-owned open items.",
      context,
      decision: buildDeterministicDecision(
        MastermindAction.NEEDS_HUMAN,
        "Human-owned review questions must be resolved before implementation planning.",
        [
          "Mastermind routes HUMAN review open items to NEEDS_HUMAN deterministically.",
          ...humanItems,
        ],
      ),
    };
  }

  const externalDependencyItems = listReviewItemsByOwner(
    context,
    ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
  );
  if (canRouteReviewToWait(context)) {
    return {
      mode: "deterministic",
      reason: "Stored review is blocked only by known external dependencies.",
      context,
      decision: buildDeterministicDecision(
        MastermindAction.WAIT,
        "Known external dependencies must resolve before bounded implementation can start.",
        [
          "Mastermind routes external dependencies to WAIT without treating them as executor preflight.",
          ...externalDependencyItems,
        ],
      ),
    };
  }

  return {
    mode: "llm",
    context,
  };
}

function emptyReviewDecisionContext(hasCurrentReview: boolean): MastermindReviewDecisionContext {
  return {
    hasCurrentReview,
    requiresHumanApproval: false,
    blockingReasons: [],
    warnings: [],
    unansweredQuestions: [],
    openItemDispositions: [],
  };
}

function buildDeterministicDecision(
  action: MastermindAction,
  rationale: string,
  policyEvidence: string[],
): MastermindNextActionDecision {
  return {
    action,
    rationale,
    prerequisites: [],
    policyEvidence,
    suggestedExecutorShape: null,
    confidence: 1,
  };
}

function validateRecommendedAction(
  context: MastermindReviewDecisionContext,
  decision: MastermindNextActionDecision,
): RecommendedActionValidation {
  const originalAction = decision.action as MastermindAction;

  if (!context.hasCurrentReview && originalAction !== MastermindAction.REVIEW_TICKET) {
    return {
      action: MastermindAction.REVIEW_TICKET,
      override: {
        originalAction,
        overriddenAction: MastermindAction.REVIEW_TICKET,
        reason: "Mastermind cannot plan implementation before a current review exists.",
      },
    };
  }

  if (context.requiresHumanApproval) {
    return {
      action: MastermindAction.NEEDS_HUMAN,
      override: {
        originalAction,
        overriddenAction: MastermindAction.NEEDS_HUMAN,
        reason:
          "Implementation cannot start while the current review still requires human approval.",
      },
    };
  }

  const humanItems = listReviewItemsByOwner(context, ReviewOpenItemOwner.HUMAN);
  if (humanItems.length > 0) {
    return {
      action: MastermindAction.NEEDS_HUMAN,
      override: {
        originalAction,
        overriddenAction: MastermindAction.NEEDS_HUMAN,
        reason: "Implementation recommendations cannot ignore HUMAN review open items.",
      },
    };
  }

  const waitEligible = canRouteReviewToWait(context);
  if (originalAction === MastermindAction.WAIT && !waitEligible) {
    return {
      action: MastermindAction.NEEDS_HUMAN,
      override: {
        originalAction,
        overriddenAction: MastermindAction.NEEDS_HUMAN,
        reason:
          "WAIT is only valid for blocked reviews whose remaining open items are all EXTERNAL_DEPENDENCY.",
      },
    };
  }
  if (waitEligible && originalAction !== MastermindAction.WAIT) {
    return {
      action: MastermindAction.WAIT,
      override: {
        originalAction,
        overriddenAction: MastermindAction.WAIT,
        reason:
          "Blocked reviews with only EXTERNAL_DEPENDENCY items must wait for the external prerequisite.",
      },
    };
  }
  if (
    context.readiness === ReviewReadiness.BLOCKED &&
    !waitEligible &&
    originalAction !== MastermindAction.NEEDS_HUMAN
  ) {
    return {
      action: MastermindAction.NEEDS_HUMAN,
      override: {
        originalAction,
        overriddenAction: MastermindAction.NEEDS_HUMAN,
        reason:
          "Blocked reviews may only route to WAIT for EXTERNAL_DEPENDENCY items; other blocked reviews require human follow-up.",
      },
    };
  }

  if (
    originalAction !== MastermindAction.IMPLEMENT_DIRECTLY &&
    originalAction !== MastermindAction.DELEGATE_SUBMIND
  ) {
    return { action: originalAction };
  }

  const missingExecutorPreflightItems = listReviewItemsByOwner(
    context,
    ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
    ReviewOpenItemKind.UNANSWERED_QUESTION,
  ).filter(
    (item) => !decision.prerequisites.some((prerequisite) => prerequisite.trim() === item.trim()),
  );
  if (missingExecutorPreflightItems.length > 0) {
    return {
      action: MastermindAction.NEEDS_HUMAN,
      override: {
        originalAction,
        overriddenAction: MastermindAction.NEEDS_HUMAN,
        reason:
          "Implementation recommendations must preserve every EXECUTOR_PREFLIGHT item as a prerequisite.",
        missingExecutorPreflightItems,
      },
    };
  }

  return { action: originalAction };
}

function listReviewItemsByOwner(
  context: MastermindReviewDecisionContext,
  owner: ReviewOpenItemOwner,
  kind?: ReviewOpenItemKind,
): string[] {
  return context.openItemDispositions
    .filter(
      (disposition) =>
        disposition.owner === owner && (kind === undefined || disposition.kind === kind),
    )
    .map((disposition) => disposition.text.trim());
}

function canRouteReviewToWait(context: MastermindReviewDecisionContext): boolean {
  if (context.readiness !== ReviewReadiness.BLOCKED || context.requiresHumanApproval) {
    return false;
  }
  const externalDependencyItems = listReviewItemsByOwner(
    context,
    ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
  );
  return (
    externalDependencyItems.length > 0 &&
    context.openItemDispositions.length === externalDependencyItems.length
  );
}

export function createLeaseHeartbeat(args: {
  store: MastermindStore;
  workId: string;
  owner: string;
  durationMs: number;
  rootSpan: Pick<Span, "addEvent" | "setAttribute">;
}): LeaseHeartbeat {
  const intervalMs = Math.max(10, Math.floor(args.durationMs / 4));
  const telemetry = createLeaseTelemetryAccumulator({
    span: args.rootSpan,
    workId: args.workId,
    durationMs: args.durationMs,
    intervalMs,
  });
  let failure: Error | undefined;
  let renewal = Promise.resolve();
  let stopping = false;
  const enqueueRenewal = (): Promise<void> => {
    if (stopping || failure) {
      return renewal;
    }
    renewal = renewal.then(async () => {
      if (stopping || failure) {
        return;
      }
      const renewedAt = new Date();
      try {
        if (!(await args.store.renewLease(args.workId, args.owner, renewedAt, args.durationMs))) {
          telemetry.recordLost();
          failure = new Error(`Mastermind lease lost for work item ${args.workId}.`);
          return;
        }
        telemetry.recordSuccess(renewedAt);
      } catch (error) {
        failure =
          error instanceof Error
            ? error
            : new Error(`Mastermind lease renewal failed for work item ${args.workId}.`);
        telemetry.recordError(failure);
      }
    });
    return renewal;
  };
  const timer = setInterval(() => {
    void enqueueRenewal();
  }, intervalMs);
  timer.unref?.();
  return {
    async assertActive() {
      await enqueueRenewal();
      if (failure) {
        throw failure;
      }
    },
    async stop() {
      stopping = true;
      clearInterval(timer);
      await renewal;
      if (!failure) {
        telemetry.finish();
      }
    },
  };
}
