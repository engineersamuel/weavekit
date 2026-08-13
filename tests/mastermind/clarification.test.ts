import { describe, expect, it } from "vitest";
import { applyReviewProposal } from "../../src/mastermind/actions/reviewTicket.js";
import {
  buildClarificationCommentBody,
  buildClarificationCommentMarker,
  findLatestHumanClarificationReply,
  postClarificationComment,
  withRecentHumanComments,
} from "../../src/mastermind/review/clarification.js";
import type { LinearGateway, LinearIssueComment } from "../../src/mastermind/linear/client.js";
import type {
  LinearTicketSnapshot,
  MastermindStore,
  StoredReview,
} from "../../src/mastermind/store/store.js";

function createTicketSnapshot(): LinearTicketSnapshot {
  return {
    id: "issue-one",
    identifier: "WK-1",
    url: "https://linear.app/weavekit/issue/WK-1/needs-input",
    title: "Needs clarification",
    description: "Original description.",
    labels: [],
    status: "Todo",
    teamId: "team-one",
    projectId: "project-one",
  };
}

function createStoredReview(): StoredReview {
  const ticket = createTicketSnapshot();
  return {
    id: "review-one",
    workId: "work-one",
    originalSnapshot: ticket,
    originalContentHash: "hash-one",
    // Casting through unknown here — only the fields the clarification helpers actually read
    // (blockingReasons/unansweredQuestions/openItemDispositions) are exercised by these tests.
    dossier: {} as StoredReview["dossier"],
    patch: {
      blockingReasons: ["Which environment should this deploy to?"],
      unansweredQuestions: ["Should we support retries?"],
      openItemDispositions: [
        {
          kind: "BLOCKING_REASON",
          text: "Which environment should this deploy to?",
          owner: "HUMAN",
          rationale: "Only the requester knows the target environment.",
        },
        {
          kind: "UNANSWERED_QUESTION",
          text: "Should we support retries?",
          owner: "HUMAN",
          rationale: "Retry semantics affect the acceptance criteria.",
        },
      ],
    } as unknown as StoredReview["patch"],
    validation: {
      accepted: true,
      requiresHumanApproval: true,
      reasons: ["Human input required."],
    },
    contentApplied: false,
    labelApplied: false,
    invalidated: false,
  };
}

describe("buildClarificationCommentBody", () => {
  it("lists blocking reasons and unanswered questions with owner/rationale and instructions", () => {
    const review = createStoredReview();
    const marker = buildClarificationCommentMarker(review.workId);
    const body = buildClarificationCommentBody(marker, review);

    expect(body).toContain(marker);
    expect(body).toContain("Which environment should this deploy to?");
    expect(body).toContain("Only the requester knows the target environment.");
    expect(body).toContain("Should we support retries?");
    expect(body).toContain("Retry semantics affect the acceptance criteria.");
    expect(body).toContain("Reply to this ticket with the answers");
    expect(body).toContain("mastermind-needs-input");
  });
});

describe("postClarificationComment", () => {
  it("creates a new comment when none exists yet", async () => {
    const created: Array<{ issueId: string; body: string }> = [];
    const linear: Partial<LinearGateway> = {
      findIssueCommentByMarker: async () => undefined,
      createIssueComment: async (issueId, body) => {
        created.push({ issueId, body });
        return "comment-1";
      },
    };

    await postClarificationComment(linear as LinearGateway, "issue-one", createStoredReview());

    expect(created).toHaveLength(1);
    expect(created[0]?.issueId).toBe("issue-one");
    expect(created[0]?.body).toContain("weavekit-mastermind-clarification:work-one");
  });

  it("updates the existing marker comment instead of creating a new one", async () => {
    let updated: { commentId: string; body: string } | undefined;
    let createCalls = 0;
    const linear: Partial<LinearGateway> = {
      findIssueCommentByMarker: async () => "comment-existing",
      createIssueComment: async () => {
        createCalls += 1;
        return "comment-new";
      },
      updateIssueComment: async (commentId, body) => {
        updated = { commentId, body };
      },
    };

    await postClarificationComment(linear as LinearGateway, "issue-one", createStoredReview());

    expect(createCalls).toBe(0);
    expect(updated?.commentId).toBe("comment-existing");
    expect(updated?.body).toContain("weavekit-mastermind-clarification:work-one");
  });
});

describe("findLatestHumanClarificationReply", () => {
  it("returns undefined when no clarification marker comment exists", () => {
    const comments: LinearIssueComment[] = [
      { id: "c1", body: "hello", createdAt: "2024-01-01T00:00:00.000Z" },
    ];
    expect(findLatestHumanClarificationReply(comments, "work-one")).toBeUndefined();
  });

  it("returns undefined when no reply exists after the marker comment", () => {
    const marker = buildClarificationCommentMarker("work-one");
    const comments: LinearIssueComment[] = [
      { id: "marker", body: `${marker}\nquestions`, createdAt: "2024-01-01T00:00:00.000Z" },
    ];
    expect(findLatestHumanClarificationReply(comments, "work-one")).toBeUndefined();
  });

  it("ignores Mastermind's own follow-up comments and returns the latest human reply", () => {
    const marker = buildClarificationCommentMarker("work-one");
    const comments: LinearIssueComment[] = [
      { id: "marker", body: `${marker}\nquestions`, createdAt: "2024-01-01T00:00:00.000Z" },
      {
        id: "other-marker",
        body: "<!-- weavekit-mastermind-execution:attempt-1 -->\nprogress",
        createdAt: "2024-01-02T00:00:00.000Z",
      },
      { id: "human-1", body: "Deploy to staging.", createdAt: "2024-01-03T00:00:00.000Z" },
      { id: "human-2", body: "Also enable retries.", createdAt: "2024-01-04T00:00:00.000Z" },
    ];
    const reply = findLatestHumanClarificationReply(comments, "work-one");
    expect(reply?.id).toBe("human-2");
  });
});

describe("withRecentHumanComments", () => {
  it("appends human comments to the description and skips Mastermind's own comments", () => {
    const ticket = createTicketSnapshot();
    const marker = buildClarificationCommentMarker("work-one");
    const comments: LinearIssueComment[] = [
      { id: "marker", body: `${marker}\nquestions`, createdAt: "2024-01-01T00:00:00.000Z" },
      { id: "human-1", body: "Deploy to staging.", createdAt: "2024-01-02T00:00:00.000Z" },
    ];
    const augmented = withRecentHumanComments(ticket, comments);
    expect(augmented.description).toContain("Original description.");
    expect(augmented.description).toContain("Deploy to staging.");
    expect(augmented.description).not.toContain(marker);
  });

  it("returns the ticket unchanged when there are no human comments", () => {
    const ticket = createTicketSnapshot();
    const marker = buildClarificationCommentMarker("work-one");
    const comments: LinearIssueComment[] = [
      { id: "marker", body: `${marker}\nquestions`, createdAt: "2024-01-01T00:00:00.000Z" },
    ];
    const augmented = withRecentHumanComments(ticket, comments);
    expect(augmented).toEqual(ticket);
  });
});

describe("applyReviewProposal clarification comment posting", () => {
  it("posts a clarification comment when the review requires human approval", async () => {
    const review = createStoredReview();
    let commentBody: string | undefined;
    const linear: Partial<LinearGateway> = {
      replaceIssueLabels: async () => {},
      fetchIssue: async () => createTicketSnapshot(),
      findIssueCommentByMarker: async () => undefined,
      createIssueComment: async (_issueId, body) => {
        commentBody = body;
        return "comment-1";
      },
    };
    const store: Partial<MastermindStore> = {
      markReviewLabelApplied: async () => {},
      saveReviewAppliedSnapshot: async () => {},
    };

    const result = await applyReviewProposal({
      issueId: "issue-one",
      review,
      statusLabelIds: {
        reviewed: "label-reviewed",
        ready: "label-ready",
        needsInput: "label-needs-input",
        failed: "label-failed",
      },
      linear: linear as LinearGateway,
      store: store as MastermindStore,
    });

    expect(result.requiresHumanApproval).toBe(true);
    expect(commentBody).toBeDefined();
    expect(commentBody).toContain("Which environment should this deploy to?");
  });
});
