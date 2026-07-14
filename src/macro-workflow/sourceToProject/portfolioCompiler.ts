import type {
  PortfolioCoverageAudit,
  PortfolioPlanDraft,
  ProjectApplicabilityMatrix,
  SourcePracticeLedger,
  SourcePracticeLedgerDraft,
} from "../../generated/baml_client/index.js";

export type RequiredCoverage = {
  practiceIds: string[];
  behaviorIds: string[];
  proofIds: string[];
  targetLayersByPracticeId: Record<string, string[]>;
};

export type OpportunityCoverageEntry = {
  id: string;
  practiceIds: string[];
  behaviorIds: string[];
  proofIds: string[];
  targetLayers: string[];
};

export type CoverageCandidate = OpportunityCoverageEntry & {
  acceptanceScore: number;
};

export type PortfolioPlanningCandidate = {
  id: string;
  kind: "opportunity" | "bundle";
  behaviorIds: string[];
  targetLayers: string[];
};

export type PortfolioPlanningRoute =
  | { kind: "direct"; reason: string }
  | { kind: "child-synthesis"; reason: string };

export type SpecializedObligation = {
  id: string;
  description: string;
};

export type SourceToProjectChangeKind =
  | "tool-integration"
  | "code-change"
  | "workflow-process"
  | "documentation";

export type PlanningApplicabilityMatrix = {
  projectId: ProjectApplicabilityMatrix["projectId"];
  assessments: Array<
    Pick<
      ProjectApplicabilityMatrix["assessments"][number],
      | "practiceId"
      | "status"
      | "applicableBehaviorIds"
      | "excludedBehaviorIds"
      | "targetLayers"
      | "contradictionEvidence"
      | "rationale"
    >
  >;
};

const SPECIALIZED_OBLIGATIONS = {
  "tool-integration": [
    obligation("tool-installation", "Use the named tool's real installation surface."),
    obligation(
      "configuration-translation",
      "Translate configuration through the tool's native format.",
    ),
    obligation(
      "compatibility-inventory",
      "Inventory scripts, plugins, rules, ignores, editor and CI compatibility.",
    ),
    obligation(
      "workflow-enforcement",
      "Enforce and validate the tool through stable project workflows.",
    ),
    obligation(
      "migration-and-cleanup",
      "Plan content or code migration, dependency cleanup, and documentation.",
    ),
    obligation("rollback", "Provide a bounded rollback or compatibility-layer path."),
  ],
  "code-change": [
    obligation(
      "layer-assignment",
      "Assign behavior to the correct domain, boundary, adapter, or persistence layer.",
    ),
    obligation(
      "behavior-contracts",
      "Specify input, output, error, compatibility, and migration contracts.",
    ),
    obligation(
      "edge-case-proof",
      "Pair evidence-named edge cases with focused and real integration proof.",
    ),
  ],
  "workflow-process": [
    obligation("trigger-and-actors", "Identify the workflow trigger and responsible actors."),
    obligation("state-and-recovery", "Specify state transitions, failure recovery, and rollback."),
    obligation("observability-and-ownership", "Define observability and operational ownership."),
    obligation(
      "process-enforcement",
      "Update the automation or operating documentation that enforces the process.",
    ),
    obligation("happy-path-and-recovery-proof", "Prove both the happy path and recovery behavior."),
  ],
  documentation: [
    obligation("audience-and-task", "Identify the audience and the decision or task enabled."),
    obligation("canonical-location", "Publish in the project's canonical documentation location."),
    obligation("stale-content-replacement", "Replace stale or conflicting material."),
    obligation(
      "documentation-retrieval-proof",
      "Check links, examples, commands, and retrieval behavior.",
    ),
  ],
} as const satisfies Record<SourceToProjectChangeKind, readonly SpecializedObligation[]>;

export function compilePracticeLedger(draft: SourcePracticeLedgerDraft): SourcePracticeLedger {
  const slugCounts = new Map<string, number>();
  const practices = draft.practices.map((practice) => {
    const baseId = `practice-${normalizePracticeSlug(practice.id)}`;
    const occurrence = (slugCounts.get(baseId) ?? 0) + 1;
    slugCounts.set(baseId, occurrence);
    const id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`;
    return {
      ...practice,
      id,
      behaviorIds: practice.requiredBehaviors.map((_, index) => `${id}/behavior-${index + 1}`),
      proofIds: practice.proofObligations.map((_, index) => `${id}/proof-${index + 1}`),
    };
  });
  return { ...draft, practices };
}

export function projectApplicabilityMatrixForPlanning(
  matrix: ProjectApplicabilityMatrix,
): PlanningApplicabilityMatrix {
  return {
    projectId: matrix.projectId,
    assessments: matrix.assessments.map((assessment) => ({
      practiceId: assessment.practiceId,
      status: assessment.status,
      applicableBehaviorIds: assessment.applicableBehaviorIds,
      excludedBehaviorIds: assessment.excludedBehaviorIds,
      targetLayers: assessment.targetLayers,
      contradictionEvidence: assessment.contradictionEvidence,
      rationale: assessment.rationale,
    })),
  };
}

export function validateApplicabilityMatrix(
  ledger: SourcePracticeLedger,
  matrix: ProjectApplicabilityMatrix,
): void {
  assertExactIds(
    matrix.assessments.map((assessment) => assessment.practiceId),
    ledger.practices.map((practice) => practice.id),
    "applicability practice ids",
  );
  for (const assessment of matrix.assessments) {
    const practice = ledger.practices.find((candidate) => candidate.id === assessment.practiceId)!;
    assertExactIds(
      [...assessment.applicableBehaviorIds, ...assessment.excludedBehaviorIds],
      practice.behaviorIds,
      `${assessment.practiceId} behavior partition`,
    );
    if (assessment.status === "applicable" && assessment.excludedBehaviorIds.length > 0) {
      throw new Error(`${assessment.practiceId} applicable assessment cannot exclude behaviors.`);
    }
    if (
      assessment.status === "partial" &&
      (assessment.applicableBehaviorIds.length === 0 || assessment.excludedBehaviorIds.length === 0)
    ) {
      throw new Error(
        `${assessment.practiceId} partial assessment requires both behavior subsets.`,
      );
    }
    if (
      assessment.status === "partial" &&
      assessment.excludedBehaviorIds.length > 0 &&
      assessment.contradictionEvidence.length === 0
    ) {
      throw new Error(
        `${assessment.practiceId} requires contradiction evidence for every partial exclusion.`,
      );
    }
    if (
      (assessment.status === "not-applicable" || assessment.status === "unknown") &&
      assessment.applicableBehaviorIds.length > 0
    ) {
      throw new Error(
        `${assessment.practiceId} ${assessment.status} assessment cannot apply behaviors.`,
      );
    }
    if (
      (assessment.status === "applicable" || assessment.status === "partial") &&
      (assessment.projectEvidence.length === 0 || assessment.targetLayers.length === 0)
    ) {
      throw new Error(`${assessment.practiceId} requires project evidence and target layers.`);
    }
    if (assessment.status === "not-applicable" && assessment.contradictionEvidence.length === 0) {
      throw new Error(`${assessment.practiceId} requires contradiction evidence for non-adoption.`);
    }
  }
}

export function requiredCoverage(
  ledger: SourcePracticeLedger,
  matrix: ProjectApplicabilityMatrix,
): RequiredCoverage {
  validateApplicabilityMatrix(ledger, matrix);
  const included = matrix.assessments.filter(
    (assessment) => assessment.status === "applicable" || assessment.status === "partial",
  );
  const practiceIds = included.map((assessment) => assessment.practiceId);
  return {
    practiceIds,
    behaviorIds: included.flatMap((assessment) => assessment.applicableBehaviorIds),
    proofIds: ledger.practices
      .filter((practice) => practiceIds.includes(practice.id))
      .flatMap((practice) => practice.proofIds),
    targetLayersByPracticeId: Object.fromEntries(
      included.map((assessment) => [assessment.practiceId, [...new Set(assessment.targetLayers)]]),
    ),
  };
}

export function validateOpportunityCoverage(
  required: RequiredCoverage,
  opportunities: OpportunityCoverageEntry[],
): void {
  assertCoverageIds(
    opportunities.flatMap((opportunity) => opportunity.behaviorIds),
    required.behaviorIds,
    "opportunity behavior coverage",
  );
  assertCoverageIds(
    opportunities.flatMap((opportunity) => opportunity.proofIds),
    required.proofIds,
    "opportunity proof coverage",
  );
  const requiredPracticeIds = new Set(required.practiceIds);
  for (const opportunity of opportunities) {
    const unknownPracticeIds = opportunity.practiceIds.filter(
      (practiceId) => !requiredPracticeIds.has(practiceId),
    );
    if (unknownPracticeIds.length > 0) {
      throw new Error(
        `${opportunity.id} references unknown practice ids: ${unknownPracticeIds.sort().join(", ")}`,
      );
    }
    if (opportunity.targetLayers.length === 0) {
      throw new Error(`${opportunity.id} requires at least one target layer.`);
    }
  }
}

export function selectCoverageCompleteCandidates<T extends CoverageCandidate>(
  requiredBehaviorIds: string[],
  candidates: T[],
): T[] {
  const uncovered = new Set(requiredBehaviorIds);
  const available = [...candidates];
  const selected: T[] = [];
  while (uncovered.size > 0) {
    const ranked = available
      .map((candidate) => ({
        candidate,
        newlyCovered: candidate.behaviorIds.filter((id) => uncovered.has(id)).length,
      }))
      .filter((entry) => entry.newlyCovered > 0)
      .sort(
        (left, right) =>
          right.newlyCovered - left.newlyCovered ||
          right.candidate.acceptanceScore - left.candidate.acceptanceScore ||
          left.candidate.id.localeCompare(right.candidate.id),
      );
    const next = ranked[0]?.candidate;
    if (!next) {
      throw new Error(
        `No candidate covers required behaviors: ${[...uncovered].sort().join(", ")}`,
      );
    }
    selected.push(next);
    for (const behaviorId of next.behaviorIds) {
      uncovered.delete(behaviorId);
    }
    available.splice(available.indexOf(next), 1);
  }
  return selected;
}

export function selectPortfolioPlanningRoute(
  candidates: PortfolioPlanningCandidate[],
): PortfolioPlanningRoute {
  if (candidates.length === 1) {
    return {
      kind: "direct",
      reason:
        candidates[0]?.kind === "bundle"
          ? "one promoted bundle covers the required behavior set"
          : "one accepted opportunity covers the required behavior set",
    };
  }
  return {
    kind: "child-synthesis",
    reason: `${candidates.length} independent accepted change surfaces require focused child plans`,
  };
}

export function specializedObligationsFor(
  changeKinds: SourceToProjectChangeKind | SourceToProjectChangeKind[],
): SpecializedObligation[] {
  const kinds = Array.isArray(changeKinds) ? changeKinds : [changeKinds];
  const seen = new Set<string>();
  return kinds.flatMap((kind) =>
    SPECIALIZED_OBLIGATIONS[kind].filter((item) => {
      if (seen.has(item.id)) {
        return false;
      }
      seen.add(item.id);
      return true;
    }),
  );
}

function obligation(id: string, description: string): SpecializedObligation {
  return { id, description };
}

export function validatePortfolioDraft(
  required: RequiredCoverage,
  draft: PortfolioPlanDraft,
): void {
  assertExactIds(
    draft.coverageClaims.map((claim) => claim.practiceId),
    required.practiceIds,
    "portfolio draft practice ids",
  );
  assertExactIds(
    draft.coverageClaims.flatMap((claim) => claim.behaviorIds),
    required.behaviorIds,
    "portfolio draft behavior ids",
  );
  assertExactIds(
    draft.coverageClaims.flatMap((claim) => claim.proofIds),
    required.proofIds,
    "portfolio draft proof ids",
  );
  for (const claim of draft.coverageClaims) {
    if (claim.targetLayers.length === 0) {
      throw new Error(`${claim.practiceId} portfolio coverage claim requires a target layer.`);
    }
    const allowedTargetLayers = required.targetLayersByPracticeId[claim.practiceId] ?? [];
    if (allowedTargetLayers.length === 0) {
      throw new Error(
        `${claim.practiceId} portfolio coverage claim has no immutable target layers.`,
      );
    }
    const unknownTargetLayers = claim.targetLayers.filter(
      (layer) => !allowedTargetLayers.includes(layer),
    );
    if (unknownTargetLayers.length > 0) {
      throw new Error(
        `${claim.practiceId} portfolio coverage claim references unknown target layers: ${unknownTargetLayers.sort().join(", ")}.`,
      );
    }
    validateExactMarkdownQuotes(draft.markdown, claim.evidenceQuotes, claim.practiceId);
  }
}

export function validatePortfolioDraftExtraction(
  required: RequiredCoverage,
  canonicalMarkdown: string,
  draft: PortfolioPlanDraft,
): void {
  if (draft.markdown !== canonicalMarkdown) {
    throw new Error("Portfolio draft markdown must match canonical plan markdown byte-for-byte.");
  }
  validatePortfolioDraft(required, draft);
}

export function groundPortfolioDraft(
  canonicalMarkdown: string,
  draft: PortfolioPlanDraft,
): { draft: PortfolioPlanDraft; changed: boolean } {
  let changed = draft.markdown !== canonicalMarkdown;
  const canonicalLines = canonicalMarkdown.split("\n").filter((line) => line.trim().length > 0);
  const coverageClaims = draft.coverageClaims.map((claim) => ({
    ...claim,
    behaviorIds: [...claim.behaviorIds],
    proofIds: [...claim.proofIds],
    targetLayers: [...claim.targetLayers],
    evidenceQuotes: claim.evidenceQuotes.map((quote) => {
      if (quote.trim() && canonicalLines.includes(quote)) {
        return quote;
      }
      const matchingLines = quote.trim()
        ? canonicalLines.filter((line) => removeOneLeadingMarkdownWrapper(line) === quote)
        : [];
      if (matchingLines.length > 1) {
        throw new Error(
          `Portfolio evidence quote ambiguously matches ${matchingLines.length} canonical markdown lines after one leading wrapper removal: ${quote}`,
        );
      }
      if (matchingLines.length === 1) {
        changed = true;
        return matchingLines[0]!;
      }
      if (quote.trim() && canonicalMarkdown.includes(quote)) {
        return quote;
      }
      return quote;
    }),
  }));
  return {
    changed,
    draft: {
      ...draft,
      markdown: canonicalMarkdown,
      coverageClaims,
    },
  };
}

export function validatePortfolioAudit(
  required: RequiredCoverage,
  obligations: SpecializedObligation[],
  draft: PortfolioPlanDraft,
  audit: PortfolioCoverageAudit,
): void {
  assertExactIds(
    audit.behaviorAssessments.map((assessment) => assessment.behaviorId),
    required.behaviorIds,
    "portfolio audit behavior ids",
  );
  assertExactIds(
    audit.specializedAssessments.map((assessment) => assessment.obligationId),
    obligations.map((obligation) => obligation.id),
    "portfolio audit obligation ids",
  );
  for (const assessment of audit.behaviorAssessments) {
    if (assessment.status === "complete") {
      validateExactMarkdownQuotes(draft.markdown, assessment.evidenceQuotes, assessment.behaviorId);
    }
  }
  for (const assessment of audit.specializedAssessments) {
    if (assessment.status === "complete") {
      validateExactMarkdownQuotes(
        draft.markdown,
        assessment.evidenceQuotes,
        assessment.obligationId,
      );
    }
  }
  const incompleteBehaviors = audit.behaviorAssessments
    .filter((assessment) => assessment.status !== "complete")
    .map((assessment) => assessment.behaviorId)
    .sort();
  const incompleteObligations = audit.specializedAssessments
    .filter(
      (assessment) => assessment.status !== "complete" && assessment.status !== "not-required",
    )
    .map((assessment) => assessment.obligationId)
    .sort();
  const failures = [
    incompleteBehaviors.length > 0
      ? `incomplete behaviors [${incompleteBehaviors.join(", ")}]`
      : undefined,
    incompleteObligations.length > 0
      ? `incomplete obligations [${incompleteObligations.join(", ")}]`
      : undefined,
    audit.unsupportedClaims.length > 0
      ? `unsupported claims [${audit.unsupportedClaims.join("; ")}]`
      : undefined,
    audit.contradictions.length > 0
      ? `contradictions [${audit.contradictions.join("; ")}]`
      : undefined,
  ].filter((failure): failure is string => Boolean(failure));
  if (failures.length > 0) {
    throw new Error(`Portfolio audit failed: ${failures.join("; ")}.`);
  }
}

function validateExactMarkdownQuotes(markdown: string, quotes: string[], label: string): void {
  if (quotes.length === 0) {
    throw new Error(`${label} requires at least one exact markdown quote.`);
  }
  for (const quote of quotes) {
    if (!quote.trim() || !markdown.includes(quote)) {
      throw new Error(`${label} evidence quote must be an exact markdown substring: ${quote}`);
    }
  }
}

function removeOneLeadingMarkdownWrapper(line: string): string | undefined {
  const leadingBoldPair = /^\*\*(.+?)\*\*(.*)$/.exec(line);
  if (leadingBoldPair) {
    return `${leadingBoldPair[1]}${leadingBoldPair[2]}`;
  }
  const taskListPrefix = /^[-*+] \[(?: |x|X)\] (.*)$/.exec(line);
  if (taskListPrefix) {
    return taskListPrefix[1];
  }
  const orderedListPrefix = /^\d+[.)] (.*)$/.exec(line);
  if (orderedListPrefix) {
    return orderedListPrefix[1];
  }
  const unorderedListPrefix = /^[-*+] (.*)$/.exec(line);
  return unorderedListPrefix?.[1];
}

function assertCoverageIds(actual: string[], expected: string[], label: string): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((id) => !actualSet.has(id)).sort();
  const unknown = [...actualSet].filter((id) => !expectedSet.has(id)).sort();
  if (missing.length === 0 && unknown.length === 0) {
    return;
  }
  throw new Error(
    `${label} mismatch: missing [${missing.join(", ")}], unknown [${unknown.join(", ")}].`,
  );
}

function assertExactIds(actual: string[], expected: string[], label: string): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((id) => !actualSet.has(id)).sort();
  const unknown = [...actualSet].filter((id) => !expectedSet.has(id)).sort();
  const duplicates = actual.filter((id, index) => actual.indexOf(id) !== index).sort();
  if (missing.length === 0 && unknown.length === 0 && duplicates.length === 0) {
    return;
  }
  throw new Error(
    `${label} mismatch: missing [${missing.join(", ")}], unknown [${unknown.join(", ")}], duplicates [${duplicates.join(", ")}].`,
  );
}

function normalizePracticeSlug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) {
    throw new Error("Practice id must contain an ASCII letter or digit.");
  }
  return normalized;
}
