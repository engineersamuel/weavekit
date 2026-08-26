import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WeavekitConfig } from "../../config.js";
import {
  PostImplementationReviewVerdict,
  type PostImplementationReview,
  type PostImplementationReviewDossier,
} from "../../generated/baml_client/index.js";
import type { RlmStoryboardRasterizer } from "../../rlm-poc/visualization/contracts.js";
import { ExecutorKind } from "../../submind/contracts.js";
import { toBamlTicket } from "../actions/reviewTicket.js";
import type { MastermindDecisionProvider } from "../decision/bamlAdapters.js";
import { MastermindEventType, MastermindState } from "../domain/events.js";
import { transitionMastermindState } from "../domain/machine.js";
import type { LinearGateway } from "../linear/client.js";
import { hashLinearTicketContent } from "../review/policy.js";
import type {
  ExecutionAttempt,
  LinearTicketSnapshot,
  MastermindStore,
  MastermindWorkItem,
  CodeReviewEli5Publication,
  StoredCodeReview,
  StoredReview,
} from "../store/store.js";
import {
  normalizePostImplementationReviewEli5,
  renderPostImplementationReviewEli5Markdown,
  writePostImplementationReviewEli5Artifact,
} from "./eli5.js";
import type { CodeReviewHarness } from "./harness.js";
import { reviewWorktreePath } from "./harness.js";

const execFileAsync = promisify(execFile);

export class PostImplementationReviewCoordinator {
  constructor(
    private readonly config: WeavekitConfig,
    private readonly store: MastermindStore,
    private readonly linear: LinearGateway,
    private readonly harness: CodeReviewHarness,
    private readonly decisions: MastermindDecisionProvider,
    private readonly eli5Rasterizer?: RlmStoryboardRasterizer,
  ) {}

  async process(work: MastermindWorkItem, attempt: ExecutionAttempt, owner: string): Promise<void> {
    if (attempt.state !== MastermindState.SUCCEEDED || !attempt.projection?.projectedAt) return;
    switch (work.state) {
      case MastermindState.SUCCEEDED:
        await this.beginReview(work, owner);
        break;
      case MastermindState.CODE_REVIEW_PENDING:
        await this.startReview(work, attempt, owner);
        break;
      case MastermindState.CODE_REVIEWING:
        await this.continueReview(work, attempt, owner);
        break;
    }
  }

  private async beginReview(work: MastermindWorkItem, owner: string): Promise<void> {
    await this.requireLinearState(
      work.issueId,
      this.config.mastermind.inReviewStateName ?? "In Review",
    );
    await this.replaceLabels(work.issueId, {
      remove: [this.config.mastermind.readyLabelId],
      add: [this.config.mastermind.codeReviewLabelId ?? ""],
    });
    await this.transition(work, owner, MastermindEventType.BEGIN_CODE_REVIEW);
  }

  private async startReview(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    owner: string,
  ): Promise<void> {
    const review = await this.ensureReview(work, attempt);
    await this.store.saveCodeReview({ review, status: "running" });
    await this.transition(work, owner, MastermindEventType.CODE_REVIEW_STARTED);
  }

  private async continueReview(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    owner: string,
  ): Promise<void> {
    const review = await this.ensureReview(work, attempt);
    if (review.status !== "running") {
      await this.resumeCompletedReview(work, attempt, review, owner);
      return;
    }
    await this.runReview(work, attempt, review, owner);
  }

  private async resumeCompletedReview(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    review: StoredCodeReview,
    owner: string,
  ): Promise<void> {
    const eventType = eventForReviewStatus(review.status);
    if (!eventType) {
      throw new Error(`Code review ${review.id} is not running.`);
    }
    if (review.review && review.projection?.disposition !== "applied") {
      await this.project(work, attempt, review);
    }
    await this.transition(work, owner, eventType);
  }

  private async runReview(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    review: StoredCodeReview,
    owner: string,
  ): Promise<void> {
    const ticket = await this.store.getLatestTicketSnapshot(work.id);
    const ticketReview = await this.store.getLatestReview(work.id);
    if (!ticket || !ticketReview) throw new Error("Code review context is incomplete.");
    let assessment;
    try {
      assessment = await this.assessReview(ticket, ticketReview, attempt);
    } catch (error) {
      const failed = await this.store.saveCodeReview({ review, status: "needs_human" });
      await this.projectFailure(work, failed, error);
      await this.transition(work, owner, MastermindEventType.CODE_REVIEW_NEEDS_HUMAN);
      return;
    }
    const outcome = outcomeForVerdict(assessment.result.verdict);
    const saved = await this.store.saveCodeReview({
      review,
      status: outcome.status,
      dossier: assessment.dossier,
      result: assessment.result,
    });
    await this.project(work, attempt, saved);
    await this.transition(work, owner, outcome.eventType);
  }

  private async assessReview(
    ticket: LinearTicketSnapshot,
    ticketReview: StoredReview,
    attempt: ExecutionAttempt,
  ): Promise<{
    dossier: PostImplementationReviewDossier;
    result: PostImplementationReview;
  }> {
    const observed = await this.harness.review({
      ticket: toBamlTicket(ticket),
      ticketReview,
      attempt,
      ...(ticket.attachments ? { attachments: ticket.attachments } : {}),
    });
    // The ticket kind is settled at readiness review; the code reviewer must not re-litigate it.
    // Overriding here also means a harness that omits or invents the field cannot change it.
    const dossier = { ...observed, ticketKind: ticketReview.dossier.ticketKind };
    if (!this.decisions.assessPostImplementationReview) {
      throw new Error("Decision provider does not support post-implementation review.");
    }
    const result = await this.decisions.assessPostImplementationReview(
      toBamlTicket(ticket),
      dossier,
    );
    return { dossier, result };
  }

  private async ensureReview(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
  ): Promise<StoredCodeReview> {
    const existing = await this.store.getCurrentCodeReview(work.id);
    const identity = await this.identity(work, attempt);
    if (
      existing &&
      existing.executionAttemptId === attempt.id &&
      existing.commitSha === identity.commitSha &&
      existing.resultHash === identity.resultHash &&
      existing.ticketHash === identity.ticketHash
    ) {
      return existing;
    }
    return this.store.createCodeReview({
      workId: work.id,
      executionAttemptId: attempt.id,
      ...identity,
    });
  }

  private async identity(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
  ): Promise<{ commitSha: string; resultHash: string; ticketHash: string }> {
    const cwd = attempt.executorHandle?.worktreePath ?? attempt.workspace?.checkoutPath;
    if (!cwd || !attempt.result) throw new Error("Successful attempt lacks review identity.");
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    const ticket = await this.store.getLatestTicketSnapshot(work.id);
    if (!ticket) throw new Error("Code review ticket snapshot is missing.");
    return {
      commitSha: stdout.trim(),
      resultHash: hashJson(attempt.result),
      ticketHash: hashLinearTicketContent(ticket),
    };
  }

  private async project(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    review: StoredCodeReview,
  ): Promise<void> {
    if (!review.review || review.projection?.disposition === "applied") return;
    const comments = this.requireCommentGateway();
    const marker = `<!-- weavekit-mastermind-code-review:${review.id} -->`;
    let commentId = await comments.find(work.issueId, marker);
    if (!commentId) {
      const ticket = await this.store.getLatestTicketSnapshot(work.id);
      review = await this.ensureEli5Publication(
        work,
        attempt,
        review,
        ticket?.title ?? "Mastermind review",
      );
      commentId = await comments.create(
        work.issueId,
        codeReviewComment(review, attempt, marker, ticket?.title ?? "Mastermind review"),
      );
    }
    await this.projectReviewLabels(work.issueId, review.status);
    await this.store.saveCodeReview({
      review,
      status: review.status,
      projection: {
        ...review.projection,
        disposition: "applied",
        externalId: commentId,
        projectedAt: new Date().toISOString(),
      },
    });
  }

  private async projectReviewLabels(
    issueId: string,
    status: StoredCodeReview["status"],
  ): Promise<void> {
    const label = labelForReviewStatus(status, this.config);
    await this.replaceLabels(issueId, {
      // needsInputLabelId is removed here as well as added below: projectFailure() applies it when
      // a review attempt errors, and a later attempt that passes must clear it. replaceIssueLabels
      // applies `remove` before appending `add`, so the needs_human branch still ends up labelled.
      remove: [
        this.config.mastermind.codeReviewLabelId ?? "",
        this.config.mastermind.codeReviewPassedLabelId ?? "",
        this.config.mastermind.changesRequestedLabelId ?? "",
        this.config.mastermind.needsInputLabelId,
      ],
      add: [label],
    });
  }

  private requireCommentGateway(): CodeReviewCommentGateway {
    const find = this.linear.findIssueCommentByMarker?.bind(this.linear);
    const create = this.linear.createIssueComment?.bind(this.linear);
    if (!find || !create) {
      throw new Error("Linear gateway does not support code-review comments.");
    }
    return { find, create };
  }

  private async ensureEli5Publication(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    review: StoredCodeReview,
    ticketTitle: string,
  ): Promise<StoredCodeReview> {
    if (
      attempt.executorKind !== ExecutorKind.RLM_SUBMIND ||
      review.projection?.eli5 ||
      !review.review
    ) {
      return review;
    }
    const eli5 = normalizePostImplementationReviewEli5(review.review.eli5, review.review.verdict);
    if (!eli5) return review;
    const publication: CodeReviewEli5Publication = { failures: [] };
    const worktreePath = reviewWorktreePath(attempt);
    if (!worktreePath) {
      publication.failures.push("The review worktree path is unavailable.");
    } else {
      try {
        const artifact = await writePostImplementationReviewEli5Artifact(
          {
            worktreePath,
            reviewId: review.id,
            ticketTitle,
            verdict: review.review.verdict,
            eli5,
          },
          this.eli5Rasterizer,
        );
        publication.svgPath = artifact.svgPath;
        publication.pngPath = artifact.pngPath;
        if (this.linear.uploadIssueAttachment) {
          const uploaded = await this.linear.uploadIssueAttachment({
            issueId: work.issueId,
            fileName: `mastermind-eli5-attempt-${attempt.attemptNumber}.png`,
            contentType: "image/png",
            title: `ELI5 review summary (attempt ${attempt.attemptNumber})`,
            data: artifact.png,
          });
          publication.pngUrl = uploaded.assetUrl;
        }
      } catch (error) {
        publication.failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    return this.store.saveCodeReview({
      review,
      status: review.status,
      projection: {
        disposition: "pending",
        eli5: publication,
      },
    });
  }

  private async projectFailure(
    work: MastermindWorkItem,
    review: StoredCodeReview,
    error: unknown,
  ): Promise<void> {
    if (!this.linear.findIssueCommentByMarker || !this.linear.createIssueComment) {
      throw new Error("Linear gateway does not support code-review comments.");
    }
    const marker = `<!-- weavekit-mastermind-code-review:${review.id} -->`;
    let commentId = await this.linear.findIssueCommentByMarker(work.issueId, marker);
    if (!commentId) {
      const detail = error instanceof Error ? error.message : String(error);
      commentId = await this.linear.createIssueComment(
        work.issueId,
        `${marker}\nMastermind post-code review requires human attention.\n\n${detail}`,
      );
    }
    await this.replaceLabels(work.issueId, {
      remove: [this.config.mastermind.codeReviewLabelId ?? ""],
      add: [this.config.mastermind.needsInputLabelId],
    });
    await this.store.saveCodeReview({
      review,
      status: review.status,
      projection: {
        disposition: "applied",
        externalId: commentId,
        projectedAt: new Date().toISOString(),
      },
    });
  }

  private transition(
    work: MastermindWorkItem,
    owner: string,
    eventType: string,
  ): Promise<MastermindWorkItem> {
    const nextState = transitionMastermindState(work.state, { type: eventType } as never);
    return this.store.transition(work, owner, {
      eventType,
      priorState: work.state,
      nextState,
    });
  }

  private requireLinearState(issueId: string, stateName: string): Promise<void> {
    if (!this.linear.setIssueState) {
      throw new Error("Linear gateway does not support workflow-state projection.");
    }
    return this.linear.setIssueState(issueId, stateName);
  }

  private replaceLabels(
    issueId: string,
    input: { remove: string[]; add: string[] },
  ): Promise<void> {
    return this.linear.replaceIssueLabels(issueId, {
      remove: input.remove.filter(Boolean),
      add: input.add.filter(Boolean),
    });
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type CodeReviewCommentGateway = {
  find(issueId: string, marker: string): Promise<string | undefined>;
  create(issueId: string, body: string): Promise<string>;
};

function outcomeForVerdict(verdict: PostImplementationReviewVerdict): {
  status: "passed" | "changes_requested" | "needs_human";
  eventType: string;
} {
  switch (verdict) {
    case PostImplementationReviewVerdict.PASS:
      return { status: "passed", eventType: MastermindEventType.CODE_REVIEW_PASSED };
    case PostImplementationReviewVerdict.CHANGES_REQUIRED:
      return {
        status: "changes_requested",
        eventType: MastermindEventType.CODE_CHANGES_REQUESTED,
      };
    case PostImplementationReviewVerdict.NEEDS_HUMAN:
      return {
        status: "needs_human",
        eventType: MastermindEventType.CODE_REVIEW_NEEDS_HUMAN,
      };
  }
}

function labelForReviewStatus(status: StoredCodeReview["status"], config: WeavekitConfig): string {
  switch (status) {
    case "passed":
      return config.mastermind.codeReviewPassedLabelId ?? "";
    case "changes_requested":
      return config.mastermind.changesRequestedLabelId ?? "";
    case "needs_human":
      return config.mastermind.needsInputLabelId;
    default:
      throw new Error(`Code review status ${status} cannot be projected.`);
  }
}

function eventForReviewStatus(status: StoredCodeReview["status"]): string | undefined {
  switch (status) {
    case "passed":
      return MastermindEventType.CODE_REVIEW_PASSED;
    case "changes_requested":
      return MastermindEventType.CODE_CHANGES_REQUESTED;
    case "needs_human":
      return MastermindEventType.CODE_REVIEW_NEEDS_HUMAN;
    default:
      return undefined;
  }
}

function codeReviewComment(
  review: StoredCodeReview,
  attempt: ExecutionAttempt,
  marker: string,
  ticketTitle: string,
): string {
  const result = review.review!;
  const worktree = reviewWorktreePath(attempt);
  const eli5 =
    attempt.executorKind === ExecutorKind.RLM_SUBMIND
      ? normalizePostImplementationReviewEli5(result.eli5, result.verdict)
      : undefined;
  const manualSteps = [
    ...(worktree ? [`Change to the review worktree root: \`cd ${worktree}\``] : []),
    ...result.manualVerification,
  ];
  return [
    marker,
    `Mastermind post-code review for execution attempt ${attempt.attemptNumber}: **${result.verdict}**`,
    ...(eli5
      ? [
          "",
          ...renderPostImplementationReviewEli5Markdown(eli5, {
            ticketTitle,
            ...(review.projection?.eli5?.pngUrl ? { pngUrl: review.projection.eli5.pngUrl } : {}),
            visualFailed: (review.projection?.eli5?.failures.length ?? 0) > 0,
          }),
          "",
          "## Technical review",
        ]
      : []),
    "",
    result.summary,
    "",
    "Acceptance criteria coverage:",
    ...result.acceptanceCriteriaCoverage.map((entry) => `- ${entry}`),
    "",
    "Findings:",
    ...(result.findings.length
      ? result.findings.map(
          (finding) =>
            `- **${finding.severity}** ${finding.summary}${finding.evidence.length ? ` — ${finding.evidence.join("; ")}` : ""}`,
        )
      : ["- None."]),
    "",
    "Manual verification — run these steps in order:",
    ...(manualSteps.length
      ? manualSteps.map((entry, index) => `${index + 1}. ${entry}`)
      : ["- None."]),
  ].join("\n");
}
