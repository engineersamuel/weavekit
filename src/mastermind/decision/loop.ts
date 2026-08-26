import type { Span } from "@opentelemetry/api";
import type { WeavekitConfig } from "../../config.js";
import {
  ReviewOpenItemKind,
  ReviewOpenItemOwner,
  ReviewReadiness,
  type MastermindNextActionDecision,
  type MastermindReviewDecisionContext,
} from "../../generated/baml_client/index.js";
import {
  resolveMastermindProjectPolicy,
  resolveMastermindProjectPolicyForProject,
  type ResolvedMastermindProjectPolicy,
} from "../config.js";
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
import {
  MASTERMIND_COMMENT_MARKER_PREFIX,
  findHumanClarificationChange,
  findReviewedHumanCommentChange,
  postClarificationComment,
  toReviewedHumanComment,
  withRecentHumanComments,
  type HumanClarificationChange,
} from "../review/clarification.js";
import type { TicketReviewHarness } from "../review/harness.js";
import { getStoredReviewRegenerationReason, hashLinearTicketContent } from "../review/policy.js";
import { resolveReviewedExecutionProject } from "../projectResolution.js";
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

type ReviewFreshnessContext = {
  ticket: LinearTicketSnapshot;
  review?: StoredReview;
  expectedLabelPresent: boolean;
  latestObservedSnapshot?: LinearTicketSnapshot;
  contentIsFresh: boolean;
  humanClarificationChange?: HumanClarificationChange;
  reviewDispositionGapReason: string | null;
  expectedLabelName: string;
};

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
        () => this.reopenReviewIfStale(normalizedWork, lease),
      );
      if (await this.store.getCurrentExecutionAttempt(work.id)) {
        return;
      }
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
        work = await this.decide(work, lease);
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

  private async reopenReviewIfStale(
    work: MastermindWorkItem,
    lease: LeaseHeartbeat,
  ): Promise<MastermindWorkItem> {
    if (!isTerminalReviewState(work.state)) return work;
    const context = await this.loadReviewFreshnessContext(work);
    if (work.state === MastermindState.FAILED && context.review === undefined) {
      return this.handleFailedWorkWithoutReview(work, context, lease);
    }
    if (isCurrentTerminalReview(context)) {
      await this.keepCurrentTerminalReview(work, context, lease);
      return work;
    }
    return this.reopenStaleTerminalReview(work, context, lease);
  }

  private async loadReviewFreshnessContext(
    work: MastermindWorkItem,
  ): Promise<ReviewFreshnessContext> {
    const ticket = await this.linear.fetchIssue(work.issueId);
    const review = await this.store.getLatestReview(work.id);
    const expectedLabelId = expectedLabelIdForState(this.config, work.state);
    const expectedLabelPresent = ticket.labels.some((label) => label.id === expectedLabelId);
    const latestObservedSnapshot =
      review?.appliedSnapshot ??
      (work.state === MastermindState.FAILED
        ? await this.store.getLatestTicketSnapshot(work.id)
        : undefined);
    const contentIsFresh = review
      ? appliedReviewMatchesTicket(review, ticket, this.config)
      : latestObservedSnapshot !== undefined &&
        hashLinearTicketContent(latestObservedSnapshot) === hashLinearTicketContent(ticket);
    const humanClarificationChange = await this.findReviewCommentChange(work, review);
    const reviewDispositionGapReason = review ? getStoredReviewRegenerationReason(review) : null;
    return {
      ticket,
      review,
      expectedLabelPresent,
      latestObservedSnapshot,
      contentIsFresh,
      humanClarificationChange,
      reviewDispositionGapReason,
      expectedLabelName: expectedLabelNameForState(this.config, work.state),
    };
  }

  private async findReviewCommentChange(
    work: MastermindWorkItem,
    review: StoredReview | undefined,
  ): Promise<HumanClarificationChange | undefined> {
    if (!this.linear.listIssueComments) return undefined;
    const comments = await this.linear.listIssueComments(work.issueId);
    if (work.state === MastermindState.NEEDS_HUMAN) {
      return findHumanClarificationChange(
        comments,
        work.id,
        review?.reviewedHumanComments,
        review?.reviewedHumanCommentIds,
      );
    }
    if (work.state !== MastermindState.ACTION_PLANNED || !review) return undefined;
    return findReviewedHumanCommentChange(
      comments,
      review.reviewedHumanComments,
      review.reviewedHumanCommentIds,
    );
  }

  private async handleFailedWorkWithoutReview(
    work: MastermindWorkItem,
    context: ReviewFreshnessContext,
    lease: LeaseHeartbeat,
  ): Promise<MastermindWorkItem> {
    if (
      context.expectedLabelPresent &&
      (context.latestObservedSnapshot === undefined || context.contentIsFresh)
    ) {
      this.emitProgress(
        formatTicketFreshnessProgress({
          work,
          ticket: context.ticket,
          expectedLabelName: context.expectedLabelName,
          next: nextStepForCurrentReview(work),
        }),
      );
      return work;
    }
    this.emitProgress(
      formatTicketFreshnessProgress({
        work,
        ticket: context.ticket,
        expectedLabelName: context.expectedLabelName,
        next: context.expectedLabelPresent
          ? "Reopen review because the Linear ticket content changed after the last observed failed review attempt; clear Mastermind labels and generate a fresh review."
          : `Reopen review because the expected "${context.expectedLabelName}" label is missing; clear Mastermind labels and generate a fresh review.`,
      }),
    );
    await lease.assertActive();
    await this.clearMastermindLabels(work.issueId);
    return this.applyTransition(work, {
      type: MastermindEventType.REOPEN_REVIEW,
    });
  }

  private async keepCurrentTerminalReview(
    work: MastermindWorkItem,
    context: ReviewFreshnessContext,
    lease: LeaseHeartbeat,
  ): Promise<void> {
    if (work.state === MastermindState.NEEDS_HUMAN && context.review) {
      // Self-healing: ensure the clarification comment exists even for reviews that were
      // resolved before this feature existed, without advancing the reply-freshness baseline.
      await lease.assertActive();
      await postClarificationComment(this.linear, work.issueId, context.review, {
        updateExisting: false,
        assertLease: () => lease.assertActive(),
      });
    }
    this.emitProgress(
      formatTicketFreshnessProgress({
        work,
        ticket: context.ticket,
        expectedLabelName: context.expectedLabelName,
        next: nextStepForCurrentReview(work),
      }),
    );
  }

  private async reopenStaleTerminalReview(
    work: MastermindWorkItem,
    context: ReviewFreshnessContext,
    lease: LeaseHeartbeat,
  ): Promise<MastermindWorkItem> {
    const staleReasons = [
      ...(context.expectedLabelPresent
        ? []
        : [`the expected "${context.expectedLabelName}" label is missing`]),
      ...(context.review === undefined
        ? [`no current stored review exists for the "${context.expectedLabelName}" ticket`]
        : []),
      ...(context.reviewDispositionGapReason ? [context.reviewDispositionGapReason] : []),
      ...(context.review && !context.contentIsFresh
        ? ["the Linear ticket content changed after the stored review was applied"]
        : []),
      ...(context.humanClarificationChange ? [context.humanClarificationChange.reason] : []),
    ];
    this.emitProgress(
      formatTicketFreshnessProgress({
        work,
        ticket: context.ticket,
        expectedLabelName: context.expectedLabelName,
        next: `Reopen review because ${staleReasons.join(" and ")}; ${
          context.review
            ? "invalidate the stored review, clear Mastermind labels, and generate a fresh review."
            : "clear Mastermind labels and generate a fresh review."
        }`,
      }),
    );
    if (context.review) {
      await lease.assertActive();
      await this.store.invalidateReview(
        context.review.id,
        context.reviewDispositionGapReason
          ? `Stored review ${context.review.id} requires regeneration: ${context.reviewDispositionGapReason}.`
          : `Linear issue ${work.issueId} changed after review completion.`,
      );
    }
    await lease.assertActive();
    await this.clearMastermindLabels(work.issueId);
    return this.applyTransition(work, {
      type: MastermindEventType.REOPEN_REVIEW,
    });
  }

  private async clearMastermindLabels(issueId: string): Promise<void> {
    await this.linear.replaceIssueLabels(issueId, {
      remove: [
        this.config.mastermind.reviewedLabelId,
        this.config.mastermind.readyLabelId,
        this.config.mastermind.needsInputLabelId,
        this.config.mastermind.reviewFailedLabelId,
      ],
      add: [],
    });
  }

  private async decide(
    work: MastermindWorkItem,
    lease: LeaseHeartbeat,
  ): Promise<MastermindWorkItem> {
    return withMastermindSpan(
      "mastermind.decide",
      {
        "langfuse.observation.type": "chain",
        "weavekit.mastermind.work_id": work.id,
        "weavekit.mastermind.issue_id": work.issueId,
      },
      async (span) => {
        await this.requireInProgressState(work.issueId);
        const ticket = await this.linear.fetchIssue(work.issueId);
        await this.store.saveTicketSnapshot(work.id, ticket);
        const policy = this.resolveProjectPolicy(work, ticket);
        if (!policy) {
          // Without this the run ends as a bare `state=needs_human` with no planned action and no
          // reason, which reads like a decider judgement rather than missing configuration.
          this.emitProgress(
            `No mastermind.project_mappings entry matches ${ticket.identifier} ` +
              `(team ${ticket.teamId}, Linear project ${ticket.projectId ?? "none"}). ` +
              "Add a mapping for that team/project before rerunning.",
          );
          return this.applyTransition(work, { type: MastermindEventType.REQUIRE_HUMAN });
        }
        if (work.projectPolicyId !== policy.project.id) {
          await this.store.setProjectPolicy(work.id, policy.project.id, work.resolvedProject);
          work = (await this.store.getWork(work.id)) ?? work;
        }
        const hasCurrentReview = hasReviewedLabel(
          ticket,
          this.config.mastermind.reviewedLabelId,
          this.config.mastermind.reviewedLabelName,
        );
        const review = await this.store.getLatestReview(work.id);
        const reopened = await this.reopenChangedReviewBeforeDecision(
          work,
          ticket,
          hasCurrentReview,
          review,
          lease,
        );
        if (reopened) return reopened;
        const reviewDecisionInput = buildReviewDecisionInput({
          hasCurrentReview,
          review,
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
        if (hasCurrentReview && review?.labelApplied) {
          const reopenedAfterDecision = await this.reopenChangedReviewBeforeDecision(
            work,
            await this.linear.fetchIssue(work.issueId),
            true,
            review,
            lease,
          );
          if (reopenedAfterDecision) return reopenedAfterDecision;
        }
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

  private async reopenChangedReviewBeforeDecision(
    work: MastermindWorkItem,
    ticket: LinearTicketSnapshot,
    hasCurrentReview: boolean,
    review: StoredReview | undefined,
    lease: LeaseHeartbeat,
  ): Promise<MastermindWorkItem | undefined> {
    if (!hasCurrentReview || !review?.labelApplied) return undefined;
    const commentChange = this.linear.listIssueComments
      ? findReviewedHumanCommentChange(
          await this.linear.listIssueComments(work.issueId),
          review.reviewedHumanComments,
          review.reviewedHumanCommentIds,
        )
      : undefined;
    if (appliedReviewMatchesTicket(review, ticket, this.config) && !commentChange) return undefined;
    await lease.assertActive();
    await this.store.invalidateReview(
      review.id,
      `Linear issue ${work.issueId} changed before the reviewed decision was planned.`,
    );
    await lease.assertActive();
    await this.clearMastermindLabels(work.issueId);
    return this.applyTransition(work, { type: MastermindEventType.REVIEW });
  }

  private async generateReview(
    work: MastermindWorkItem,
    lease: LeaseHeartbeat,
  ): Promise<MastermindWorkItem> {
    await this.requireInProgressState(work.issueId);
    const ticket = await this.linear.fetchIssue(work.issueId);
    const policy = this.resolveProjectPolicy(work, ticket);
    if (!policy) {
      return this.applyTransition(work, { type: MastermindEventType.FAIL });
    }
    const comments = this.linear.listIssueComments
      ? await this.linear.listIssueComments(work.issueId)
      : [];
    const reviewTicket = withRecentHumanComments(ticket, comments);
    let review: StoredReview;
    try {
      review = await generateReviewProposal({
        workId: work.id,
        ticket,
        reviewTicket,
        project: policy.baml,
        harness: this.reviewHarness,
        decisions: this.decisions,
        store: this.store,
        assertLease: () => lease.assertActive(),
        onProgress: (message) => this.emitProgress(message),
        resolveProject: async (dossier) => {
          const project = resolveReviewedExecutionProject({
            ticket,
            dossier,
            mappedProject: policy.project,
          });
          await this.store.setProjectPolicy(work.id, project.id, project);
          return resolveMastermindProjectPolicyForProject(this.config, project).baml;
        },
        reviewedHumanComments: comments
          .filter((comment) => !comment.body.startsWith(MASTERMIND_COMMENT_MARKER_PREFIX))
          .map(toReviewedHumanComment),
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
          reviewError: describeReviewError(error),
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

  private resolveProjectPolicy(
    work: MastermindWorkItem,
    ticket: LinearTicketSnapshot,
  ): ResolvedMastermindProjectPolicy | undefined {
    return work.resolvedProject
      ? resolveMastermindProjectPolicyForProject(this.config, work.resolvedProject)
      : resolveMastermindProjectPolicy(this.config, ticket);
  }

  private async applyReview(
    work: MastermindWorkItem,
    lease: LeaseHeartbeat,
  ): Promise<MastermindWorkItem> {
    const review = await this.store.getLatestReview(work.id);
    if (!review) {
      return this.applyTransition(
        work,
        { type: MastermindEventType.REVIEW_INVALIDATED },
        { reviewRegenerationReason: "the applying work item has no current review" },
      );
    }
    const regenerationReason = getStoredReviewRegenerationReason(review);
    if (regenerationReason) {
      await lease.assertActive();
      await this.store.invalidateReview(
        review.id,
        `Stored review ${review.id} requires regeneration: ${regenerationReason}.`,
      );
      return this.applyTransition(
        work,
        { type: MastermindEventType.REVIEW_INVALIDATED },
        { reviewId: review.id, reviewRegenerationReason: regenerationReason },
      );
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

  private requireInProgressState(issueId: string): Promise<void> {
    if (!this.linear.setIssueState) {
      throw new Error("Linear gateway does not support workflow-state projection.");
    }
    return this.linear.setIssueState(
      issueId,
      this.config.mastermind.inProgressStateName ?? "In Progress",
    );
  }

  private emitProgress(message: string): void {
    addMastermindProgressEvent(message);
    this.onProgress?.(message);
  }
}

function describeReviewError(error: unknown): string {
  if (error instanceof AggregateError) {
    const nested = error.errors
      .map((inner) => (inner instanceof Error ? inner.message : String(inner)))
      .filter((message) => message.trim().length > 0);
    const summary = error.message?.trim() || "Ticket review failed.";
    return nested.length > 0 ? `${summary}: ${nested.join("; ")}` : summary;
  }
  return error instanceof Error ? error.message : "Unknown ticket review failure.";
}

function isTerminalReviewState(state: MastermindStateValue): boolean {
  return (
    state === MastermindState.ACTION_PLANNED ||
    state === MastermindState.NEEDS_HUMAN ||
    state === MastermindState.FAILED
  );
}

function isCurrentTerminalReview(context: ReviewFreshnessContext): boolean {
  return (
    context.expectedLabelPresent &&
    context.review !== undefined &&
    context.contentIsFresh &&
    !context.reviewDispositionGapReason &&
    !context.humanClarificationChange
  );
}

function appliedReviewMatchesTicket(
  review: StoredReview,
  ticket: LinearTicketSnapshot,
  config: WeavekitConfig,
): boolean {
  const snapshot = review.appliedSnapshot;
  if (!snapshot) return false;
  if (hashLinearTicketContent(snapshot) === hashLinearTicketContent(ticket)) return true;
  if (!review.labelApplied) return false;
  const managedIds = mastermindLabelIds(config);
  if (!ticketMatchesWithoutManagedLabels(ticket, snapshot, new Set(managedIds))) return false;
  const expectedIds = expectedAppliedReviewLabelIds(review, config).sort();
  const currentIds = ticket.labels
    .map((label) => label.id)
    .filter((id) => managedIds.includes(id))
    .sort();
  return (
    currentIds.length === expectedIds.length &&
    currentIds.every((id, index) => id === expectedIds[index])
  );
}

function ticketMatchesWithoutManagedLabels(
  ticket: LinearTicketSnapshot,
  snapshot: LinearTicketSnapshot,
  managedIds: Set<string>,
): boolean {
  const withoutManagedLabels = (value: LinearTicketSnapshot): LinearTicketSnapshot => ({
    ...value,
    labels: value.labels.filter((label) => !managedIds.has(label.id)),
  });
  return (
    hashLinearTicketContent(withoutManagedLabels(ticket)) ===
    hashLinearTicketContent(withoutManagedLabels(snapshot))
  );
}

function expectedAppliedReviewLabelIds(review: StoredReview, config: WeavekitConfig): string[] {
  if (!review.validation?.accepted) return [config.mastermind.reviewFailedLabelId];
  if (review.validation.requiresHumanApproval) return [config.mastermind.needsInputLabelId];
  return [
    config.mastermind.reviewedLabelId,
    ...(review.patch.readiness === ReviewReadiness.READY ? [config.mastermind.readyLabelId] : []),
  ];
}

function mastermindLabelIds(config: WeavekitConfig): string[] {
  return [
    config.mastermind.reviewedLabelId,
    config.mastermind.readyLabelId,
    config.mastermind.needsInputLabelId,
    config.mastermind.reviewFailedLabelId,
  ];
}

function expectedLabelIdForState(config: WeavekitConfig, state: MastermindStateValue): string {
  if (state === MastermindState.ACTION_PLANNED) {
    return config.mastermind.reviewedLabelId;
  }
  if (state === MastermindState.NEEDS_HUMAN) {
    return config.mastermind.needsInputLabelId;
  }
  return config.mastermind.reviewFailedLabelId;
}

function expectedLabelNameForState(config: WeavekitConfig, state: MastermindStateValue): string {
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

  const storedReviewRegenerationReason = getStoredReviewRegenerationReason(review);
  if (storedReviewRegenerationReason) {
    return {
      mode: "deterministic",
      reason: storedReviewRegenerationReason,
      context: emptyReviewDecisionContext(false),
      decision: buildDeterministicDecision(
        MastermindAction.REVIEW_TICKET,
        "Mastermind must regenerate the stored review before planning the next action.",
        [
          "Stored reviews with inconsistent readiness or open-item ownership cannot drive implementation planning.",
          storedReviewRegenerationReason,
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
