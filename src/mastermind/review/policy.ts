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
  if (patch.readiness === ReviewReadiness.BLOCKED && patch.blockingReasons.length === 0) {
    reasons.push("BLOCKED patches require at least one blocking reason.");
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
