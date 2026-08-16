import type {
  MastermindProjectPolicyInput,
  TicketReviewDossier,
} from "../../generated/baml_client/index.js";
import type { MastermindDecisionProvider } from "../decision/bamlAdapters.js";
import type { LinearGateway } from "../linear/client.js";
import { postClarificationComment } from "../review/clarification.js";
import type { TicketReviewHarness } from "../review/harness.js";
import {
  backfillOpenItemDispositions,
  findOpenItemDispositionCoverageIssues,
  getStoredReviewDispositionGapReason,
  hashLinearTicketContent,
  normalizeEmptyBlockedReadiness,
  normalizePatchRequiresHumanApproval,
  normalizeStandingDefaultOpenItems,
  validateTicketReviewPatch,
} from "../review/policy.js";
import type { LinearTicketSnapshot, MastermindStore, StoredReview } from "../store/store.js";
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

export async function generateReviewProposal(args: {
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
}): Promise<StoredReview> {
  const pending = await args.store.getLatestReview(args.workId);
  if (pending && !pending.labelApplied) {
    const pendingDispositionGapReason = getStoredReviewDispositionGapReason(pending);
    if (pendingDispositionGapReason) {
      await args.assertLease?.();
      await args.store.invalidateReview(
        pending.id,
        `Stored pending review ${pending.id} requires regeneration: ${pendingDispositionGapReason}.`,
      );
    } else {
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
  }
  const bamlTicket = toBamlTicket(args.reviewTicket ?? args.ticket);
  args.onProgress?.("Frontier harness is inspecting repository evidence.");
  let dossier = await args.harness.review({
    ticket: bamlTicket,
    project: args.project,
  });
  let project = (await args.resolveProject?.(dossier)) ?? args.project;
  if (project.id !== args.project.id) {
    dossier = await args.harness.review({
      ticket: bamlTicket,
      project,
    });
    project = (await args.resolveProject?.(dossier)) ?? project;
  }
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
  patch = normalizeEmptyBlockedReadiness(patch);
  // requiresHumanApproval is fully derivable from openItemDispositions/materialScopeChange, but
  // the model doesn't always keep its self-reported value in sync — normalize it deterministically
  // rather than retrying purely on this class of self-consistency slip.
  patch = normalizePatchRequiresHumanApproval(patch);
  await args.assertLease?.();
  const review = await args.store.saveReviewProposal(
    args.workId,
    args.ticket,
    hashLinearTicketContent(args.ticket),
    dossier,
    patch,
  );
  const validation = await withMastermindSpan(
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
  args.onProgress?.("Deterministic review policy gates complete.");
  await args.assertLease?.();
  await args.store.saveReviewValidation(review.id, validation);
  return { ...review, validation };
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

export async function applyReviewProposal(args: {
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
}): Promise<{
  applied: boolean;
  requiresHumanApproval: boolean;
  failed: boolean;
  failureReasons?: string[];
  stale: boolean;
}> {
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

async function applyReviewProposalWithinSpan(args: {
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
}): Promise<{
  applied: boolean;
  requiresHumanApproval: boolean;
  failed: boolean;
  failureReasons?: string[];
  stale: boolean;
}> {
  const staleReviewReason = (reason: string) =>
    `Linear issue ${args.issueId} changed after ${reason}.`;
  let appliedSnapshot = args.review.appliedSnapshot;

  if (!args.review.validation?.accepted) {
    if (args.statusLabelIds.failed) {
      await args.assertLease?.();
      await args.linear.replaceIssueLabels(args.issueId, {
        remove: [
          args.statusLabelIds.reviewed,
          args.statusLabelIds.ready,
          args.statusLabelIds.failed,
          args.statusLabelIds.needsInput,
        ].filter((value): value is string => Boolean(value)),
        add: [args.statusLabelIds.failed],
      });
      await args.store.markReviewLabelApplied(args.review.id);
      await args.store.saveReviewAppliedSnapshot(
        args.review.id,
        await args.linear.fetchIssue(args.issueId),
      );
    }
    return {
      applied: false,
      requiresHumanApproval: false,
      failed: true,
      failureReasons: args.review.validation?.reasons ?? ["Review policy rejected the proposal."],
      stale: false,
    };
  }
  if (args.review.validation.requiresHumanApproval) {
    if (args.statusLabelIds.needsInput) {
      await args.assertLease?.();
      await args.linear.replaceIssueLabels(args.issueId, {
        remove: [
          args.statusLabelIds.reviewed,
          args.statusLabelIds.ready,
          args.statusLabelIds.failed,
        ].filter((value): value is string => Boolean(value)),
        add: [args.statusLabelIds.needsInput],
      });
      await args.store.markReviewLabelApplied(args.review.id);
      await args.store.saveReviewAppliedSnapshot(
        args.review.id,
        await args.linear.fetchIssue(args.issueId),
      );
    }
    await postClarificationComment(args.linear, args.issueId, args.review);
    return {
      applied: false,
      requiresHumanApproval: true,
      failed: false,
      stale: false,
    };
  }
  if (!args.review.contentApplied) {
    const current = await args.linear.fetchIssue(args.issueId);
    if (hashLinearTicketContent(current) !== args.review.originalContentHash) {
      await args.assertLease?.();
      await args.store.invalidateReview(args.review.id, staleReviewReason("review"));
      return {
        applied: false,
        requiresHumanApproval: false,
        failed: false,
        stale: true,
      };
    }
    await args.assertLease?.();
    await args.linear.updateIssueContent(args.issueId, {
      title: args.review.patch.proposedTitle,
      description: args.review.patch.proposedDescriptionMarkdown,
    });
    await args.store.markReviewContentApplied(args.review.id);
    appliedSnapshot = await args.linear.fetchIssue(args.issueId);
    await args.store.saveReviewAppliedSnapshot(args.review.id, appliedSnapshot);
  }
  if (!args.review.labelApplied) {
    const current = await args.linear.fetchIssue(args.issueId);
    if (
      !appliedSnapshot ||
      hashLinearTicketContent(current) !== hashLinearTicketContent(appliedSnapshot)
    ) {
      await args.assertLease?.();
      await args.store.invalidateReview(
        args.review.id,
        staleReviewReason("review content was applied but before reviewed labels were finalized"),
      );
      return {
        applied: false,
        requiresHumanApproval: false,
        failed: false,
        stale: true,
      };
    }
    await args.assertLease?.();
    await args.linear.replaceIssueLabels(args.issueId, {
      remove: [
        args.statusLabelIds.ready,
        args.statusLabelIds.needsInput,
        args.statusLabelIds.failed,
      ].filter((value): value is string => Boolean(value)),
      add: [
        args.statusLabelIds.reviewed,
        args.review.patch.readiness === "READY" ? args.statusLabelIds.ready : undefined,
      ].filter((value): value is string => Boolean(value)),
    });
    await args.store.markReviewLabelApplied(args.review.id);
  }
  const finalAppliedSnapshot = await args.linear.fetchIssue(args.issueId);
  await args.assertLease?.();
  await args.store.saveReviewAppliedSnapshot(args.review.id, finalAppliedSnapshot);
  return {
    applied: true,
    requiresHumanApproval: false,
    failed: false,
    stale: false,
  };
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
