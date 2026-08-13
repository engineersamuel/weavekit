import { describe, expect, it } from "vitest";
import {
  ProjectRepositoryMode,
  RepositoryEvidenceType,
  ReviewEvidenceKind,
  ReviewOpenItemKind,
  ReviewOpenItemOwner,
  ReviewReadiness,
  TicketKind,
  type LinearTicketInput,
  type MastermindNextActionDecision,
  type MastermindProjectPolicyInput,
  type ProposedLinearTicketPatch,
  type TicketReviewDossier,
} from "../../src/generated/baml_client/index.js";
import { generateReviewProposal } from "../../src/mastermind/actions/reviewTicket.js";
import type { MastermindDecisionProvider } from "../../src/mastermind/decision/bamlAdapters.js";
import type {
  TicketReviewHarness,
  TicketReviewRequest,
} from "../../src/mastermind/review/harness.js";
import type {
  LinearTicketSnapshot,
  MastermindStore,
  StoredReview,
  TicketReviewValidationRecord,
} from "../../src/mastermind/store/store.js";

function createTicketSnapshot(): LinearTicketSnapshot {
  return {
    id: "issue-one",
    identifier: "WK-1",
    url: "https://linear.app/weavekit/issue/WK-1/review-reuse",
    title: "Reuse pending review safely",
    description: "Do not blindly resume legacy pending reviews.",
    labels: [],
    status: "Todo",
    teamId: "team-one",
    projectId: "project-one",
  };
}

function createProject(): MastermindProjectPolicyInput {
  return {
    id: "weavekit",
    displayName: "Weavekit",
    repositoryMode: ProjectRepositoryMode.EXISTING_REPOSITORY,
    repositoryPath: process.cwd(),
    allowedActions: [],
  };
}

function createDossier(): TicketReviewDossier {
  return {
    ticketKind: TicketKind.TECHNICAL_TASK,
    preservedIntent: "Keep pending review reuse fail-closed under the current ownership policy.",
    summary: "Repository evidence already exists for this ticket.",
    repositoryEvidence: [
      {
        id: "repo-package",
        kind: ReviewEvidenceKind.REPOSITORY,
        repositoryEvidenceType: RepositoryEvidenceType.FILE,
        repositoryPath: "package.json",
        claim: "The repository uses Nub scripts for validation.",
        confidence: 1,
      },
    ],
    linearEvidence: [],
    externalEvidence: [],
    assumptions: [],
    ambiguities: [],
    unansweredQuestions: [],
    risks: [],
    dependencies: [],
    suggestedAcceptanceCriteria: ["Pending review reuse stays safe under the current contract."],
    automatedVerification: ["nub run test -- tests/mastermind/reviewTicket.test.ts"],
    manualVerification: [],
    validationSteps: ["Confirm legacy pending reviews regenerate instead of resuming unchanged."],
    observability: [],
    rolloutPlan: [],
    rollbackPlan: [],
    outOfScope: [],
    materialScopeChange: false,
    confidence: 0.93,
  };
}

function createCurrentPendingPatch(): ProposedLinearTicketPatch {
  return {
    proposedTitle: "Repair pending-review reuse for Mastermind",
    proposedDescriptionMarkdown:
      "Goal\n\nRegenerate legacy pending reviews before action planning resumes.",
    ticketKind: TicketKind.TECHNICAL_TASK,
    preservedIntent: "Keep pending review reuse fail-closed under the current ownership policy.",
    acceptanceCriteria: ["Legacy pending reviews cannot bypass fresh synthesis."],
    assumptions: [],
    ambiguities: [],
    unansweredQuestions: ["Is the proxy runtime available in this environment?"],
    openItemDispositions: [
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "Is the proxy runtime available in this environment?",
        owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
        rationale: "The executor can verify the proxy immediately before work starts.",
      },
    ],
    dependencies: [],
    risks: [],
    automatedVerification: ["nub run test -- tests/mastermind/reviewTicket.test.ts"],
    manualVerification: [],
    validationSteps: ["Confirm pending review reuse preserves current ownership semantics."],
    observability: [],
    rolloutPlan: [],
    rollbackPlan: [],
    outOfScope: [],
    evidence: createDossier().repositoryEvidence,
    readiness: ReviewReadiness.READY_WITH_NONBLOCKING_GAPS,
    blockingReasons: [],
    warnings: ["Verify the proxy before implementation starts."],
    materialScopeChange: false,
    requiresHumanApproval: false,
    confidence: 0.94,
  };
}

function createStoredReview(
  overrides: Partial<StoredReview> = {},
  patchOverrides: Partial<ProposedLinearTicketPatch> = {},
): StoredReview {
  const ticket = createTicketSnapshot();
  const patch = {
    ...createCurrentPendingPatch(),
    ...patchOverrides,
  } satisfies ProposedLinearTicketPatch;
  return {
    id: "review-existing",
    workId: "work-one",
    originalSnapshot: ticket,
    originalContentHash: "hash-one",
    dossier: createDossier(),
    patch,
    validation: {
      accepted: true,
      requiresHumanApproval: false,
      reasons: [],
    },
    contentApplied: false,
    labelApplied: false,
    invalidated: false,
    ...overrides,
  };
}

class CountingReviewHarness implements TicketReviewHarness {
  reviewCalls = 0;

  async review(request: TicketReviewRequest): Promise<TicketReviewDossier> {
    this.reviewCalls += 1;
    expect(request.ticket.id).toBe("issue-one");
    return createDossier();
  }
}

class CountingDecisionProvider implements MastermindDecisionProvider {
  synthesisCalls = 0;
  readonly synthesisProjects: MastermindProjectPolicyInput[] = [];
  private readonly patches: ProposedLinearTicketPatch[] | undefined;

  constructor(patches?: ProposedLinearTicketPatch[]) {
    this.patches = patches;
  }

  async synthesizeTicketPatch(
    ticket: LinearTicketInput,
    project: MastermindProjectPolicyInput,
    dossier: TicketReviewDossier,
  ): Promise<ProposedLinearTicketPatch> {
    expect(ticket.id).toBe("issue-one");
    expect(dossier.preservedIntent).toBe(
      "Keep pending review reuse fail-closed under the current ownership policy.",
    );
    this.synthesisProjects.push(project);
    const patch = this.patches?.[this.synthesisCalls] ?? createCurrentPendingPatch();
    this.synthesisCalls += 1;
    return patch;
  }

  async decideNextAction(): Promise<MastermindNextActionDecision> {
    throw new Error("decideNextAction is not used in generateReviewProposal tests");
  }
}

function createReviewStore(initialReview?: StoredReview): {
  store: MastermindStore;
  invalidations: Array<{ reviewId: string; reason: string }>;
  savedReviews: StoredReview[];
  savedValidations: Array<{ reviewId: string; validation: TicketReviewValidationRecord }>;
} {
  let currentReview = initialReview ? structuredClone(initialReview) : undefined;
  let nextReviewId = 1;
  const invalidations: Array<{ reviewId: string; reason: string }> = [];
  const savedReviews: StoredReview[] = [];
  const savedValidations: Array<{ reviewId: string; validation: TicketReviewValidationRecord }> =
    [];

  const store = {
    async getLatestReview(workId: string): Promise<StoredReview | undefined> {
      expect(workId).toBe("work-one");
      return currentReview && !currentReview.invalidated
        ? structuredClone(currentReview)
        : undefined;
    },
    async saveReviewProposal(
      workId: string,
      snapshot: LinearTicketSnapshot,
      originalContentHash: string,
      dossier: TicketReviewDossier,
      patch: ProposedLinearTicketPatch,
    ): Promise<StoredReview> {
      const review: StoredReview = {
        id: `review-generated-${nextReviewId}`,
        workId,
        originalSnapshot: snapshot,
        originalContentHash,
        dossier,
        patch,
        contentApplied: false,
        labelApplied: false,
        invalidated: false,
      };
      nextReviewId += 1;
      currentReview = structuredClone(review);
      savedReviews.push(structuredClone(review));
      return structuredClone(review);
    },
    async saveReviewValidation(
      reviewId: string,
      validation: TicketReviewValidationRecord,
    ): Promise<void> {
      savedValidations.push({ reviewId, validation });
      if (currentReview?.id === reviewId) {
        currentReview = { ...currentReview, validation };
      }
    },
    async invalidateReview(reviewId: string, reason: string): Promise<void> {
      invalidations.push({ reviewId, reason });
      if (currentReview?.id === reviewId) {
        currentReview = {
          ...currentReview,
          invalidated: true,
          invalidationReason: reason,
        };
      }
    },
  } satisfies Pick<
    MastermindStore,
    "getLatestReview" | "saveReviewProposal" | "saveReviewValidation" | "invalidateReview"
  >;

  return {
    store: store as MastermindStore,
    invalidations,
    savedReviews,
    savedValidations,
  };
}

describe("generateReviewProposal", () => {
  it("synthesizes against the project resolved from repository evidence", async () => {
    const { store } = createReviewStore();
    const decisions = new CountingDecisionProvider();
    const harness = new CountingReviewHarness();
    const dynamicProject: MastermindProjectPolicyInput = {
      id: "prototype-wk-1",
      displayName: "Prototype WK-1",
      repositoryMode: ProjectRepositoryMode.GREENFIELD,
      provisioningRoot: "/home/test/projects/prototypes",
      allowedActions: [],
    };

    await generateReviewProposal({
      workId: "work-one",
      ticket: createTicketSnapshot(),
      project: createProject(),
      harness,
      decisions,
      store,
      resolveProject: () => dynamicProject,
    });

    expect(decisions.synthesisProjects).toEqual([dynamicProject]);
    expect(harness.reviewCalls).toBe(2);
  });

  it("reuses a valid current pending review without rerunning the harness or synthesis", async () => {
    const pending = createStoredReview();
    const { store, invalidations, savedReviews } = createReviewStore(pending);
    const harness = new CountingReviewHarness();
    const decisions = new CountingDecisionProvider();

    const review = await generateReviewProposal({
      workId: "work-one",
      ticket: createTicketSnapshot(),
      project: createProject(),
      harness,
      decisions,
      store,
    });

    expect(review.id).toBe(pending.id);
    expect(review.validation).toMatchObject({
      accepted: true,
      requiresHumanApproval: false,
    });
    expect(harness.reviewCalls).toBe(0);
    expect(decisions.synthesisCalls).toBe(0);
    expect(invalidations).toEqual([]);
    expect(savedReviews).toEqual([]);
  });

  it("invalidates and regenerates a legacy pending review before reuse", async () => {
    const pending = createStoredReview(
      {
        id: "review-legacy",
        legacyOpenItemDispositionsMissing: true,
      },
      {
        openItemDispositions: [],
      },
    );
    const { store, invalidations, savedReviews, savedValidations } = createReviewStore(pending);
    const harness = new CountingReviewHarness();
    const decisions = new CountingDecisionProvider();

    const review = await generateReviewProposal({
      workId: "work-one",
      ticket: createTicketSnapshot(),
      project: createProject(),
      harness,
      decisions,
      store,
    });

    expect(review.id).not.toBe(pending.id);
    expect(review.validation).toMatchObject({
      accepted: true,
      requiresHumanApproval: false,
    });
    expect(review.patch.openItemDispositions).toEqual([
      expect.objectContaining({
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "Is the proxy runtime available in this environment?",
        owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
      }),
    ]);
    expect(harness.reviewCalls).toBe(1);
    expect(decisions.synthesisCalls).toBe(1);
    expect(savedReviews).toHaveLength(1);
    expect(savedValidations).toEqual([
      expect.objectContaining({
        reviewId: review.id,
      }),
    ]);
    expect(invalidations).toEqual([
      expect.objectContaining({
        reviewId: "review-legacy",
        reason: expect.stringContaining(
          "the stored review predates open-item ownership for unanswered or blocking items",
        ),
      }),
    ]);
  });

  it("resynthesizes the patch when open-item disposition coverage is incomplete", async () => {
    const { store, savedReviews } = createReviewStore();
    const harness = new CountingReviewHarness();
    const gappyPatch: ProposedLinearTicketPatch = {
      ...createCurrentPendingPatch(),
      readiness: ReviewReadiness.BLOCKED,
      blockingReasons: ["Product owner must choose the compatibility policy."],
      unansweredQuestions: [],
      openItemDispositions: [],
      requiresHumanApproval: true,
    };
    const goodPatch: ProposedLinearTicketPatch = {
      ...gappyPatch,
      openItemDispositions: [
        {
          kind: ReviewOpenItemKind.BLOCKING_REASON,
          text: "Product owner must choose the compatibility policy.",
          owner: ReviewOpenItemOwner.HUMAN,
          rationale: "Only the product owner can decide the compatibility policy.",
        },
      ],
    };
    const decisions = new CountingDecisionProvider([gappyPatch, goodPatch]);

    const review = await generateReviewProposal({
      workId: "work-one",
      ticket: createTicketSnapshot(),
      project: createProject(),
      harness,
      decisions,
      store,
    });

    expect(decisions.synthesisCalls).toBe(2);
    expect(review.patch.openItemDispositions).toHaveLength(1);
    expect(review.validation).toMatchObject({ accepted: true });
    expect(savedReviews).toHaveLength(1);
    expect(savedReviews[0]?.patch).toEqual(goodPatch);
  });

  it("backfills a safe default disposition after the retry budget is exhausted", async () => {
    const { store, savedReviews } = createReviewStore();
    const harness = new CountingReviewHarness();
    const gappyPatch: ProposedLinearTicketPatch = {
      ...createCurrentPendingPatch(),
      readiness: ReviewReadiness.BLOCKED,
      blockingReasons: ["Product owner must choose the compatibility policy."],
      unansweredQuestions: [],
      openItemDispositions: [],
      requiresHumanApproval: true,
    };
    const decisions = new CountingDecisionProvider([gappyPatch, gappyPatch, gappyPatch]);

    const review = await generateReviewProposal({
      workId: "work-one",
      ticket: createTicketSnapshot(),
      project: createProject(),
      harness,
      decisions,
      store,
    });

    expect(decisions.synthesisCalls).toBe(3);
    expect(review.validation?.accepted).toBe(true);
    expect(review.patch.openItemDispositions).toEqual([
      expect.objectContaining({
        kind: ReviewOpenItemKind.BLOCKING_REASON,
        text: "Product owner must choose the compatibility policy.",
        owner: ReviewOpenItemOwner.HUMAN,
      }),
    ]);
    expect(review.patch.requiresHumanApproval).toBe(true);
    expect(savedReviews[0]?.patch.openItemDispositions).toEqual(review.patch.openItemDispositions);
  });

  it("normalizes a self-inconsistent requiresHumanApproval flag instead of failing validation", async () => {
    const { store, savedReviews } = createReviewStore();
    const harness = new CountingReviewHarness();
    // The model correctly used EXECUTOR_PREFLIGHT-only ownership and READY_WITH_NONBLOCKING_GAPS
    // readiness, but incorrectly self-reported requiresHumanApproval: true even though nothing
    // requires human approval — a known model self-consistency slip on this redundant field.
    const inconsistentPatch: ProposedLinearTicketPatch = {
      ...createCurrentPendingPatch(),
      readiness: ReviewReadiness.READY_WITH_NONBLOCKING_GAPS,
      blockingReasons: [],
      unansweredQuestions: ["Verify gh/az CLI auth before starting."],
      openItemDispositions: [
        {
          kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
          text: "Verify gh/az CLI auth before starting.",
          owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
          rationale: "The executor can verify auth itself before starting.",
        },
      ],
      requiresHumanApproval: true,
      materialScopeChange: false,
    };
    const decisions = new CountingDecisionProvider([inconsistentPatch]);

    const review = await generateReviewProposal({
      workId: "work-one",
      ticket: createTicketSnapshot(),
      project: createProject(),
      harness,
      decisions,
      store,
    });

    expect(decisions.synthesisCalls).toBe(1);
    expect(review.patch.requiresHumanApproval).toBe(false);
    expect(review.validation).toMatchObject({ accepted: true, requiresHumanApproval: false });
    expect(savedReviews[0]?.patch.requiresHumanApproval).toBe(false);
  });
});
