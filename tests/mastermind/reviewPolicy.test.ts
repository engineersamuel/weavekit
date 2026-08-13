import { describe, expect, it } from "vitest";
import {
  ProjectRepositoryMode,
  RepositoryEvidenceType,
  ReviewEvidenceKind,
  ReviewOpenItemKind,
  ReviewOpenItemOwner,
  ReviewReadiness,
  TicketKind,
  type MastermindProjectPolicyInput,
  type ProposedLinearTicketPatch,
  type TicketReviewDossier,
} from "../../src/generated/baml_client/index.js";
import {
  backfillOpenItemDispositions,
  normalizeEmptyBlockedReadiness,
  normalizeStandingDefaultOpenItems,
  validateTicketReviewProposal,
  type TicketReviewPolicyResult,
} from "../../src/mastermind/review/policy.js";
import type { LinearTicketSnapshot } from "../../src/mastermind/store/store.js";

function createTicket(): LinearTicketSnapshot {
  return {
    id: "issue-one",
    identifier: "WK-1",
    url: "https://linear.app/weavekit/issue/WK-1/review-aware-routing",
    title: "Review-aware next action",
    description: "Use the stored review to plan the next action.",
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
    preservedIntent: "Plan the next action from the stored review.",
    summary: "The repository already contains the durable Mastermind control plane.",
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
    suggestedAcceptanceCriteria: ["The next action respects review ownership."],
    automatedVerification: ["nub run test -- tests/mastermind/reviewPolicy.test.ts"],
    manualVerification: [],
    validationSteps: ["Confirm action routing matches review context."],
    observability: [],
    rolloutPlan: [],
    rollbackPlan: [],
    outOfScope: [],
    materialScopeChange: false,
    confidence: 0.9,
  };
}

function createPatch(): ProposedLinearTicketPatch {
  return {
    proposedTitle: "Make Mastermind next-action selection review-aware",
    proposedDescriptionMarkdown: "Goal\n\nUse stored review context before action planning.",
    ticketKind: TicketKind.TECHNICAL_TASK,
    preservedIntent: "Plan the next action from the stored review.",
    acceptanceCriteria: ["Mastermind preserves review ownership before planning work."],
    assumptions: [],
    ambiguities: [],
    unansweredQuestions: [],
    openItemDispositions: [],
    dependencies: [],
    risks: [],
    automatedVerification: ["nub run test -- tests/mastermind/reviewPolicy.test.ts"],
    manualVerification: [],
    validationSteps: ["Confirm action routing matches review context."],
    observability: [],
    rolloutPlan: [],
    rollbackPlan: [],
    outOfScope: [],
    evidence: createDossier().repositoryEvidence,
    readiness: ReviewReadiness.READY,
    blockingReasons: [],
    warnings: [],
    materialScopeChange: false,
    requiresHumanApproval: false,
    confidence: 0.92,
  };
}

function validatePatch(patch: ProposedLinearTicketPatch): TicketReviewPolicyResult {
  return validateTicketReviewProposal({
    ticket: createTicket(),
    project: createProject(),
    dossier: createDossier(),
    patch,
  });
}

describe("Mastermind review policy", () => {
  it("normalizes empty BLOCKED readiness to READY", () => {
    const patch = createPatch();
    patch.readiness = ReviewReadiness.BLOCKED;
    patch.ambiguities = ["The executor can select any compatible github: model."];

    const normalized = normalizeEmptyBlockedReadiness(patch);

    expect(normalized.readiness).toBe(ReviewReadiness.READY);
    expect(validatePatch(normalized)).toMatchObject({
      accepted: true,
      requiresHumanApproval: false,
      reasons: [],
    });
  });

  it("preserves BLOCKED readiness when structured blockers exist", () => {
    const patch = createPatch();
    patch.readiness = ReviewReadiness.BLOCKED;
    patch.blockingReasons = ["The vendor sandbox is unavailable."];

    expect(normalizeEmptyBlockedReadiness(patch)).toBe(patch);
  });

  it("keeps the Markdown Open questions section consistent with structured questions", () => {
    const patch = createPatch();
    patch.proposedDescriptionMarkdown = `## Goal

Implement the ticket.

## Open questions

* Which model provider should be used?

## Dependencies

None.
`;

    const normalized = normalizeStandingDefaultOpenItems(patch);

    expect(normalized.proposedDescriptionMarkdown).toContain("## Open questions\n\nNone.");
    expect(normalized.proposedDescriptionMarkdown).not.toContain(
      "Which model provider should be used?",
    );
  });

  it("does not ask a human to confirm an unobservable Copilot PAT scope", () => {
    const patch = createPatch();
    const question =
      "Confirm a PAT with Copilot Requests permission is available before deployment.";
    patch.readiness = ReviewReadiness.READY_WITH_NONBLOCKING_GAPS;
    patch.requiresHumanApproval = true;
    patch.unansweredQuestions = [question];
    patch.openItemDispositions = [
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: question,
        owner: ReviewOpenItemOwner.HUMAN,
        rationale: "The scope cannot be enumerated.",
      },
    ];
    patch.proposedDescriptionMarkdown = `## Goal

Deploy the sample.

## Open questions

* ${question}
* Which model provider should be used?

## Dependencies

Authenticated GitHub CLI.
`;

    const normalized = normalizeStandingDefaultOpenItems(patch);

    expect(normalized).toMatchObject({
      readiness: ReviewReadiness.READY,
      requiresHumanApproval: false,
      unansweredQuestions: [],
      blockingReasons: [],
      openItemDispositions: [],
      warnings: [question],
    });
    expect(normalized.proposedDescriptionMarkdown).toContain("## Open questions\n\nNone.");
    expect(normalized.proposedDescriptionMarkdown).not.toContain(
      "Which model provider should be used?",
    );
    expect(validatePatch(normalized)).toMatchObject({
      accepted: true,
      requiresHumanApproval: false,
      reasons: [],
    });
  });

  it("accepts exact unanswered-question disposition coverage", () => {
    const patch = createPatch();
    patch.readiness = ReviewReadiness.READY_WITH_NONBLOCKING_GAPS;
    patch.unansweredQuestions = ["Is the proxy runtime available in this environment?"];
    patch.openItemDispositions = [
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "Is the proxy runtime available in this environment?",
        owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
        rationale: "The executor can verify the runtime immediately before work.",
      },
    ];
    patch.warnings = ["Verify the runtime before implementation starts."];

    expect(validatePatch(patch)).toMatchObject({
      accepted: true,
      requiresHumanApproval: false,
      reasons: [],
    });
  });

  it("rejects unanswered questions without exactly one matching disposition", () => {
    const patch = createPatch();
    patch.readiness = ReviewReadiness.READY_WITH_NONBLOCKING_GAPS;
    patch.unansweredQuestions = ["Which runtime is pinned for the executor?"];

    expect(validatePatch(patch)).toMatchObject({
      accepted: false,
      reasons: expect.arrayContaining([
        'Open-item disposition coverage mismatch for unanswered question "Which runtime is pinned for the executor?": expected 1, found 0.',
      ]),
    });

    patch.openItemDispositions = [
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "Which runtime is pinned for the executor?",
        owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
        rationale: "The executor can verify the runtime before work starts.",
      },
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "Which runtime is pinned for the executor?",
        owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
        rationale: "Duplicate disposition should be rejected.",
      },
    ];

    expect(validatePatch(patch)).toMatchObject({
      accepted: false,
      reasons: expect.arrayContaining([
        'Open-item disposition coverage mismatch for unanswered question "Which runtime is pinned for the executor?": expected 1, found 2.',
        'Open-item disposition count mismatch for unanswered question "Which runtime is pinned for the executor?": expected 1, found 2.',
      ]),
    });
  });

  it("rejects blocking reasons without exactly one matching disposition", () => {
    const patch = createPatch();
    patch.readiness = ReviewReadiness.BLOCKED;
    patch.unansweredQuestions = ["When will the vendor sandbox become reachable again?"];
    patch.blockingReasons = ["The vendor sandbox is unavailable to the executor."];

    patch.openItemDispositions = [
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "When will the vendor sandbox become reachable again?",
        owner: ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
        rationale: "The executor cannot unblock the vendor sandbox.",
      },
    ];

    expect(validatePatch(patch)).toMatchObject({
      accepted: false,
      reasons: expect.arrayContaining([
        'Open-item disposition coverage mismatch for blocking reason "The vendor sandbox is unavailable to the executor.": expected 1, found 0.',
      ]),
    });

    patch.openItemDispositions = [
      ...patch.openItemDispositions,
      {
        kind: ReviewOpenItemKind.BLOCKING_REASON,
        text: "The vendor sandbox is unavailable to the executor.",
        owner: ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
        rationale: "The executor must wait for the vendor sandbox to recover.",
      },
      {
        kind: ReviewOpenItemKind.BLOCKING_REASON,
        text: "The vendor sandbox is unavailable to the executor.",
        owner: ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
        rationale: "Duplicate blocking reason coverage should be rejected.",
      },
    ];

    expect(validatePatch(patch)).toMatchObject({
      accepted: false,
      reasons: expect.arrayContaining([
        'Open-item disposition coverage mismatch for blocking reason "The vendor sandbox is unavailable to the executor.": expected 1, found 2.',
        'Open-item disposition count mismatch for blocking reason "The vendor sandbox is unavailable to the executor.": expected 1, found 2.',
      ]),
    });
  });

  it("rejects extra dispositions that do not map to unanswered questions", () => {
    const patch = createPatch();
    patch.readiness = ReviewReadiness.READY_WITH_NONBLOCKING_GAPS;
    patch.unansweredQuestions = ["Can the repository be inspected locally?"];
    patch.openItemDispositions = [
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "Can the repository be inspected locally?",
        owner: ReviewOpenItemOwner.IMPLEMENTATION_DISCOVERY,
        rationale: "A bounded repository inspection is part of implementation.",
      },
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "Unused disposition",
        owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
        rationale: "This item does not belong to unansweredQuestions.",
      },
    ];

    expect(validatePatch(patch)).toMatchObject({
      accepted: false,
      reasons: expect.arrayContaining([
        'Open-item disposition references text not present in unansweredQuestions: "Unused disposition".',
      ]),
    });
  });

  it("rejects extra blocker dispositions that do not map to blocking reasons", () => {
    const patch = createPatch();
    patch.readiness = ReviewReadiness.BLOCKED;
    patch.unansweredQuestions = ["When will the vendor sandbox become reachable again?"];
    patch.blockingReasons = ["The vendor sandbox is unavailable to the executor."];
    patch.openItemDispositions = [
      {
        kind: ReviewOpenItemKind.BLOCKING_REASON,
        text: "The vendor sandbox is unavailable to the executor.",
        owner: ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
        rationale: "The executor cannot unblock the vendor sandbox.",
      },
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "When will the vendor sandbox become reachable again?",
        owner: ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
        rationale: "The executor cannot unblock the vendor sandbox.",
      },
      {
        kind: ReviewOpenItemKind.BLOCKING_REASON,
        text: "Unused blocker",
        owner: ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
        rationale: "This blocker does not belong to blockingReasons.",
      },
    ];

    expect(validatePatch(patch)).toMatchObject({
      accepted: false,
      reasons: expect.arrayContaining([
        'Open-item disposition references text not present in blockingReasons: "Unused blocker".',
      ]),
    });
  });

  it("requires HUMAN dispositions to request approval", () => {
    const patch = createPatch();
    patch.readiness = ReviewReadiness.BLOCKED;
    patch.unansweredQuestions = ["Which compatibility promise is required?"];
    patch.blockingReasons = ["The product owner must choose the compatibility promise."];
    patch.openItemDispositions = [
      {
        kind: ReviewOpenItemKind.BLOCKING_REASON,
        text: "The product owner must choose the compatibility promise.",
        owner: ReviewOpenItemOwner.HUMAN,
        rationale: "Only a human owner can decide the product promise.",
      },
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "Which compatibility promise is required?",
        owner: ReviewOpenItemOwner.HUMAN,
        rationale: "Only a human owner can decide the product promise.",
      },
    ];

    expect(validatePatch(patch)).toMatchObject({
      accepted: false,
      requiresHumanApproval: true,
      reasons: expect.arrayContaining([
        "Patches with HUMAN open items must require human approval.",
        "requiresHumanApproval must be true when HUMAN open items or material scope change exist.",
      ]),
    });
  });

  it("accepts blocked external dependencies without requiring human approval", () => {
    const patch = createPatch();
    patch.readiness = ReviewReadiness.BLOCKED;
    patch.unansweredQuestions = ["When will the vendor sandbox become reachable again?"];
    patch.blockingReasons = ["The vendor sandbox is unavailable to the executor."];
    patch.openItemDispositions = [
      {
        kind: ReviewOpenItemKind.BLOCKING_REASON,
        text: "The vendor sandbox is unavailable to the executor.",
        owner: ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
        rationale: "The executor cannot unblock the vendor sandbox.",
      },
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "When will the vendor sandbox become reachable again?",
        owner: ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
        rationale: "The executor cannot unblock the vendor sandbox.",
      },
    ];

    expect(validatePatch(patch)).toMatchObject({
      accepted: true,
      requiresHumanApproval: false,
      reasons: [],
    });
  });

  it("rejects blocked executor-preflight items that should be external dependencies", () => {
    const patch = createPatch();
    patch.readiness = ReviewReadiness.BLOCKED;
    patch.unansweredQuestions = ["When will the vendor sandbox become reachable again?"];
    patch.blockingReasons = ["The vendor sandbox is unavailable to the executor."];
    patch.openItemDispositions = [
      {
        kind: ReviewOpenItemKind.BLOCKING_REASON,
        text: "The vendor sandbox is unavailable to the executor.",
        owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
        rationale: "This misclassifies external waiting as preflight.",
      },
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "When will the vendor sandbox become reachable again?",
        owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
        rationale: "This misclassifies external waiting as preflight.",
      },
    ];

    expect(validatePatch(patch)).toMatchObject({
      accepted: false,
      requiresHumanApproval: false,
      reasons: expect.arrayContaining([
        "BLOCKED patches without human approval must classify at least one blocking reason or unanswered question as EXTERNAL_DEPENDENCY.",
        "BLOCKED patches without human approval may only use EXTERNAL_DEPENDENCY open items.",
      ]),
    });
  });

  it("rejects READY and READY_WITH_NONBLOCKING_GAPS patches that keep open items", () => {
    const readyPatch = createPatch();
    readyPatch.unansweredQuestions = ["Is the proxy runtime available in this environment?"];
    readyPatch.openItemDispositions = [
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "Is the proxy runtime available in this environment?",
        owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
        rationale: "The runtime can be verified before work starts.",
      },
    ];

    expect(validatePatch(readyPatch)).toMatchObject({
      accepted: false,
      reasons: expect.arrayContaining([
        "READY patches cannot contain blockers or unanswered questions.",
        "READY patches cannot contain open-item dispositions.",
      ]),
    });

    const nonblockingPatch = createPatch();
    nonblockingPatch.readiness = ReviewReadiness.READY_WITH_NONBLOCKING_GAPS;
    nonblockingPatch.requiresHumanApproval = true;
    nonblockingPatch.unansweredQuestions = ["Which account should own the rollout?"];
    nonblockingPatch.openItemDispositions = [
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "Which account should own the rollout?",
        owner: ReviewOpenItemOwner.HUMAN,
        rationale: "Account ownership is a product authorization decision.",
      },
    ];

    expect(validatePatch(nonblockingPatch)).toMatchObject({
      accepted: false,
      reasons: expect.arrayContaining([
        "READY_WITH_NONBLOCKING_GAPS patches cannot contain HUMAN open items.",
      ]),
    });

    const externalPatch = createPatch();
    externalPatch.readiness = ReviewReadiness.READY_WITH_NONBLOCKING_GAPS;
    externalPatch.unansweredQuestions = ["When will the vendor sandbox become reachable again?"];
    externalPatch.openItemDispositions = [
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "When will the vendor sandbox become reachable again?",
        owner: ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
        rationale: "External blockers must stay blocked.",
      },
    ];

    expect(validatePatch(externalPatch)).toMatchObject({
      accepted: false,
      reasons: expect.arrayContaining([
        "READY_WITH_NONBLOCKING_GAPS patches cannot contain EXTERNAL_DEPENDENCY open items.",
        "EXTERNAL_DEPENDENCY open items require BLOCKED readiness.",
      ]),
    });
  });

  it("backfillOpenItemDispositions prunes stale dispositions that no longer match an open item", () => {
    const patch = createPatch();
    patch.readiness = ReviewReadiness.READY_WITH_NONBLOCKING_GAPS;
    // No current unansweredQuestions/blockingReasons, but the model carried forward a stale
    // HUMAN disposition from an earlier ticket revision — this must not survive backfill.
    patch.unansweredQuestions = [];
    patch.openItemDispositions = [
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "Should the reviewer/executor operate in ~/projects/prototypes rather than the weavekit worktree?",
        owner: ReviewOpenItemOwner.HUMAN,
        rationale: "Stale disposition left over from a prior synthesis attempt.",
      },
    ];
    patch.requiresHumanApproval = true;

    const backfilled = backfillOpenItemDispositions(patch);

    expect(backfilled.openItemDispositions).toEqual([]);
    expect(backfilled.requiresHumanApproval).toBe(false);
    expect(validatePatch(backfilled)).toMatchObject({ accepted: true, reasons: [] });
  });

  it("backfillOpenItemDispositions adds missing dispositions and drops excess duplicates for the same item", () => {
    const patch = createPatch();
    patch.readiness = ReviewReadiness.READY_WITH_NONBLOCKING_GAPS;
    patch.unansweredQuestions = [
      "Is the proxy runtime available in this environment?",
      "Which runtime is pinned for the executor?",
    ];
    patch.openItemDispositions = [
      // Missing a disposition entirely for the first question.
      // Duplicated (and one stale) dispositions for the second question.
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "Which runtime is pinned for the executor?",
        owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
        rationale: "First disposition for this question.",
      },
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "Which runtime is pinned for the executor?",
        owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
        rationale: "Duplicate disposition for the same question.",
      },
    ];

    const backfilled = backfillOpenItemDispositions(patch);

    expect(backfilled.openItemDispositions).toHaveLength(2);
    expect(
      backfilled.openItemDispositions.filter(
        (disposition) => disposition.text === "Which runtime is pinned for the executor?",
      ),
    ).toHaveLength(1);
    expect(
      backfilled.openItemDispositions.filter(
        (disposition) => disposition.text === "Is the proxy runtime available in this environment?",
      ),
    ).toHaveLength(1);
    expect(validatePatch(backfilled)).toMatchObject({ accepted: true, reasons: [] });
  });
});
