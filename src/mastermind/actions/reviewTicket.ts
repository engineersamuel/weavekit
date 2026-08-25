import type {
  MastermindProjectPolicyInput,
  ProposedLinearTicketPatch,
  TicketReviewDossier,
} from "../../generated/baml_client/index.js";
import type { MastermindDecisionProvider } from "../decision/bamlAdapters.js";
import type { LinearGateway } from "../linear/client.js";
import {
  findReviewedHumanCommentChange,
  postClarificationComment,
} from "../review/clarification.js";
import type { TicketReviewHarness } from "../review/harness.js";
import {
  backfillOpenItemDispositions,
  findOpenItemDispositionCoverageIssues,
  getStoredReviewRegenerationReason,
  hashLinearTicketContent,
  normalizeBlockingOpenItemReadiness,
  normalizeEmptyBlockedReadiness,
  normalizePatchRequiresHumanApproval,
  normalizeStandingDefaultOpenItems,
  validateTicketReviewPatch,
} from "../review/policy.js";
import type {
  LinearTicketSnapshot,
  MastermindStore,
  ReviewedHumanComment,
  StoredReview,
} from "../store/store.js";
import {
  setMastermindSpanInput,
  setMastermindSpanOutput,
  withMastermindSpan,
} from "../telemetry.js";

// Open-item disposition coverage gaps are a known, retryable model-compliance failure mode
// (the model omits an openItemDispositions entry for a blockingReasons/unansweredQuestions
// string it already wrote) rather than a fundamental review defect, so bound a small number of
// resynthesis attempts before giving up and recording the failure.
const MAX_DISPOSITION_COVERAGE_RETRIES = 2;

type GenerateReviewProposalArgs = {
  workId: string;
  ticket: LinearTicketSnapshot;
  /**
   * Optional ticket variant used only for the harness/BAML calls (e.g. augmented with recent
   * human Linear comments for clarification context). Defaults to `ticket`. Never used for
   * storage or content-hash/staleness comparisons — those always use `ticket` verbatim.
   */
  reviewTicket?: LinearTicketSnapshot;
  project: MastermindProjectPolicyInput;
  harness: TicketReviewHarness;
  decisions: MastermindDecisionProvider;
  store: MastermindStore;
  resolveProject?: (
    dossier: TicketReviewDossier,
  ) => Promise<MastermindProjectPolicyInput> | MastermindProjectPolicyInput;
  assertLease?: () => Promise<void>;
  onProgress?: (message: string) => void;
  reviewedHumanComments?: ReviewedHumanComment[];
};

type ApplyReviewProposalArgs = {
  issueId: string;
  review: StoredReview;
  statusLabelIds: {
    reviewed: string;
    ready?: string;
    needsInput?: string;
    failed?: string;
  };
  linear: LinearGateway;
  store: MastermindStore;
  assertLease?: () => Promise<void>;
};

type ApplyReviewProposalResult = {
  applied: boolean;
  requiresHumanApproval: boolean;
  failed: boolean;
  failureReasons?: string[];
  stale: boolean;
};

export async function generateReviewProposal(
  args: GenerateReviewProposalArgs,
): Promise<StoredReview> {
  const pendingReview = await reusePendingReview(args);
  if (pendingReview) return pendingReview;
  const bamlTicket = toBamlTicket(args.reviewTicket ?? args.ticket);
  const { dossier, project } = await collectReviewEvidence(args, bamlTicket);
  const patch = await synthesizeNormalizedPatch(args, bamlTicket, project, dossier);
  await args.assertLease?.();
  const review = await args.store.saveReviewProposal(
    args.workId,
    args.ticket,
    hashLinearTicketContent(args.ticket),
    dossier,
    patch,
    args.reviewedHumanComments,
  );
  const validation = await validateGeneratedReview(args, project, dossier, patch);
  args.onProgress?.("Deterministic review policy gates complete.");
  await args.assertLease?.();
  await args.store.saveReviewValidation(review.id, validation);
  return { ...review, validation };
}

async function reusePendingReview(
  args: GenerateReviewProposalArgs,
): Promise<StoredReview | undefined> {
  const pending = await args.store.getLatestReview(args.workId);
  if (!pending || pending.labelApplied) return undefined;
  const regenerationReason = getStoredReviewRegenerationReason(pending);
  if (regenerationReason) {
    await args.assertLease?.();
    await args.store.invalidateReview(
      pending.id,
      `Stored pending review ${pending.id} requires regeneration: ${regenerationReason}.`,
    );
    return undefined;
  }
  const validation = validateTicketReviewPatch({
    ticket: pending.originalSnapshot,
    project: args.project,
    dossier: pending.dossier,
    patch: pending.patch,
  });
  if (!storedValidationMatches(pending, validation)) {
    await args.assertLease?.();
    await args.store.saveReviewValidation(pending.id, validation);
  }
  return { ...pending, validation };
}

async function collectReviewEvidence(
  args: GenerateReviewProposalArgs,
  bamlTicket: ReturnType<typeof toBamlTicket>,
): Promise<{ dossier: TicketReviewDossier; project: MastermindProjectPolicyInput }> {
  args.onProgress?.("Frontier harness is inspecting repository evidence.");
  const attachments = (args.reviewTicket ?? args.ticket).attachments;
  let dossier = await args.harness.review({
    ticket: bamlTicket,
    project: args.project,
    ...(attachments ? { attachments } : {}),
  });
  let project = (await args.resolveProject?.(dossier)) ?? args.project;
  if (project.id !== args.project.id) {
    dossier = await args.harness.review({
      ticket: bamlTicket,
      project,
      ...(attachments ? { attachments } : {}),
    });
    project = (await args.resolveProject?.(dossier)) ?? project;
  }
  return { dossier, project };
}

async function synthesizeNormalizedPatch(
  args: GenerateReviewProposalArgs,
  bamlTicket: ReturnType<typeof toBamlTicket>,
  project: MastermindProjectPolicyInput,
  dossier: TicketReviewDossier,
): Promise<ProposedLinearTicketPatch> {
  args.onProgress?.("Evidence dossier complete; BAML is synthesizing the ticket patch.");
  let patch = await args.decisions.synthesizeTicketPatch(bamlTicket, project, dossier);
  for (
    let attempt = 0;
    attempt < MAX_DISPOSITION_COVERAGE_RETRIES &&
    findOpenItemDispositionCoverageIssues(patch).length > 0;
    attempt += 1
  ) {
    args.onProgress?.(
      "Open-item disposition coverage gap detected; resynthesizing the ticket patch.",
    );
    patch = await args.decisions.synthesizeTicketPatch(bamlTicket, project, dossier);
  }
  if (findOpenItemDispositionCoverageIssues(patch).length > 0) {
    args.onProgress?.(
      "Open-item disposition coverage gap persisted after retries; backfilling default dispositions.",
    );
    patch = backfillOpenItemDispositions(patch);
  }
  patch = normalizeStandingDefaultOpenItems(patch);
  patch = normalizeBlockingOpenItemReadiness(patch);
  patch = normalizeEmptyBlockedReadiness(patch);
  // requiresHumanApproval is fully derivable from openItemDispositions/materialScopeChange, but
  // the model doesn't always keep its self-reported value in sync — normalize it deterministically
  // rather than retrying purely on this class of self-consistency slip.
  return normalizePatchRequiresHumanApproval(patch);
}

async function validateGeneratedReview(
  args: GenerateReviewProposalArgs,
  project: MastermindProjectPolicyInput,
  dossier: TicketReviewDossier,
  patch: ProposedLinearTicketPatch,
): Promise<NonNullable<StoredReview["validation"]>> {
  return withMastermindSpan(
    "mastermind.review.policy_validation",
    {
      "langfuse.observation.type": "guardrail",
      "weavekit.mastermind.work_id": args.workId,
      "weavekit.mastermind.ticket.identifier": args.ticket.identifier,
    },
    async (span) => {
      setMastermindSpanInput(span, {
        ticket: args.ticket,
        project,
        dossier,
        patch,
      });
      const result = validateTicketReviewPatch({
        ticket: args.ticket,
        project,
        dossier,
        patch,
      });
      setMastermindSpanOutput(span, result);
      return result;
    },
  );
}

function storedValidationMatches(
  review: Pick<StoredReview, "validation">,
  validation: NonNullable<StoredReview["validation"]>,
): boolean {
  return (
    review.validation?.accepted === validation.accepted &&
    review.validation?.requiresHumanApproval === validation.requiresHumanApproval &&
    review.validation?.reasons.length === validation.reasons.length &&
    review.validation?.reasons.every((reason, index) => reason === validation.reasons[index])
  );
}

export async function applyReviewProposal(
  args: ApplyReviewProposalArgs,
): Promise<ApplyReviewProposalResult> {
  return withMastermindSpan(
    "mastermind.review.apply_proposal",
    {
      "langfuse.observation.type": "chain",
      "weavekit.mastermind.issue_id": args.issueId,
      "weavekit.mastermind.review_id": args.review.id,
    },
    async (span) => {
      setMastermindSpanInput(span, {
        issueId: args.issueId,
        reviewId: args.review.id,
        validation: args.review.validation,
      });
      const result = await applyReviewProposalWithinSpan(args);
      setMastermindSpanOutput(span, result);
      return result;
    },
  );
}

async function applyReviewProposalWithinSpan(
  args: ApplyReviewProposalArgs,
): Promise<ApplyReviewProposalResult> {
  if (!(await reviewedHumanCommentsAreFresh(args))) return staleReviewResult();
  if (!args.review.validation?.accepted) {
    return applyRejectedReview(args);
  }

  async function reviewedHumanCommentsAreFresh(args: ApplyReviewProposalArgs): Promise<boolean> {
    if (
      !args.linear.listIssueComments ||
      (args.review.reviewedHumanComments === undefined &&
        args.review.reviewedHumanCommentIds === undefined)
    ) {
      return true;
    }
    const change = findReviewedHumanCommentChange(
      await args.linear.listIssueComments(args.issueId),
      args.review.reviewedHumanComments,
      args.review.reviewedHumanCommentIds,
    );
    if (!change) return true;
    await invalidateStaleReview(args, "human clarification input was captured for the review");
    return false;
  }
  if (args.review.validation.requiresHumanApproval) {
    return applyHumanReview(args);
  }
  return applyAcceptedReview(args);
}

async function applyRejectedReview(
  args: ApplyReviewProposalArgs,
): Promise<ApplyReviewProposalResult> {
  if (args.review.labelApplied && args.statusLabelIds.failed) {
    if (!(await appliedReviewIsFresh(args, args.statusLabelIds.failed))) {
      return staleReviewResult();
    }
  } else if (args.statusLabelIds.failed) {
    const applied = await applyTerminalReviewLabel(args, args.statusLabelIds.failed);
    if (!applied) return staleReviewResult();
  }
  return {
    applied: false,
    requiresHumanApproval: false,
    failed: true,
    failureReasons: args.review.validation?.reasons ?? ["Review policy rejected the proposal."],
    stale: false,
  };
}

async function applyHumanReview(args: ApplyReviewProposalArgs): Promise<ApplyReviewProposalResult> {
  if (args.review.labelApplied && args.statusLabelIds.needsInput) {
    if (!(await appliedReviewIsFresh(args, args.statusLabelIds.needsInput))) {
      return staleReviewResult();
    }
  } else if (args.statusLabelIds.needsInput) {
    const applied = await applyTerminalReviewLabel(args, args.statusLabelIds.needsInput);
    if (!applied) return staleReviewResult();
  } else if (!(await reviewInputIsFresh(args))) {
    return staleReviewResult();
  }
  await postClarificationComment(args.linear, args.issueId, args.review, {
    updateExisting: args.review.labelApplied ? "if-changed" : true,
    assertLease: args.assertLease,
  });
  return {
    applied: false,
    requiresHumanApproval: true,
    failed: false,
    stale: false,
  };
}

async function applyAcceptedReview(
  args: ApplyReviewProposalArgs,
): Promise<ApplyReviewProposalResult> {
  if (args.review.labelApplied) {
    const expectedLabelIds = acceptedReviewLabelIds(args);
    if (!(await appliedReviewIsFresh(args, ...expectedLabelIds))) return staleReviewResult();
    return appliedReviewResult();
  }
  let appliedSnapshot = args.review.appliedSnapshot;
  if (!args.review.contentApplied) {
    const contentResult = await applyReviewContent(args);
    if (contentResult.stale) return staleReviewResult();
    appliedSnapshot = contentResult.snapshot;
  }
  if (!args.review.labelApplied) {
    const labelsApplied = await applyReviewLabels(args, appliedSnapshot);
    if (!labelsApplied) return staleReviewResult();
  }
  return appliedReviewResult();
}

async function applyReviewContent(
  args: ApplyReviewProposalArgs,
): Promise<{ stale: true } | { stale: false; snapshot: LinearTicketSnapshot }> {
  const current = await args.linear.fetchIssue(args.issueId);
  const expected = {
    ...args.review.originalSnapshot,
    title: args.review.patch.proposedTitle,
    description: args.review.patch.proposedDescriptionMarkdown,
  };
  const state = getContentApplicationState(current, args.review.originalContentHash, expected);
  if (state === "stale") {
    await invalidateStaleReview(args, "review");
    return { stale: true };
  }
  if (state === "pending") {
    await args.assertLease?.();
    await args.linear.updateIssueContent(args.issueId, {
      title: args.review.patch.proposedTitle,
      description: args.review.patch.proposedDescriptionMarkdown,
    });
  }
  const snapshot = await args.linear.fetchIssue(args.issueId);
  if (hashLinearTicketContent(snapshot) !== hashLinearTicketContent(expected)) {
    await invalidateStaleReview(args, "review content was updated but before it was persisted");
    return { stale: true };
  }
  await args.assertLease?.();
  await args.store.markReviewContentApplied(args.review.id, snapshot);
  return { stale: false, snapshot };
}

function getContentApplicationState(
  current: LinearTicketSnapshot,
  originalContentHash: string,
  expected: LinearTicketSnapshot,
): "pending" | "applied" | "stale" {
  const currentHash = hashLinearTicketContent(current);
  if (currentHash === originalContentHash) return "pending";
  return currentHash === hashLinearTicketContent(expected) ? "applied" : "stale";
}

async function reviewInputIsFresh(args: ApplyReviewProposalArgs): Promise<boolean> {
  const current = await args.linear.fetchIssue(args.issueId);
  if (hashLinearTicketContent(current) === args.review.originalContentHash) return true;
  await invalidateStaleReview(args, "review");
  return false;
}

async function applyTerminalReviewLabel(
  args: ApplyReviewProposalArgs,
  targetLabelId: string,
): Promise<boolean> {
  const current = await args.linear.fetchIssue(args.issueId);
  const state = getLabelApplicationState(
    current,
    args.review.originalSnapshot,
    managedLabelIds(args),
    [targetLabelId],
  );
  if (state === "stale") {
    await invalidateStaleReview(args, "review");
    return false;
  }
  if (state === "pending") {
    await args.assertLease?.();
    await args.linear.replaceIssueLabels(args.issueId, {
      remove: managedLabelIds(args),
      add: [targetLabelId],
    });
  }
  return persistAppliedLabels(args, args.review.originalSnapshot, [targetLabelId]);
}

async function applyReviewLabels(
  args: ApplyReviewProposalArgs,
  appliedSnapshot: LinearTicketSnapshot | undefined,
): Promise<boolean> {
  if (!appliedSnapshot) {
    await invalidateStaleReview(
      args,
      "review content was applied but before reviewed labels were finalized",
    );
    return false;
  }
  const current = await args.linear.fetchIssue(args.issueId);
  const expectedLabelIds = acceptedReviewLabelIds(args);
  const state = getLabelApplicationState(
    current,
    appliedSnapshot,
    managedLabelIds(args),
    expectedLabelIds,
  );
  if (state === "stale") {
    await invalidateStaleReview(
      args,
      "review content was applied but before reviewed labels were finalized",
    );
    return false;
  }
  if (state === "pending") {
    await args.assertLease?.();
    await args.linear.replaceIssueLabels(args.issueId, {
      remove: compactLabelIds([
        args.statusLabelIds.ready,
        args.statusLabelIds.needsInput,
        args.statusLabelIds.failed,
      ]),
      add: expectedLabelIds,
    });
  }
  return persistAppliedLabels(args, appliedSnapshot, expectedLabelIds);
}

async function persistAppliedLabels(
  args: ApplyReviewProposalArgs,
  baseline: LinearTicketSnapshot,
  expectedLabelIds: string[],
): Promise<boolean> {
  const snapshot = await args.linear.fetchIssue(args.issueId);
  if (
    getLabelApplicationState(snapshot, baseline, managedLabelIds(args), expectedLabelIds) !==
    "applied"
  ) {
    await invalidateStaleReview(args, "review labels were applied but before they were persisted");
    return false;
  }
  await args.assertLease?.();
  await args.store.markReviewLabelApplied(args.review.id, snapshot);
  return true;
}

function getLabelApplicationState(
  current: LinearTicketSnapshot,
  baseline: LinearTicketSnapshot,
  managedIds: string[],
  expectedManagedIds: string[],
): "pending" | "applied" | "stale" {
  const currentManagedIds = current.labels
    .map((label) => label.id)
    .filter((id) => managedIds.includes(id))
    .sort();
  const expected = [...expectedManagedIds].sort();
  const managedLabelsMatch =
    currentManagedIds.length === expected.length &&
    currentManagedIds.every((id, index) => id === expected[index]);
  if (hashLinearTicketContent(current) === hashLinearTicketContent(baseline)) {
    return managedLabelsMatch ? "applied" : "pending";
  }
  if (!unmanagedTicketContentMatches(current, baseline, new Set(managedIds))) return "stale";
  return managedLabelsMatch ? "applied" : "stale";
}

function unmanagedTicketContentMatches(
  current: LinearTicketSnapshot,
  baseline: LinearTicketSnapshot,
  managedIds: Set<string>,
): boolean {
  const withoutManagedLabels = (ticket: LinearTicketSnapshot): LinearTicketSnapshot => ({
    ...ticket,
    labels: ticket.labels.filter((label) => !managedIds.has(label.id)),
  });
  return (
    hashLinearTicketContent(withoutManagedLabels(current)) ===
    hashLinearTicketContent(withoutManagedLabels(baseline))
  );
}

function managedLabelIds(args: ApplyReviewProposalArgs): string[] {
  return compactLabelIds([
    args.statusLabelIds.reviewed,
    args.statusLabelIds.ready,
    args.statusLabelIds.needsInput,
    args.statusLabelIds.failed,
  ]);
}

async function invalidateStaleReview(args: ApplyReviewProposalArgs, reason: string): Promise<void> {
  await args.assertLease?.();
  await args.store.invalidateReview(
    args.review.id,
    `Linear issue ${args.issueId} changed after ${reason}.`,
  );
}

async function appliedReviewIsFresh(
  args: ApplyReviewProposalArgs,
  ...expectedLabelIds: string[]
): Promise<boolean> {
  const baseline = args.review.appliedSnapshot;
  if (
    baseline &&
    getLabelApplicationState(
      await args.linear.fetchIssue(args.issueId),
      baseline,
      managedLabelIds(args),
      expectedLabelIds,
    ) === "applied"
  ) {
    return true;
  }
  await invalidateStaleReview(args, "the stored review was applied");
  return false;
}

function acceptedReviewLabelIds(args: ApplyReviewProposalArgs): string[] {
  return compactLabelIds([
    args.statusLabelIds.reviewed,
    args.review.patch.readiness === "READY" ? args.statusLabelIds.ready : undefined,
  ]);
}

function appliedReviewResult(): ApplyReviewProposalResult {
  return {
    applied: true,
    requiresHumanApproval: false,
    failed: false,
    stale: false,
  };
}

function staleReviewResult(): ApplyReviewProposalResult {
  return {
    applied: false,
    requiresHumanApproval: false,
    failed: false,
    stale: true,
  };
}

function compactLabelIds(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

export function toBamlTicket(ticket: LinearTicketSnapshot) {
  return {
    id: ticket.id,
    identifier: ticket.identifier,
    title: ticket.title,
    description: ticket.description,
    labels: ticket.labels.map((label) => label.name),
    status: ticket.status,
    projectId: ticket.projectId ?? null,
    teamId: ticket.teamId,
  };
}
