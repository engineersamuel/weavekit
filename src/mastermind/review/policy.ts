import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  ProjectRepositoryMode,
  RepositoryEvidenceType,
  ReviewEvidenceKind,
  ReviewOpenItemKind,
  ReviewOpenItemOwner,
  ReviewReadiness,
  type ProposedLinearTicketPatch,
  type MastermindProjectPolicyInput,
  type TicketReviewDossier,
  type TicketReviewEvidence,
} from "../../generated/baml_client/index.js";
import type { LinearTicketSnapshot, StoredReview } from "../store/store.js";

export type TicketReviewPolicyResult = {
  accepted: boolean;
  requiresHumanApproval: boolean;
  reasons: string[];
};

type OpenItemDispositionCoverageInput = Pick<
  ProposedLinearTicketPatch,
  "blockingReasons" | "unansweredQuestions" | "openItemDispositions"
>;

type OpenItemSourceDescriptor = {
  field: "unansweredQuestions" | "blockingReasons";
  kind: ReviewOpenItemKind;
  label: "unanswered question" | "blocking reason";
};

type CountedOpenItem = OpenItemSourceDescriptor & {
  text: string;
  count: number;
};

const OPEN_ITEM_SOURCE_DESCRIPTORS = [
  {
    field: "unansweredQuestions",
    kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
    label: "unanswered question",
  },
  {
    field: "blockingReasons",
    kind: ReviewOpenItemKind.BLOCKING_REASON,
    label: "blocking reason",
  },
] as const satisfies readonly OpenItemSourceDescriptor[];

export function hashLinearTicketContent(ticket: LinearTicketSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: ticket.title,
        description: ticket.description,
        labels: ticket.labels
          .map((label) => ({ id: label.id, name: label.name }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      }),
    )
    .digest("hex");
}

export function validateTicketReviewProposal(input: {
  ticket: LinearTicketSnapshot;
  project: MastermindProjectPolicyInput;
  dossier: TicketReviewDossier;
  patch: ProposedLinearTicketPatch;
}): TicketReviewPolicyResult {
  const reasons: string[] = [];
  const { dossier, patch } = input;
  if (!patch.proposedTitle.trim()) {
    reasons.push("Proposed title is empty.");
  }
  if (!patch.proposedDescriptionMarkdown.trim()) {
    reasons.push("Proposed description is empty.");
  }
  if (patch.preservedIntent.trim() !== dossier.preservedIntent.trim()) {
    reasons.push("Proposed patch changed the preserved intent.");
  }
  if (patch.ticketKind !== dossier.ticketKind) {
    reasons.push("Proposed patch changed the harness ticket classification.");
  }
  if (patch.confidence < 0 || patch.confidence > 1) {
    reasons.push("Patch confidence must be between 0 and 1.");
  }
  if (patch.readiness === ReviewReadiness.READY) {
    if (patch.blockingReasons.length > 0 || patch.unansweredQuestions.length > 0) {
      reasons.push("READY patches cannot contain blockers or unanswered questions.");
    }
    if (patch.acceptanceCriteria.length === 0) {
      reasons.push("READY patches require acceptance criteria.");
    }
    if (patch.automatedVerification.length === 0 && patch.manualVerification.length === 0) {
      reasons.push("READY patches require a verification plan.");
    }
    if (patch.validationSteps.length === 0) {
      reasons.push("READY patches require an outcome validation plan.");
    }
  }
  if (
    patch.readiness === ReviewReadiness.READY_WITH_NONBLOCKING_GAPS &&
    patch.blockingReasons.length > 0
  ) {
    reasons.push("READY_WITH_NONBLOCKING_GAPS cannot contain blocking reasons.");
  }
  // A BLOCKED patch whose cause is already owned by a HUMAN or EXTERNAL_DEPENDENCY open item is
  // coherent even when blockingReasons is empty: the synthesizer routinely records a human-owned
  // decision only in unansweredQuestions. Rejecting that shape turned an ordinary needs-human
  // review into a failed review, so require a stated, owned cause rather than the blockingReasons
  // field specifically. validateOwnershipSemantics still rejects a BLOCKED patch with no owned
  // cause at all.
  if (
    patch.readiness === ReviewReadiness.BLOCKED &&
    patch.blockingReasons.length === 0 &&
    !patch.openItemDispositions.some(
      (disposition) =>
        disposition.owner === ReviewOpenItemOwner.HUMAN ||
        disposition.owner === ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
    )
  ) {
    reasons.push(
      "BLOCKED patches require at least one blocking reason or a HUMAN/EXTERNAL_DEPENDENCY open item.",
    );
  }
  validateOpenItemDispositions(patch, reasons);
  validateOwnershipSemantics(patch, reasons);

  const evidence = [
    ...dossier.repositoryEvidence,
    ...dossier.linearEvidence,
    ...dossier.externalEvidence,
  ];
  validateEvidence(evidence, input.project, reasons);
  const evidenceIds = new Set(evidence.map((item) => item.id));
  for (const patchEvidence of patch.evidence) {
    if (!evidenceIds.has(patchEvidence.id)) {
      reasons.push(`Patch evidence ${patchEvidence.id} was not produced by the harness.`);
    }
  }
  return {
    accepted: reasons.length === 0,
    requiresHumanApproval: patchRequiresHumanApproval(patch),
    reasons,
  };
}

export const validateTicketReviewPatch = validateTicketReviewProposal;

function validateOpenItemDispositions(patch: ProposedLinearTicketPatch, reasons: string[]): void {
  reasons.push(...findOpenItemDispositionCoverageIssues(patch));
  const humanDispositions = patch.openItemDispositions.filter(
    (disposition) => disposition.owner === ReviewOpenItemOwner.HUMAN,
  );
  const externalDependencyDispositions = patch.openItemDispositions.filter(
    (disposition) => disposition.owner === ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
  );

  if (humanDispositions.length > 0 && !patch.requiresHumanApproval) {
    reasons.push("Patches with HUMAN open items must require human approval.");
  }
  if (patch.readiness === ReviewReadiness.READY && patch.openItemDispositions.length > 0) {
    reasons.push("READY patches cannot contain open-item dispositions.");
  }
  if (
    patch.readiness === ReviewReadiness.READY_WITH_NONBLOCKING_GAPS &&
    humanDispositions.length > 0
  ) {
    reasons.push("READY_WITH_NONBLOCKING_GAPS patches cannot contain HUMAN open items.");
  }
  if (
    patch.readiness === ReviewReadiness.READY_WITH_NONBLOCKING_GAPS &&
    externalDependencyDispositions.length > 0
  ) {
    reasons.push(
      "READY_WITH_NONBLOCKING_GAPS patches cannot contain EXTERNAL_DEPENDENCY open items.",
    );
  }
  if (patch.readiness !== ReviewReadiness.BLOCKED && externalDependencyDispositions.length > 0) {
    reasons.push("EXTERNAL_DEPENDENCY open items require BLOCKED readiness.");
  }
}

export function findOpenItemDispositionCoverageIssues(
  patch: OpenItemDispositionCoverageInput,
): string[] {
  const reasons: string[] = [];
  const expectedCounts = countExpectedOpenItems(patch);
  const dispositionCounts = new Map<string, number>();

  for (const disposition of patch.openItemDispositions) {
    const descriptor = getOpenItemSourceDescriptor(disposition.kind);
    const normalizedText = normalizeOpenItemText(disposition.text);
    if (!descriptor) {
      reasons.push(
        `Open-item disposition has unsupported kind for text "${normalizedText || "<empty>"}".`,
      );
      continue;
    }
    const key = createOpenItemKey(descriptor.kind, normalizedText);
    dispositionCounts.set(key, (dispositionCounts.get(key) ?? 0) + 1);
    if (!expectedCounts.has(key)) {
      reasons.push(
        `Open-item disposition references text not present in ${descriptor.field}: "${normalizedText}".`,
      );
    }
  }

  for (const countedOpenItem of expectedCounts.values()) {
    const key = createOpenItemKey(countedOpenItem.kind, countedOpenItem.text);
    const matchingDispositions = dispositionCounts.get(key) ?? 0;
    if (matchingDispositions !== countedOpenItem.count) {
      reasons.push(
        `Open-item disposition coverage mismatch for ${countedOpenItem.label} "${countedOpenItem.text}": expected ${countedOpenItem.count}, found ${matchingDispositions}.`,
      );
    }
  }

  for (const [key, count] of dispositionCounts) {
    const countedOpenItem = expectedCounts.get(key);
    if (!countedOpenItem || count === countedOpenItem.count) {
      continue;
    }
    reasons.push(
      `Open-item disposition count mismatch for ${countedOpenItem.label} "${countedOpenItem.text}": expected ${countedOpenItem.count}, found ${count}.`,
    );
  }

  return reasons;
}

/**
 * The BAML patch synthesizer sometimes writes a blockingReasons/unansweredQuestions entry
 * without emitting the matching openItemDispositions classification it requires (a known,
 * observed model-compliance gap even after several rounds of prompt reinforcement). The
 * synthesizer can also do the reverse: emit a stale/extra disposition whose text no longer
 * appears in unansweredQuestions/blockingReasons at all — e.g. leftover classifications for
 * open items that earlier revisions of the ticket raised but the current dossier resolved,
 * carried forward from context rather than the current patch. Rather than discarding an
 * otherwise well-reasoned patch after bounded resynthesis retries fail to close either gap,
 * deterministically reconcile openItemDispositions with the patch's actual open items: drop
 * dispositions that don't reference a current open item (and any duplicate dispositions beyond
 * the item's expected count), then backfill any item still missing a disposition with a
 * conservative default owner — erring toward requiring human approval rather than silently
 * proceeding.
 */
export function backfillOpenItemDispositions(
  patch: ProposedLinearTicketPatch,
): ProposedLinearTicketPatch {
  const expectedCounts = countExpectedOpenItems(patch);
  const coveredCounts = new Map<string, number>();
  const reconciled: ProposedLinearTicketPatch["openItemDispositions"] = [];
  for (const disposition of patch.openItemDispositions) {
    const descriptor = getOpenItemSourceDescriptor(disposition.kind);
    const key = descriptor
      ? createOpenItemKey(descriptor.kind, normalizeOpenItemText(disposition.text))
      : undefined;
    const countedOpenItem = key ? expectedCounts.get(key) : undefined;
    if (!key || !countedOpenItem) {
      // Stale disposition: no current open item matches this text. Drop it rather than let it
      // fail validation with a "references text not present" error.
      continue;
    }
    const covered = coveredCounts.get(key) ?? 0;
    if (covered >= countedOpenItem.count) {
      // Excess duplicate disposition for an item that's already fully covered. Drop it.
      continue;
    }
    coveredCounts.set(key, covered + 1);
    reconciled.push(disposition);
  }

  for (const countedOpenItem of expectedCounts.values()) {
    const key = createOpenItemKey(countedOpenItem.kind, countedOpenItem.text);
    const covered = coveredCounts.get(key) ?? 0;
    const missing = countedOpenItem.count - covered;
    for (let index = 0; index < missing; index += 1) {
      reconciled.push({
        kind: countedOpenItem.kind,
        text: countedOpenItem.text,
        owner:
          patch.readiness === ReviewReadiness.READY_WITH_NONBLOCKING_GAPS
            ? ReviewOpenItemOwner.EXECUTOR_PREFLIGHT
            : ReviewOpenItemOwner.HUMAN,
        rationale:
          "Backfilled default disposition: the harness output omitted an explicit ownership classification for this item, so Mastermind defaulted to the safest available owner.",
      });
    }
  }
  if (
    reconciled.length === patch.openItemDispositions.length &&
    reconciled.every((disposition, index) => disposition === patch.openItemDispositions[index])
  ) {
    return patch;
  }
  return {
    ...patch,
    openItemDispositions: reconciled,
    requiresHumanApproval: patchRequiresHumanApproval({
      ...patch,
      openItemDispositions: reconciled,
    }),
  };
}

export function normalizePatchRequiresHumanApproval(
  patch: ProposedLinearTicketPatch,
): ProposedLinearTicketPatch {
  const expected = patchRequiresHumanApproval(patch);
  return patch.requiresHumanApproval === expected
    ? patch
    : { ...patch, requiresHumanApproval: expected };
}

/**
 * Readiness is redundant with the structured open-item fields. If the model marks a patch
 * BLOCKED but supplies no open items or approval requirement, treat the structured fields as
 * authoritative instead of failing an otherwise usable review.
 */
export function normalizeEmptyBlockedReadiness(
  patch: ProposedLinearTicketPatch,
): ProposedLinearTicketPatch {
  return patch.readiness === ReviewReadiness.BLOCKED &&
    patch.blockingReasons.length === 0 &&
    patch.unansweredQuestions.length === 0 &&
    patch.openItemDispositions.length === 0 &&
    !patch.materialScopeChange &&
    !patch.requiresHumanApproval
    ? { ...patch, readiness: ReviewReadiness.READY }
    : patch;
}

const COPILOT_CREDENTIAL_SCOPE_PATTERN =
  /(?:\bpat\b.{0,160}\bcopilot requests?\b|\bcopilot requests?\b.{0,160}\bpat\b)/iu;

/**
 * A successful gh auth probe is the standing proof for Copilot-backed execution. A model can
 * still copy a granular PAT-scope concern from the dossier into the patch even though that scope
 * cannot be checked read-only. Keep it as executor risk context, but never route it to a human.
 */
export function normalizeStandingDefaultOpenItems(
  patch: ProposedLinearTicketPatch,
): ProposedLinearTicketPatch {
  const removedOpenItems = [...patch.unansweredQuestions, ...patch.blockingReasons].filter((item) =>
    COPILOT_CREDENTIAL_SCOPE_PATTERN.test(item),
  );
  if (removedOpenItems.length === 0) {
    const proposedDescriptionMarkdown = synchronizeOpenQuestionsSection(
      patch.proposedDescriptionMarkdown,
      patch.unansweredQuestions,
    );
    return proposedDescriptionMarkdown === patch.proposedDescriptionMarkdown
      ? patch
      : { ...patch, proposedDescriptionMarkdown };
  }
  const removed = new Set(removedOpenItems.map(normalizeOpenItemText));
  const unansweredQuestions = patch.unansweredQuestions.filter(
    (item) => !removed.has(normalizeOpenItemText(item)),
  );
  const blockingReasons = patch.blockingReasons.filter(
    (item) => !removed.has(normalizeOpenItemText(item)),
  );
  const openItemDispositions = patch.openItemDispositions.filter(
    (item) => !removed.has(normalizeOpenItemText(item.text)),
  );
  const readiness =
    patch.readiness === ReviewReadiness.READY_WITH_NONBLOCKING_GAPS &&
    unansweredQuestions.length === 0 &&
    blockingReasons.length === 0 &&
    openItemDispositions.length === 0
      ? ReviewReadiness.READY
      : patch.readiness;
  const normalized = {
    ...patch,
    proposedDescriptionMarkdown: synchronizeOpenQuestionsSection(
      patch.proposedDescriptionMarkdown,
      unansweredQuestions,
    ),
    unansweredQuestions,
    blockingReasons,
    openItemDispositions,
    readiness,
    warnings: [...new Set([...patch.warnings, ...removedOpenItems])],
  };
  return {
    ...normalized,
    requiresHumanApproval: patchRequiresHumanApproval(normalized),
  };
}

function synchronizeOpenQuestionsSection(markdown: string, questions: readonly string[]): string {
  const replacement =
    questions.length > 0 ? questions.map((question) => `* ${question}`).join("\n") : "None.";
  return markdown.replace(
    /(^|\n)(## Open questions[^\n]*\n)[\s\S]*?(?=\n##[ \t]+|$)/iu,
    `$1$2\n${replacement}\n`,
  );
}

export function getStoredReviewDispositionGapReason(
  review: Pick<StoredReview, "legacyOpenItemDispositionsMissing" | "patch">,
): string | null {
  if (
    review.legacyOpenItemDispositionsMissing &&
    (review.patch.unansweredQuestions.length > 0 || review.patch.blockingReasons.length > 0)
  ) {
    return "the stored review predates open-item ownership for unanswered or blocking items";
  }
  return findOpenItemDispositionCoverageIssues(review.patch).length > 0
    ? "the stored review lacks complete open-item ownership required by the current policy"
    : null;
}

export function patchRequiresHumanApproval(
  patch: Pick<ProposedLinearTicketPatch, "materialScopeChange" | "openItemDispositions">,
): boolean {
  return (
    patch.materialScopeChange ||
    patch.openItemDispositions.some(
      (disposition) => disposition.owner === ReviewOpenItemOwner.HUMAN,
    )
  );
}

function validateOwnershipSemantics(patch: ProposedLinearTicketPatch, reasons: string[]): void {
  const expectedHumanApproval = patchRequiresHumanApproval(patch);
  const humanDispositions = patch.openItemDispositions.filter(
    (disposition) => disposition.owner === ReviewOpenItemOwner.HUMAN,
  );
  const nonExternalDispositions = patch.openItemDispositions.filter(
    (disposition) => disposition.owner !== ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
  );
  const externalDependencyDispositions = patch.openItemDispositions.filter(
    (disposition) => disposition.owner === ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
  );

  if (expectedHumanApproval && !patch.requiresHumanApproval) {
    reasons.push(
      "requiresHumanApproval must be true when HUMAN open items or material scope change exist.",
    );
  }
  if (!expectedHumanApproval && patch.requiresHumanApproval) {
    reasons.push(
      "requiresHumanApproval must be false unless HUMAN open items or material scope change exist.",
    );
  }
  if (
    patch.readiness === ReviewReadiness.BLOCKED &&
    !expectedHumanApproval &&
    externalDependencyDispositions.length === 0
  ) {
    reasons.push(
      "BLOCKED patches without human approval must classify at least one blocking reason or unanswered question as EXTERNAL_DEPENDENCY.",
    );
  }
  if (
    patch.readiness === ReviewReadiness.BLOCKED &&
    !expectedHumanApproval &&
    nonExternalDispositions.length > 0
  ) {
    reasons.push(
      "BLOCKED patches without human approval may only use EXTERNAL_DEPENDENCY open items.",
    );
  }
  if (
    patch.readiness === ReviewReadiness.BLOCKED &&
    humanDispositions.length === 0 &&
    !patch.materialScopeChange &&
    patch.openItemDispositions.length === 0
  ) {
    reasons.push(
      "BLOCKED patches without human approval cannot rely on unlabeled blockers; add EXTERNAL_DEPENDENCY ownership.",
    );
  }
}

function countNormalizedItems(items: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const normalized = normalizeOpenItemText(item);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function countExpectedOpenItems(
  patch: OpenItemDispositionCoverageInput,
): Map<string, CountedOpenItem> {
  const counts = new Map<string, CountedOpenItem>();
  for (const descriptor of OPEN_ITEM_SOURCE_DESCRIPTORS) {
    const values = countNormalizedItems(patch[descriptor.field]);
    for (const [text, count] of values) {
      counts.set(createOpenItemKey(descriptor.kind, text), {
        ...descriptor,
        text,
        count,
      });
    }
  }
  return counts;
}

function getOpenItemSourceDescriptor(
  kind: ReviewOpenItemKind | undefined,
): OpenItemSourceDescriptor | undefined {
  return OPEN_ITEM_SOURCE_DESCRIPTORS.find((descriptor) => descriptor.kind === kind);
}

function createOpenItemKey(kind: ReviewOpenItemKind, text: string): string {
  return `${kind}\u0000${text}`;
}

function normalizeOpenItemText(text: string | undefined): string {
  return typeof text === "string" ? text.trim() : "";
}

function validateEvidence(
  evidence: TicketReviewEvidence[],
  project: MastermindProjectPolicyInput,
  reasons: string[],
): void {
  const ids = new Set<string>();
  for (const item of evidence) {
    if (ids.has(item.id)) {
      reasons.push(`Duplicate evidence id: ${item.id}.`);
    }
    ids.add(item.id);
    if (item.confidence < 0 || item.confidence > 1) {
      reasons.push(`Evidence ${item.id} confidence must be between 0 and 1.`);
    }
    if (item.kind === ReviewEvidenceKind.REPOSITORY) {
      if (project.repositoryMode === ProjectRepositoryMode.GREENFIELD) {
        reasons.push(`Greenfield project evidence ${item.id} cannot reference a repository.`);
        continue;
      }
      const repositoryPath = project.repositoryPath?.trim();
      if (!repositoryPath) {
        reasons.push(`Repository evidence ${item.id} has no configured repository.`);
        continue;
      }
      const path = item.repositoryPath?.trim();
      if (!path) {
        reasons.push(`Repository evidence ${item.id} has no path.`);
        continue;
      }
      if (isAbsolute(path)) {
        reasons.push(`Repository evidence ${item.id} must use a repository-relative path.`);
        continue;
      }
      const absolutePath = resolve(repositoryPath, path);
      const pathRelativeToRepository = relative(resolve(repositoryPath), absolutePath);
      if (pathRelativeToRepository.startsWith("..") || isAbsolute(pathRelativeToRepository)) {
        reasons.push(`Repository evidence ${item.id} escapes the repository.`);
      } else if (!existsSync(absolutePath)) {
        reasons.push(`Repository evidence ${item.id} path does not exist: ${path}.`);
      } else if (!item.repositoryEvidenceType) {
        reasons.push(`Repository evidence ${item.id} has no evidence type.`);
      } else if (
        item.repositoryEvidenceType === RepositoryEvidenceType.SEARCH &&
        !item.repositoryQuery?.trim()
      ) {
        reasons.push(`Repository search evidence ${item.id} has no query.`);
      } else if (
        item.repositoryEvidenceType === RepositoryEvidenceType.SYMBOL &&
        !item.repositorySymbol?.trim()
      ) {
        reasons.push(`Repository symbol evidence ${item.id} has no symbol.`);
      }
    }
    if (item.kind === ReviewEvidenceKind.LINEAR && !item.locator?.trim()) {
      reasons.push(`Linear evidence ${item.id} has no locator.`);
    }
    if (item.kind === ReviewEvidenceKind.EXTERNAL) {
      try {
        const url = new URL(item.locator?.split(/\s+/u)[0] ?? "");
        if (url.protocol !== "https:") {
          reasons.push(`External evidence ${item.id} must use HTTPS.`);
        }
      } catch {
        reasons.push(`External evidence ${item.id} has an invalid URL.`);
      }
    }
  }
}
