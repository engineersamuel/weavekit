import { describe, expect, it } from "vitest";
import { ReviewReadiness } from "../../src/generated/baml_client/index.js";
import { applyReviewProposal } from "../../src/mastermind/actions/reviewTicket.js";
import {
  buildClarificationCommentBody,
  buildClarificationCommentMarker,
  findHumanClarificationChange,
  findLatestHumanClarificationReply,
  findReviewedHumanCommentChange,
  postClarificationComment,
  toReviewedHumanComment,
  withRecentHumanComments,
} from "../../src/mastermind/review/clarification.js";
import { hashLinearTicketContent } from "../../src/mastermind/review/policy.js";
import {
  LinearGraphQlGateway,
  type LinearGateway,
  type LinearIssueComment,
} from "../../src/mastermind/linear/client.js";
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
    originalContentHash: hashLinearTicketContent(ticket),
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

function createAcceptedReview(): StoredReview {
  const review = createStoredReview();
  return {
    ...review,
    patch: {
      ...review.patch,
      proposedTitle: "Reviewed title",
      proposedDescriptionMarkdown: "Reviewed description.",
      readiness: ReviewReadiness.READY,
    },
    validation: {
      accepted: true,
      requiresHumanApproval: false,
      reasons: [],
    },
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
    expect(body).toContain("while this ticket is waiting for input");
    expect(body).toContain("If the review is marked failed");
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

  it("can ensure the marker exists without refreshing an existing comment", async () => {
    let updateCalls = 0;
    const linear: Partial<LinearGateway> = {
      findIssueCommentByMarker: async () => "comment-existing",
      createIssueComment: async () => "comment-new",
      updateIssueComment: async () => {
        updateCalls += 1;
      },
    };

    await postClarificationComment(linear as LinearGateway, "issue-one", createStoredReview(), {
      updateExisting: false,
    });

    expect(updateCalls).toBe(0);
  });

  it("does not refresh an already published marker whose body matches the review", async () => {
    const review = createStoredReview();
    const marker = buildClarificationCommentMarker(review.workId);
    const body = buildClarificationCommentBody(marker, review);
    let updateCalls = 0;
    const linear: Partial<LinearGateway> = {
      findIssueCommentByMarker: async () => "comment-existing",
      listIssueComments: async () => [
        {
          id: "comment-existing",
          body,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      createIssueComment: async () => "comment-new",
      updateIssueComment: async () => {
        updateCalls += 1;
      },
    };

    await postClarificationComment(linear as LinearGateway, "issue-one", review, {
      updateExisting: "if-changed",
    });

    expect(updateCalls).toBe(0);
  });

  it("repairs an already applied marker whose body does not match the review", async () => {
    let updatedBody: string | undefined;
    const linear: Partial<LinearGateway> = {
      findIssueCommentByMarker: async () => "comment-existing",
      listIssueComments: async () => [
        {
          id: "comment-existing",
          body: `${buildClarificationCommentMarker("work-one")}\nOld questions`,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      createIssueComment: async () => "comment-new",
      updateIssueComment: async (_commentId, body) => {
        updatedBody = body;
      },
    };

    await postClarificationComment(linear as LinearGateway, "issue-one", createStoredReview(), {
      updateExisting: "if-changed",
    });

    expect(updatedBody).toContain("Should we support retries?");
  });

  it("asserts the lease immediately before updating an existing marker", async () => {
    const events: string[] = [];
    const linear: Partial<LinearGateway> = {
      findIssueCommentByMarker: async () => {
        events.push("lookup");
        return "comment-existing";
      },
      listIssueComments: async () => {
        events.push("read");
        return [
          {
            id: "comment-existing",
            body: "stale body",
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        ];
      },
      createIssueComment: async () => "comment-new",
      updateIssueComment: async () => {
        events.push("update");
      },
    };

    await postClarificationComment(linear as LinearGateway, "issue-one", createStoredReview(), {
      updateExisting: "if-changed",
      assertLease: async () => {
        events.push("lease");
      },
    });

    expect(events).toEqual(["lookup", "read", "lease", "update"]);
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

  it("does not reuse a human reply that predates the marker comment's latest update", () => {
    const marker = buildClarificationCommentMarker("work-one");
    const comments: LinearIssueComment[] = [
      {
        id: "marker",
        body: `${marker}\nupdated questions`,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-03T00:00:00.000Z",
      },
      {
        id: "human",
        body: "Answer to the original questions.",
        createdAt: "2024-01-02T00:00:00.000Z",
      },
    ];

    expect(findLatestHumanClarificationReply(comments, "work-one")).toBeUndefined();
  });

  it("accepts a human reply created after the marker comment's latest update", () => {
    const marker = buildClarificationCommentMarker("work-one");
    const comments: LinearIssueComment[] = [
      {
        id: "marker",
        body: `${marker}\nupdated questions`,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-03T00:00:00.000Z",
      },
      {
        id: "human",
        body: "Answer to the updated questions.",
        createdAt: "2024-01-04T00:00:00.000Z",
      },
    ];

    expect(findLatestHumanClarificationReply(comments, "work-one")?.id).toBe("human");
  });

  it("accepts an unseen human reply even when marker publication happened later", () => {
    const marker = buildClarificationCommentMarker("work-one");
    const comments: LinearIssueComment[] = [
      {
        id: "marker",
        body: `${marker}\nupdated questions`,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-03T00:00:00.000Z",
      },
      {
        id: "human-reviewed",
        body: "Answer included in the review.",
        createdAt: "2024-01-02T00:00:00.000Z",
      },
      {
        id: "human-raced",
        body: "Answer posted while the review was generated.",
        createdAt: "2024-01-02T12:00:00.000Z",
      },
    ];

    expect(findLatestHumanClarificationReply(comments, "work-one", ["human-reviewed"])?.id).toBe(
      "human-raced",
    );
  });

  it("does not reuse a reviewed reply when an unchanged marker retains an older timestamp", () => {
    const marker = buildClarificationCommentMarker("work-one");
    const comments: LinearIssueComment[] = [
      {
        id: "marker",
        body: `${marker}\nunchanged questions`,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "human-reviewed",
        body: "Answer already included in the review.",
        createdAt: "2024-01-02T00:00:00.000Z",
      },
    ];

    expect(
      findLatestHumanClarificationReply(comments, "work-one", ["human-reviewed"]),
    ).toBeUndefined();
  });

  it("detects an edited human reply by its persisted revision", () => {
    const marker = buildClarificationCommentMarker("work-one");
    const original: LinearIssueComment = {
      id: "human-reviewed",
      body: "Deploy to staging.",
      createdAt: "2024-01-02T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    };
    const comments: LinearIssueComment[] = [
      {
        id: "marker",
        body: `${marker}\nquestions`,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      {
        ...original,
        body: "Deploy to production.",
        updatedAt: "2024-01-03T00:00:00.000Z",
      },
    ];

    expect(
      findHumanClarificationChange(comments, "work-one", [toReviewedHumanComment(original)]),
    ).toMatchObject({
      comment: { id: "human-reviewed" },
      reason: expect.stringContaining("changed"),
    });
  });

  it("detects deletion of a reviewed human reply", () => {
    const marker = buildClarificationCommentMarker("work-one");
    const reviewed = toReviewedHumanComment({
      id: "human-reviewed",
      body: "Deploy to staging.",
      createdAt: "2024-01-02T00:00:00.000Z",
    });

    expect(
      findHumanClarificationChange(
        [
          {
            id: "marker",
            body: `${marker}\nquestions`,
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        ],
        "work-one",
        [reviewed],
      ),
    ).toEqual({
      reason: "human clarification comment human-reviewed was deleted after Mastermind reviewed it",
    });
  });

  it("detects a reply added after an empty review comment snapshot without a marker", () => {
    expect(
      findReviewedHumanCommentChange(
        [
          {
            id: "human-raced",
            body: "Reply posted during review generation.",
            createdAt: "2024-01-02T00:00:00.000Z",
          },
        ],
        [],
      ),
    ).toMatchObject({
      comment: { id: "human-raced" },
      reason: expect.stringContaining("human posted a clarification reply"),
    });
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

describe("LinearGraphQlGateway.listIssueComments", () => {
  it("requests and maps the latest comment update timestamp", async () => {
    let query = "";
    const fetcher: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      query = request.query;
      return Response.json({
        data: {
          issue: {
            comments: {
              nodes: [
                {
                  id: "comment-one",
                  body: "Clarification",
                  createdAt: "2024-01-01T00:00:00.000Z",
                  updatedAt: "2024-01-02T00:00:00.000Z",
                },
              ],
            },
          },
        },
      });
    };
    const gateway = new LinearGraphQlGateway("test-key", "https://linear.test/graphql", fetcher);

    await expect(gateway.listIssueComments("issue-one")).resolves.toEqual([
      {
        id: "comment-one",
        body: "Clarification",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
      },
    ]);
    expect(query).toContain("nodes { id body createdAt updatedAt }");
  });
});

describe("applyReviewProposal clarification comment posting", () => {
  it("posts a clarification comment when the review requires human approval", async () => {
    const review = createStoredReview();
    const ticket = createTicketSnapshot();
    let commentBody: string | undefined;
    const linear: Partial<LinearGateway> = {
      replaceIssueLabels: async (_issueId, input) => {
        ticket.labels = input.add.map((id) => ({ id, name: "Mastermind Needs Input" }));
      },
      fetchIssue: async () => structuredClone(ticket),
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

  it("does not refresh the marker when replaying an already applied review", async () => {
    const appliedTicket = {
      ...createTicketSnapshot(),
      labels: [{ id: "label-needs-input", name: "Mastermind Needs Input" }],
    };
    const review = {
      ...createStoredReview(),
      labelApplied: true,
      appliedSnapshot: appliedTicket,
    };
    const body = buildClarificationCommentBody(
      buildClarificationCommentMarker(review.workId),
      review,
    );
    let updateCalls = 0;
    const linear: Partial<LinearGateway> = {
      replaceIssueLabels: async () => {},
      fetchIssue: async () => structuredClone(appliedTicket),
      findIssueCommentByMarker: async () => "comment-existing",
      listIssueComments: async () => [
        {
          id: "comment-existing",
          body,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      createIssueComment: async () => "comment-new",
      updateIssueComment: async () => {
        updateCalls += 1;
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
    expect(updateCalls).toBe(0);
  });

  it("invalidates a human-input review when the ticket changed before labels were applied", async () => {
    const review = createStoredReview();
    const changedTicket = {
      ...createTicketSnapshot(),
      description: "Human supplied the missing details before review application.",
    };
    let labelCalls = 0;
    let commentCalls = 0;
    let invalidationReason: string | undefined;
    const linear: Partial<LinearGateway> = {
      replaceIssueLabels: async () => {
        labelCalls += 1;
      },
      fetchIssue: async () => changedTicket,
      findIssueCommentByMarker: async () => undefined,
      createIssueComment: async () => {
        commentCalls += 1;
        return "comment-1";
      },
    };
    const store: Partial<MastermindStore> = {
      invalidateReview: async (_reviewId, reason) => {
        invalidationReason = reason;
      },
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

    expect(result).toMatchObject({ stale: true, applied: false });
    expect(labelCalls).toBe(0);
    expect(commentCalls).toBe(0);
    expect(invalidationReason).toContain("changed after review");
  });

  it("recognizes a needs-input label applied before label persistence was interrupted", async () => {
    const review = createStoredReview();
    const ticket = createTicketSnapshot();
    let labelCalls = 0;
    let failLabelPersistence = true;
    let savedSnapshot: LinearTicketSnapshot | undefined;
    const linear: Partial<LinearGateway> = {
      replaceIssueLabels: async (_issueId, input) => {
        labelCalls += 1;
        ticket.labels = input.add.map((id) => ({ id, name: "Mastermind Needs Input" }));
      },
      fetchIssue: async () => structuredClone(ticket),
      findIssueCommentByMarker: async () => undefined,
      createIssueComment: async () => "comment-1",
    };
    const store: Partial<MastermindStore> = {
      markReviewLabelApplied: async (_reviewId, snapshot) => {
        if (failLabelPersistence) {
          failLabelPersistence = false;
          throw new Error("Simulated crash before label persistence.");
        }
        savedSnapshot = snapshot;
      },
    };
    const args = {
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
    };

    await expect(applyReviewProposal(args)).rejects.toThrow(
      "Simulated crash before label persistence.",
    );
    await expect(applyReviewProposal(args)).resolves.toMatchObject({
      requiresHumanApproval: true,
      stale: false,
    });

    expect(labelCalls).toBe(1);
    expect(savedSnapshot?.labels.map((label) => label.id)).toEqual(["label-needs-input"]);
  });

  it("invalidates an accepted label-applied review when the ticket changed before replay", async () => {
    const review: StoredReview = {
      ...createStoredReview(),
      validation: {
        accepted: true,
        requiresHumanApproval: false,
        reasons: [],
      },
      contentApplied: true,
      labelApplied: true,
      appliedSnapshot: createTicketSnapshot(),
    };
    let snapshotWrites = 0;
    let invalidationReason: string | undefined;
    const linear: Partial<LinearGateway> = {
      fetchIssue: async () => ({
        ...createTicketSnapshot(),
        description: "Human edit after label application.",
      }),
    };
    const store: Partial<MastermindStore> = {
      saveReviewAppliedSnapshot: async () => {
        snapshotWrites += 1;
      },
      invalidateReview: async (_reviewId, reason) => {
        invalidationReason = reason;
      },
    };

    await expect(
      applyReviewProposal({
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
      }),
    ).resolves.toMatchObject({ applied: false, stale: true });

    expect(snapshotWrites).toBe(0);
    expect(invalidationReason).toContain("stored review was applied");
  });

  it("invalidates an accepted review when content changes after the Linear update", async () => {
    const review = createAcceptedReview();
    const ticket = createTicketSnapshot();
    let fetchCalls = 0;
    let contentApplied = false;
    let invalidationReason: string | undefined;
    const linear: Partial<LinearGateway> = {
      fetchIssue: async () => {
        fetchCalls += 1;
        if (fetchCalls === 2) {
          ticket.description = "Concurrent human edit.";
        }
        return structuredClone(ticket);
      },
      updateIssueContent: async (_issueId, input) => {
        ticket.title = input.title;
        ticket.description = input.description;
      },
    };
    const store: Partial<MastermindStore> = {
      markReviewContentApplied: async () => {
        contentApplied = true;
      },
      invalidateReview: async (_reviewId, reason) => {
        invalidationReason = reason;
      },
    };

    await expect(
      applyReviewProposal({
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
      }),
    ).resolves.toMatchObject({ applied: false, stale: true });

    expect(contentApplied).toBe(false);
    expect(invalidationReason).toContain("before it was persisted");
  });

  it("recognizes content applied before atomic content persistence was interrupted", async () => {
    const review = createAcceptedReview();
    const ticket = createTicketSnapshot();
    let contentUpdateCalls = 0;
    let failContentPersistence = true;
    const linear: Partial<LinearGateway> = {
      fetchIssue: async () => structuredClone(ticket),
      updateIssueContent: async (_issueId, input) => {
        contentUpdateCalls += 1;
        ticket.title = input.title;
        ticket.description = input.description;
      },
      replaceIssueLabels: async (_issueId, input) => {
        ticket.labels = input.add.map((id) => ({ id, name: id }));
      },
    };
    const store: Partial<MastermindStore> = {
      markReviewContentApplied: async () => {
        if (failContentPersistence) {
          failContentPersistence = false;
          throw new Error("Simulated crash before content persistence.");
        }
      },
      markReviewLabelApplied: async () => {},
    };
    const args = {
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
    };

    await expect(applyReviewProposal(args)).rejects.toThrow(
      "Simulated crash before content persistence.",
    );
    await expect(applyReviewProposal(args)).resolves.toMatchObject({
      applied: true,
      stale: false,
    });

    expect(contentUpdateCalls).toBe(1);
  });
});
