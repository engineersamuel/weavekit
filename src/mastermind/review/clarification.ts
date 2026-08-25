import { createHash } from "node:crypto";
import type { LinearGateway, LinearIssueComment } from "../linear/client.js";
import type { LinearTicketSnapshot, ReviewedHumanComment, StoredReview } from "../store/store.js";

// Every comment Mastermind itself posts starts with this prefix so it can distinguish its own
// idempotency markers from genuine human replies when scanning issue comments.
export const MASTERMIND_COMMENT_MARKER_PREFIX = "<!-- weavekit-mastermind";

export function buildClarificationCommentMarker(workId: string): string {
  return `<!-- weavekit-mastermind-clarification:${workId} -->`;
}

/**
 * Renders the human-facing clarification comment body for a review that requires human
 * approval. Lists every open item (blocking reason / unanswered question) with its disposition
 * rationale, plus concrete instructions for how to unblock Mastermind.
 */
export function buildClarificationCommentBody(marker: string, review: StoredReview): string {
  const patch = review.patch;
  const dispositionByText = new Map(
    (patch.openItemDispositions ?? []).map((disposition) => [disposition.text.trim(), disposition]),
  );
  const openItems = [
    ...(patch.blockingReasons ?? []).map((text) => ({ text, defaultKind: "blocking reason" })),
    ...(patch.unansweredQuestions ?? []).map((text) => ({ text, defaultKind: "open question" })),
  ];

  const itemLines =
    openItems.length > 0
      ? openItems.map(({ text, defaultKind }) => {
          const disposition = dispositionByText.get(text.trim());
          const owner = disposition?.owner ?? "HUMAN";
          const rationale = disposition?.rationale;
          return [
            `- **${defaultKind}** (owner: ${owner}): ${text}`,
            rationale ? `  - Why: ${rationale}` : undefined,
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n");
        })
      : [
          "- Mastermind flagged this review as needing human input, but did not record specific open items.",
        ];

  return [
    marker,
    `**Mastermind needs clarification before it can proceed.**`,
    "",
    "Open items:",
    ...itemLines,
    "",
    "To unblock Mastermind, do one of the following:",
    "- Reply to this ticket with the answers/clarifications while this ticket is waiting for input. Mastermind checks for new comments and will automatically start a fresh review on its next run.",
    "- Edit the ticket title or description directly with the missing information; Mastermind detects content changes and re-reviews automatically.",
    "- Remove the `mastermind-needs-input` label to force an immediate fresh review even if nothing else changed.",
    "- If the review is marked failed, edit the ticket title or description or remove the failed-review label; a comment alone does not retry a failed review.",
  ].join("\n");
}

/**
 * Posts (or updates, if already posted) the clarification comment for a work item. Idempotent
 * per work item — repeated calls for regenerated reviews on the same work item update the same
 * comment rather than spamming a new one each time.
 */
export async function postClarificationComment(
  linear: LinearGateway,
  issueId: string,
  review: StoredReview,
  options: {
    updateExisting?: boolean | "if-changed";
    assertLease?: () => Promise<void>;
  } = {},
): Promise<void> {
  if (!linear.findIssueCommentByMarker || !linear.createIssueComment) return;
  const marker = buildClarificationCommentMarker(review.workId);
  const body = buildClarificationCommentBody(marker, review);
  const existingCommentId = await linear.findIssueCommentByMarker(issueId, marker);
  if (existingCommentId) {
    if (options.updateExisting === false || !linear.updateIssueComment) return;
    if (options.updateExisting === "if-changed" && linear.listIssueComments) {
      const existingComment = (await linear.listIssueComments(issueId)).find(
        (comment) => comment.id === existingCommentId,
      );
      if (existingComment?.body === body) return;
    }
    await options.assertLease?.();
    await linear.updateIssueComment(existingCommentId, body);
    return;
  }
  await options.assertLease?.();
  await linear.createIssueComment(issueId, body);
}

/**
 * Returns the most recent comment that looks like a genuine human reply (i.e. not one of
 * Mastermind's own marker comments) created after the clarification comment was last written, or
 * undefined if no such reply exists. Used to detect that a human has answered Mastermind's open
 * questions even when the ticket's title/description/labels are otherwise unchanged.
 */
export type HumanClarificationChange = {
  comment?: LinearIssueComment;
  reason: string;
};

export function toReviewedHumanComment(comment: LinearIssueComment): ReviewedHumanComment {
  const revision = createHash("sha256")
    .update(comment.updatedAt ?? comment.createdAt)
    .update("\0")
    .update(comment.body)
    .digest("hex");
  return { id: comment.id, revision };
}

export function findHumanClarificationChange(
  comments: LinearIssueComment[],
  workId: string,
  reviewedHumanComments?: readonly ReviewedHumanComment[],
  reviewedHumanCommentIds?: readonly string[],
): HumanClarificationChange | undefined {
  const marker = buildClarificationCommentMarker(workId);
  const markerComment = comments.find((comment) => comment.body.includes(marker));
  if (!markerComment) return undefined;
  const markerWrittenAt = markerComment.updatedAt ?? markerComment.createdAt;
  const humanComments = comments.filter(
    (comment) =>
      comment.id !== markerComment.id && !comment.body.startsWith(MASTERMIND_COMMENT_MARKER_PREFIX),
  );
  if (reviewedHumanComments) {
    return findReviewedHumanCommentChange(comments, reviewedHumanComments);
  }
  const reviewedCommentIds = reviewedHumanCommentIds ? new Set(reviewedHumanCommentIds) : undefined;
  const humanReplies = humanComments.filter((comment) =>
    reviewedCommentIds !== undefined
      ? !reviewedCommentIds.has(comment.id)
      : new Date(comment.createdAt).getTime() > new Date(markerWrittenAt).getTime(),
  );
  if (humanReplies.length === 0) return undefined;
  const latest = humanReplies.reduce((currentLatest, candidate) =>
    new Date(candidate.createdAt).getTime() > new Date(currentLatest.createdAt).getTime()
      ? candidate
      : currentLatest,
  );
  return {
    comment: latest,
    reason: `a human posted a clarification reply on ${latest.createdAt} after Mastermind's clarification comment`,
  };
}

export function findReviewedHumanCommentChange(
  comments: LinearIssueComment[],
  reviewedHumanComments?: readonly ReviewedHumanComment[],
  reviewedHumanCommentIds?: readonly string[],
): HumanClarificationChange | undefined {
  const humanComments = comments.filter(
    (comment) => !comment.body.startsWith(MASTERMIND_COMMENT_MARKER_PREFIX),
  );
  if (reviewedHumanComments) {
    return findRevisionBasedHumanChange(humanComments, reviewedHumanComments);
  }
  if (!reviewedHumanCommentIds) return undefined;
  const reviewedIds = new Set(reviewedHumanCommentIds);
  const newComments = humanComments.filter((comment) => !reviewedIds.has(comment.id));
  if (newComments.length === 0) return undefined;
  const latest = latestComment(newComments);
  return {
    comment: latest,
    reason: `a human posted a clarification reply on ${latest.createdAt} after Mastermind captured its review input`,
  };
}

export function findLatestHumanClarificationReply(
  comments: LinearIssueComment[],
  workId: string,
  reviewedHumanCommentIds?: readonly string[],
): LinearIssueComment | undefined {
  return findHumanClarificationChange(comments, workId, undefined, reviewedHumanCommentIds)
    ?.comment;
}

function findRevisionBasedHumanChange(
  humanComments: LinearIssueComment[],
  reviewedHumanComments: readonly ReviewedHumanComment[],
): HumanClarificationChange | undefined {
  const reviewedById = new Map(
    reviewedHumanComments.map((comment) => [comment.id, comment.revision]),
  );
  const changedComments = humanComments.filter(
    (comment) => reviewedById.get(comment.id) !== toReviewedHumanComment(comment).revision,
  );
  if (changedComments.length > 0) {
    const latest = latestComment(changedComments);
    return {
      comment: latest,
      reason: reviewedById.has(latest.id)
        ? `human clarification comment ${latest.id} changed after Mastermind reviewed it`
        : `a human posted a clarification reply on ${latest.createdAt} after Mastermind's clarification comment`,
    };
  }
  const currentIds = new Set(humanComments.map((comment) => comment.id));
  const deleted = reviewedHumanComments.find((comment) => !currentIds.has(comment.id));
  return deleted
    ? {
        reason: `human clarification comment ${deleted.id} was deleted after Mastermind reviewed it`,
      }
    : undefined;
}

function latestComment(comments: LinearIssueComment[]): LinearIssueComment {
  return comments.reduce((currentLatest, candidate) =>
    new Date(candidate.createdAt).getTime() > new Date(currentLatest.createdAt).getTime()
      ? candidate
      : currentLatest,
  );
}

/**
 * Returns a copy of the ticket snapshot with recent human comment replies appended to the
 * description, so the review harness/BAML calls can see clarification the human posted as a
 * Linear comment rather than by editing the ticket itself. Does not mutate the original snapshot
 * and is not used when writing content back to Linear (only for what Mastermind reads).
 */
export function withRecentHumanComments(
  ticket: LinearTicketSnapshot,
  comments: LinearIssueComment[],
): LinearTicketSnapshot {
  const humanComments = comments
    .filter((comment) => !comment.body.startsWith(MASTERMIND_COMMENT_MARKER_PREFIX))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(-10);
  if (humanComments.length === 0) return ticket;
  const commentsBlock = humanComments
    .map((comment) => `- (${comment.createdAt}) ${comment.body}`)
    .join("\n");
  return {
    ...ticket,
    description: [
      ticket.description,
      "",
      "---",
      "Recent Linear comments (for context; not part of the ticket description itself):",
      commentsBlock,
    ].join("\n"),
  };
}
