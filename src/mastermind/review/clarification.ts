import type { LinearGateway, LinearIssueComment } from "../linear/client.js";
import type { LinearTicketSnapshot, StoredReview } from "../store/store.js";

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
    "- Reply to this ticket with the answers/clarifications. Mastermind checks for new comments and will automatically start a fresh review on its next run.",
    "- Edit the ticket title or description directly with the missing information; Mastermind detects content changes and re-reviews automatically.",
    "- Remove the `mastermind-needs-input` label to force an immediate fresh review even if nothing else changed.",
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
): Promise<void> {
  if (!linear.findIssueCommentByMarker || !linear.createIssueComment) return;
  const marker = buildClarificationCommentMarker(review.workId);
  const body = buildClarificationCommentBody(marker, review);
  const existingCommentId = await linear.findIssueCommentByMarker(issueId, marker);
  if (existingCommentId) {
    if (linear.updateIssueComment) {
      await linear.updateIssueComment(existingCommentId, body);
    }
    return;
  }
  await linear.createIssueComment(issueId, body);
}

/**
 * Returns the most recent comment that looks like a genuine human reply (i.e. not one of
 * Mastermind's own marker comments) created after the clarification comment was posted, or
 * undefined if no such reply exists. Used to detect that a human has answered Mastermind's
 * open questions even when the ticket's title/description/labels are otherwise unchanged.
 */
export function findLatestHumanClarificationReply(
  comments: LinearIssueComment[],
  workId: string,
): LinearIssueComment | undefined {
  const marker = buildClarificationCommentMarker(workId);
  const markerComment = comments.find((comment) => comment.body.includes(marker));
  if (!markerComment) return undefined;
  const humanReplies = comments.filter(
    (comment) =>
      comment.id !== markerComment.id &&
      !comment.body.startsWith(MASTERMIND_COMMENT_MARKER_PREFIX) &&
      new Date(comment.createdAt).getTime() > new Date(markerComment.createdAt).getTime(),
  );
  if (humanReplies.length === 0) return undefined;
  return humanReplies.reduce((latest, candidate) =>
    new Date(candidate.createdAt).getTime() > new Date(latest.createdAt).getTime()
      ? candidate
      : latest,
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
