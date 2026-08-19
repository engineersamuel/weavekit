import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WeavekitConfig } from "../../config.js";
import { PostImplementationReviewVerdict } from "../../generated/baml_client/index.js";
import { toBamlTicket } from "../actions/reviewTicket.js";
import type { MastermindDecisionProvider } from "../decision/bamlAdapters.js";
import { MastermindEventType, MastermindState } from "../domain/events.js";
import { transitionMastermindState } from "../domain/machine.js";
import type { LinearGateway } from "../linear/client.js";
import { hashLinearTicketContent } from "../review/policy.js";
import type {
  ExecutionAttempt,
  MastermindStore,
  MastermindWorkItem,
  StoredCodeReview,
} from "../store/store.js";
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
  ) {}

  async process(work: MastermindWorkItem, attempt: ExecutionAttempt, owner: string): Promise<void> {
    if (attempt.state !== MastermindState.SUCCEEDED || !attempt.projection?.projectedAt) return;
    if (work.state === MastermindState.SUCCEEDED) {
      await this.requireLinearState(
        work.issueId,
        this.config.mastermind.inReviewStateName ?? "In Review",
      );
      await this.replaceLabels(work.issueId, {
        remove: [this.config.mastermind.readyLabelId],
        add: [this.config.mastermind.codeReviewLabelId ?? ""],
      });
      await this.transition(work, owner, MastermindEventType.BEGIN_CODE_REVIEW);
      return;
    }
    if (work.state === MastermindState.CODE_REVIEW_PENDING) {
      const review = await this.ensureReview(work, attempt);
      await this.store.saveCodeReview({ review, status: "running" });
      await this.transition(work, owner, MastermindEventType.CODE_REVIEW_STARTED);
      return;
    }
    if (work.state !== MastermindState.CODE_REVIEWING) return;
    let review = await this.ensureReview(work, attempt);
    if (review.status !== "running") {
      const eventType = eventForReviewStatus(review.status);
      if (!eventType) {
        throw new Error(`Code review ${review.id} is not running.`);
      }
      if (review.review && review.projection?.disposition !== "applied") {
        await this.project(work, attempt, review);
      }
      await this.transition(work, owner, eventType);
      return;
    }
    const ticket = await this.store.getLatestTicketSnapshot(work.id);
    const ticketReview = await this.store.getLatestReview(work.id);
    if (!ticket || !ticketReview) throw new Error("Code review context is incomplete.");
    let dossier;
    let result;
    try {
      dossier = await this.harness.review({
        ticket: toBamlTicket(ticket),
        ticketReview,
        attempt,
      });
      if (!this.decisions.assessPostImplementationReview) {
        throw new Error("Decision provider does not support post-implementation review.");
      }
      result = await this.decisions.assessPostImplementationReview(toBamlTicket(ticket), dossier);
    } catch (error) {
      review = await this.store.saveCodeReview({ review, status: "needs_human" });
      await this.projectFailure(work, review, error);
      await this.transition(work, owner, MastermindEventType.CODE_REVIEW_NEEDS_HUMAN);
      return;
    }
    const status =
      result.verdict === PostImplementationReviewVerdict.PASS
        ? "passed"
        : result.verdict === PostImplementationReviewVerdict.CHANGES_REQUIRED
          ? "changes_requested"
          : "needs_human";
    review = await this.store.saveCodeReview({ review, status, dossier, result });
    await this.project(work, attempt, review);
    const eventType =
      result.verdict === PostImplementationReviewVerdict.PASS
        ? MastermindEventType.CODE_REVIEW_PASSED
        : result.verdict === PostImplementationReviewVerdict.CHANGES_REQUIRED
          ? MastermindEventType.CODE_CHANGES_REQUESTED
          : MastermindEventType.CODE_REVIEW_NEEDS_HUMAN;
    await this.transition(work, owner, eventType);
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
    if (!this.linear.findIssueCommentByMarker || !this.linear.createIssueComment) {
      throw new Error("Linear gateway does not support code-review comments.");
    }

    const marker = `<!-- weavekit-mastermind-code-review:${review.id} -->`;
    let commentId = await this.linear.findIssueCommentByMarker(work.issueId, marker);
    if (!commentId) {
      commentId = await this.linear.createIssueComment(
        work.issueId,
        codeReviewComment(review, attempt, marker),
      );
    }
    const passed = review.status === "passed";
    await this.replaceLabels(work.issueId, {
      // needsInputLabelId is removed here as well as added below: projectFailure() applies it when
      // a review attempt errors, and a later attempt that passes must clear it. replaceIssueLabels
      // applies `remove` before appending `add`, so the needs_human branch still ends up labelled.
      remove: [
        this.config.mastermind.codeReviewLabelId ?? "",
        this.config.mastermind.codeReviewPassedLabelId ?? "",
        this.config.mastermind.changesRequestedLabelId ?? "",
        this.config.mastermind.needsInputLabelId,
      ],
      add: [
        passed
          ? (this.config.mastermind.codeReviewPassedLabelId ?? "")
          : review.status === "changes_requested"
            ? (this.config.mastermind.changesRequestedLabelId ?? "")
            : this.config.mastermind.needsInputLabelId,
      ],
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
): string {
  const result = review.review!;
  const worktree = reviewWorktreePath(attempt);
  const manualSteps = [
    ...(worktree ? [`Change to the review worktree root: \`cd ${worktree}\``] : []),
    ...result.manualVerification,
  ];
  return [
    marker,
    `Mastermind post-code review for execution attempt ${attempt.attemptNumber}: **${result.verdict}**`,
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
