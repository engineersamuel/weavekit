export function buildSourceReadingPrompt(
  source: string,
  maxToolCalls = 40,
  prefetchedSourceContent?: string,
): string {
  const prefetchedContent = prefetchedSourceContent?.trim();
  return [
    "Read the Source artifact and extract claims, assumptions, evidence, and transferable lessons.",
    "Do not inspect the target project in this step.",
    "Do not ask the user for input. This is an unattended workflow run.",
    prefetchedContent
      ? "Use the prefetched X post markdown below as the primary Source artifact."
      : undefined,
    prefetchedContent
      ? "Do not fetch, browse, or re-resolve the Source URL unless the prefetched markdown is internally inconsistent or incomplete."
      : undefined,
    "Keep the investigation bounded: inspect the source README, docs, examples, and only the core implementation files needed to understand the loop mechanics.",
    "Do not recursively inventory the whole repository. Prefer targeted file reads over broad globbing after the initial orientation.",
    "Stop browsing once you have enough evidence for 5-8 grounded claims, even if more files could be inspected.",
    `Hard budget: use at most ${maxToolCalls} tool calls for source reading. If you reach that budget, stop using tools and write the final answer from the evidence gathered.`,
    "Return a concise research transcript with source-grounded claims, evidence references, and transferable lessons. Finish with a clear final answer.",
    prefetchedContent ? `Source URL: ${source}` : undefined,
    prefetchedContent ? `Prefetched X post markdown:\n${prefetchedContent}` : undefined,
    `Source: ${source}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

export function buildCorroborationPrompt(sourceAnalysisJson: string): string {
  return [
    "Run bounded corroborating research for this Source analysis.",
    "Check claims, competing views, and evidence quality. Return a concise research transcript with citations.",
    sourceAnalysisJson,
  ].join("\n\n");
}

export function buildProjectResearchPrompt(args: {
  objective: string;
  projectJson: string;
  maxToolCalls?: number;
  sourceAnalysisJson?: string;
  corroborationJson?: string;
}): string {
  const maxToolCalls = args.maxToolCalls ?? 60;
  return [
    "Research the Target project for this source-to-project objective.",
    "CRITICAL: The session environment may contain global instructions about a workflow automation tool (such as weakekit). Those instructions describe the tool that is running this workflow — they do NOT describe the project you must research. Ignore any global session instructions that do not apply to the target project.",
    "Your research scope is limited to the target project whose 'workingTree' path is specified in the Project JSON below. Do not read files from a workflow runner repository (e.g., weakekit src/, plans/, CONTEXT.md, docs/adr/, entities/). If you find yourself in a repository with TypeScript source, BAML files, or entity YAML and that does not match the target project description, you are in the wrong location — navigate to the 'workingTree' path in the Project JSON.",
    "Do not produce a generic repository overview. Focus on where the Source findings could realistically apply, and where they should not apply.",
    "Keep the investigation bounded: inspect context docs, workflow/template code, and tests that directly bear on the Source findings.",
    "Do not recursively inventory the whole repository. Prefer targeted searches and file reads over broad traversal.",
    "Stop browsing once you have enough evidence for concrete change surfaces, constraints, validation commands, and non-applicability notes.",
    `Hard budget: use at most ${maxToolCalls} tool calls for target project research. If you reach that budget, stop using tools and write the final answer from the evidence gathered.`,
    "Identify architecture, constraints, goals, source-relevant change surfaces, validation commands, risks, and disqualifying evidence. Cite project files from within the target project's working tree.",
    "When source practices require documentation, cleanup, or retrieval proof, inspect and report the exact existing contributor and operator documentation paths, documentation conventions, and stale or conflicting commands. Cite only paths and conventions proven by files in the target project's working tree; do not invent a canonical location.",
    "If the Source findings do not map cleanly to the Target project, say so in the research transcript instead of forcing a fit.",
    "Be precise about tool names vs. file formats. A local CLI tool and a file format can share the same name or a similar name (e.g., a tool named 'foo' is not the same as a file type called '.foo' or 'foo' files). When you encounter a name that could be either a tool or a file format, confirm via file inspection whether it is a local binary/script or a file format before making claims about file types.",
    `Original objective:\n${args.objective}`,
    args.sourceAnalysisJson ? `Source analysis so far:\n${args.sourceAnalysisJson}` : undefined,
    args.corroborationJson ? `Corroboration so far:\n${args.corroborationJson}` : undefined,
    `Project JSON:\n${args.projectJson}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

export function buildApplicabilityEvidenceRepairPrompt(args: {
  objective: string;
  projectJson: string;
  unresolvedPracticeIds: string[];
  initialMatrixJson: string;
  maxToolCalls: number;
}): string {
  return [
    "Investigate only these unresolved source practices in the target project.",
    "Find direct project evidence that establishes fit or contradiction. Do not broaden into a repository overview.",
    "Absence of evidence is not contradictory evidence.",
    `Hard budget: use at most ${args.maxToolCalls} tool calls.`,
    `Objective:\n${args.objective}`,
    `Project JSON:\n${args.projectJson}`,
    `Unresolved practice IDs:\n${args.unresolvedPracticeIds.join("\n")}`,
    `Initial applicability matrix:\n${args.initialMatrixJson}`,
  ].join("\n\n");
}

// Max chars of each raw transcript to include in the plan prompt.
// Large enough to capture the key source README content and project file reads,
// small enough to avoid blowing up the plan session context window.
const RAW_TRANSCRIPT_MAX_CHARS = 12_000;

function truncateTranscript(raw: string | undefined, maxChars: number): string | undefined {
  if (!raw?.trim()) return undefined;
  if (raw.length <= maxChars) return raw;
  return (
    raw.slice(0, maxChars) +
    `

[... transcript truncated at ${maxChars} chars ...]`
  );
}

export function buildPlanPrompt(
  opportunityJson: string,
  projectJson: string,
  rawPlanArtifactPath?: string,
  rawTranscripts?: { rawSourceReading?: string; rawProjectResearch?: string },
): string {
  const sourceEvidence = truncateTranscript(
    rawTranscripts?.rawSourceReading,
    RAW_TRANSCRIPT_MAX_CHARS,
  );
  const projectEvidence = truncateTranscript(
    rawTranscripts?.rawProjectResearch,
    RAW_TRANSCRIPT_MAX_CHARS,
  );
  const changeKind = readCandidateChangeKind(opportunityJson);
  const toolIntegrationGuidance =
    changeKind === "tool-integration"
      ? [
          "EXTERNAL TOOL INTEGRATION: Integrate the named external tool directly rather than recreating its behavior in custom project code.",
          "Use the tool's documented installation path, native configuration and ignore/scope mechanism, and real CLI commands. Do not invent config keys or an ignore-file format.",
          "Make the adoption complete: update the existing validation or CI workflow, identify whether existing content or code needs migration, preserve relevant behavior from the replaced tool, and include proof plus a rollback path.",
          "Keep the plan project-specific. Add only configuration, migration, documentation, and enforcement work justified by the source and target-project evidence.",
        ]
      : [];
  return [
    "/plan",
    "Create an implementation plan for this single selected source-to-project candidate.",
    "Do not modify files. Produce a plan suitable for a later implementation harness.",
    "Return the final plan as markdown. The workflow harness will persist that markdown as the raw plan artifact.",
    "IMPORTANT: Plan changes only to the target project described in the project JSON below. The target project's working tree is specified in the 'workingTree' field of the Project JSON — all planned changes must be to files at or below that path.",
    "Do not plan changes to the workflow runner, the weakekit codebase, or any other repository. Do not reference or propose changes to weakekit src/, plans/, CONTEXT.md, docs/adr, entities/, or CI configuration for the workflow runner.",
    "The target project may be a completely different type of system (e.g., a documentation vault, a Python service, a shell script collection) — respect its actual architecture and toolchain.",
    "When validation or parsing is part of the candidate, derive each input and identifier contract from current project behavior and evidence; do not leave identifier format or normalization implicit.",
    "Absence of validation is evidence of a boundary gap, not a compatibility contract to preserve, when the Source requires boundary validation. If the project generates identifiers in a canonical format, infer the canonical accepted identifier format from that producer, validate route or adapter inputs against it, and flag the stricter behavior as an intentional compatibility change.",
    "Distinguish malformed input from a well-formed but missing resource, and specify the different status/error behavior when the target project supports that distinction.",
    "For every invalid, edge, migration, or non-regression case named by the source or project evidence, include both its focused unit check and its real adapter or integration check when those layers exist.",
    "Do not collapse evidence-named invalid cases into a generic 'invalid input' test. Enumerate each named wrong type, empty or whitespace-only value, boundary length, unsupported field, unsafe coercion, malformed identifier, and missing-resource case in every applicable real adapter/integration check.",
    "When the Source or project requires repeatable test, typecheck, lint, or build commands and the project lacks them, add stable project scripts for those checks and use the scripts in the final validation commands instead of relying only on one-off package-executor commands.",
    "Perform a final coverage audit before returning the plan: every accepted source lesson and every concrete target-project defect must map to a responsible layer, an ordered implementation action, and an explicit verification case. Resolve omissions in the plan itself; do not include the audit as filler.",
    ...toolIntegrationGuidance,

    rawPlanArtifactPath ? `Raw plan artifact path:\n${rawPlanArtifactPath}` : undefined,
    "The candidate has already passed selection. Do not switch to a different opportunity or bundle.",
    "The plan must explain the user-visible/project improvement before listing files, tests, or infrastructure chores.",
    `Selected candidate JSON:\n${opportunityJson}`,
    `Project JSON:\n${projectJson}`,
    // Raw research transcripts — these give the plan agent the same grounded evidence
    // that a raw /plan run would have from reading the source and project directly.
    sourceEvidence
      ? `Source reading transcript (raw research evidence — use this for concrete tool syntax, config format, and field names):\n${sourceEvidence}`
      : undefined,
    projectEvidence
      ? `Project research transcript (raw research evidence — use this for actual file contents, validation scripts, and project structure):\n${projectEvidence}`
      : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

export type PortfolioPromptInput = {
  originalObjective: string;
  projectJson: string;
  practiceLedgerJson: string;
  applicabilityMatrixJson: string;
  requiredCoverageJson: string;
  acceptedOpportunityCoverageJson: string;
  specializedObligationsJson?: string;
};

export type PortfolioPromptDiagnostics = {
  route: "direct" | "synthesis";
  totalChars: number;
  sections: Record<string, number>;
};

export type PortfolioPromptBuildResult = {
  prompt: string;
  diagnostics: PortfolioPromptDiagnostics;
};

export type ChildPlanPromptInput = PortfolioPromptInput & {
  candidateJson: string;
  assignedBehaviorIds: string[];
  assignedProofIds: string[];
  rawPlanArtifactPath?: string;
  rawTranscripts?: { rawSourceReading?: string; rawProjectResearch?: string };
};

export function buildDirectPortfolioPlanPrompt(args: PortfolioPromptInput): string {
  return buildDirectPortfolioPlanPromptWithDiagnostics(args).prompt;
}

export function buildDirectPortfolioPlanPromptWithDiagnostics(
  args: PortfolioPromptInput,
): PortfolioPromptBuildResult {
  return buildMeasuredPortfolioPrompt("direct", {
    planningInstructions: portfolioPlanningInstructions(
      "Create one cohesive implementation plan directly from the accepted compiler coverage below.",
    ).join("\n\n"),
    routeGuidance:
      "This is the direct planning route. There are no child plans to reconstruct or summarize.",
    ...renderPortfolioCompilerContext(args, "Required behavior IDs"),
  });
}

export function buildChildPlanPrompt(args: ChildPlanPromptInput): string {
  const basePrompt = buildPlanPrompt(
    args.candidateJson,
    args.projectJson,
    args.rawPlanArtifactPath,
    args.rawTranscripts,
  );
  return [
    basePrompt,
    "This is one focused child plan within a coverage-preserving portfolio. Do not absorb behavior or proof IDs assigned to another child.",
    `Assigned behavior IDs:\n${args.assignedBehaviorIds.join("\n")}`,
    `Assigned proof IDs:\n${args.assignedProofIds.join("\n")}`,
    ...Object.values(renderPortfolioCompilerContext(args, "Full required coverage set")),
  ].join("\n\n");
}

export function buildPortfolioSynthesisPrompt(
  args: PortfolioPromptInput & {
    childPlans: Array<{ title: string; markdown: string }>;
    opportunityReviews?: Array<{
      title: string;
      status: string;
      rationale: string;
      rejectionReason?: string | null;
    }>;
  },
): string {
  return buildPortfolioSynthesisPromptWithDiagnostics(args).prompt;
}

export function buildPortfolioSynthesisPromptWithDiagnostics(
  args: PortfolioPromptInput & {
    childPlans: Array<{ title: string; markdown: string }>;
    opportunityReviews?: Array<{
      title: string;
      status: string;
      rationale: string;
      rejectionReason?: string | null;
    }>;
  },
): PortfolioPromptBuildResult {
  const childPlans = args.childPlans
    .map(
      (plan, index) =>
        `## Child plan ${index + 1}: ${plan.title}\n\n${truncateTranscript(plan.markdown, RAW_TRANSCRIPT_MAX_CHARS) ?? ""}`,
    )
    .join("\n\n---\n\n");
  return buildMeasuredPortfolioPrompt("synthesis", {
    planningInstructions: portfolioPlanningInstructions(
      "Synthesize the independent child plans into one cohesive implementation plan.",
    ).join("\n\n"),
    synthesisGuidance: [
      "Treat child plans as evidence for focused change surfaces, not as immutable deliverable boundaries. Reconcile overlap, ordering, shared contracts, and end-to-end verification; remove duplicate or conflicting work.",
      "Restore a non-selected opportunity only when direct target-project evidence and the original objective show it is required for complete compiler coverage. Do not restore weak, speculative, unrelated, or unjustifiably costly work.",
    ].join("\n\n"),
    ...renderPortfolioCompilerContext(args, "Full required coverage set"),
    ...(args.opportunityReviews?.length
      ? {
          opportunityReviewFindings: `Scoped child review findings:\n${JSON.stringify(args.opportunityReviews)}`,
        }
      : {}),
    childPlans: `Independent child plans:\n\n${childPlans}`,
  });
}

function portfolioPlanningInstructions(objective: string): string[] {
  return [
    "/plan",
    objective,
    "Do not modify files. Return only the canonical implementation plan as markdown.",
    "The current working directory is the target project's working tree. Inspect it directly when evidence leaves a file, identifier, command, or current behavior ambiguous.",
    "Plan changes only to the target project. Do not plan changes to the workflow runner or another repository.",
    "Map every required behavior and proof obligation to its responsible architectural layer, an ordered implementation action, and an explicit verification case.",
    "Preserve source-required boundary placement, output safety, migration behavior, compatibility decisions, and real adapter or integration proof.",
    "Lead with the problem and expected project value, then provide a concrete ordered implementation sequence, migration and rollback considerations, validation commands, and focused non-regression checks.",
  ];
}

function renderPortfolioCompilerContext(
  args: PortfolioPromptInput,
  coverageHeading: string,
): Record<string, string> {
  return {
    originalObjective: `Original objective:\n${args.originalObjective}`,
    targetProject: `Target project:\n${args.projectJson}`,
    practiceLedger: `Canonical source practice ledger:\n${args.practiceLedgerJson}`,
    applicabilityMatrix: `Project applicability matrix:\n${args.applicabilityMatrixJson}`,
    requiredCoverage: `${coverageHeading}:\n${args.requiredCoverageJson}`,
    acceptedOpportunityCoverage: `Accepted opportunity coverage:\n${args.acceptedOpportunityCoverageJson}`,
    ...(args.specializedObligationsJson
      ? {
          specializedObligations: `Specialized obligations:\n${args.specializedObligationsJson}`,
        }
      : {}),
  };
}

function buildMeasuredPortfolioPrompt(
  route: PortfolioPromptDiagnostics["route"],
  renderedSections: Record<string, string>,
): PortfolioPromptBuildResult {
  const prompt = Object.values(renderedSections).join("\n\n");
  return {
    prompt,
    diagnostics: {
      route,
      totalChars: prompt.length,
      sections: Object.fromEntries(
        Object.entries(renderedSections).map(([name, rendered]) => [name, rendered.length]),
      ),
    },
  };
}

export function buildPortfolioPlanPrompt(args: {
  originalObjective: string;
  projectJson: string;
  sourceAnalysisJson?: string;
  corroborationJson?: string;
  opportunityPlans: Array<{ title: string; markdown: string }>;
  opportunityReviews?: Array<{
    title: string;
    status: string;
    rationale: string;
    rejectionReason?: string | null;
  }>;
  discoveredOpportunities?: unknown[];
  opportunityDecisions?: unknown[];
}): string {
  const renderedPlans = args.opportunityPlans
    .map(
      (plan, index) =>
        `## Candidate plan ${index + 1}: ${plan.title}\n\n${truncateTranscript(plan.markdown, RAW_TRANSCRIPT_MAX_CHARS) ?? ""}`,
    )
    .join("\n\n---\n\n");
  return [
    "/plan",
    "Create one cohesive implementation plan from the accepted source-to-project opportunity plans below.",
    "Do not modify files. Return only the canonical implementation plan as markdown.",
    "The Current working directory is the target project's working tree. Inspect it directly when a candidate plan leaves a file, identifier, command, or current behavior ambiguous. The Source artifact is represented by the structured source analysis below; do not claim the target project is unavailable merely because the original objective used a relative ./project path.",
    "Treat the candidate plans as evidence and proposed slices, not as independent deliverables that must retain their original boundaries.",
    "Reconcile their file changes, contracts, sequencing, and validation into one executable vertical slice. Merge overlapping work, remove duplicate or conflicting work, and make dependencies explicit.",
    "Preserve every well-grounded source lesson that materially improves the target project. Do not omit a required behavior merely because one candidate called it out-of-scope.",
    "Build a requirement ledger before drafting: for every source requirement, record the exact target-project evidence, its responsible architectural layer, the concrete plan action, and the proof that will verify it. Use the ledger to check coverage, then present a cohesive plan rather than a verbose audit dump.",
    "For every retained requirement, preserve its responsible architectural layer. Do not move an ingress-boundary rule into domain logic, an output-safety rule into input validation, or an adapter/integration proof into a unit-only check. Domain invariants may be defended in depth, but that must not replace the source-required boundary behavior.",
    "When source or project evidence names invalid, edge, migration, and non-regression behavior, enumerate every invalid, edge, migration, and non-regression case in the relevant unit and real adapter/integration tests. Preserve exact demonstrated defects such as unsafe coercions or malformed-versus-missing identifier behavior instead of generalizing them away.",
    "Use opportunity review findings as corrective evidence. Resolve each grounded criticism in the canonical plan; do not blindly inherit a child's rejection when it only complains that a deliberately scoped child omitted another portfolio slice.",
    "Review the complete discovered-opportunity set as a coverage check. Restore a non-selected opportunity only when direct target-project evidence and the original objective show it is required for a coherent end-to-end improvement. Do not restore weak, speculative, unrelated, or unjustifiably costly work.",
    "Stay within the target project and its existing architecture. Reject unrelated infrastructure or process work that is not required to deliver or prove the improvement.",
    "Lead with the problem and expected project value. Then give an ordered implementation sequence with concrete files or modules, behavioral and data/error contracts, migration or compatibility considerations, validation commands, and focused non-regression checks.",
    "Keep the result concise enough for an implementation agent to follow. Do not repeat background, generic best practices, tool boilerplate, or one risk/validation section per candidate.",
    `Original objective:\n${args.originalObjective}`,
    args.sourceAnalysisJson
      ? `Source analysis and requirement evidence:\n${args.sourceAnalysisJson}`
      : undefined,
    args.corroborationJson
      ? `Corroboration and competing views:\n${args.corroborationJson}`
      : undefined,
    `Target project:\n${args.projectJson}`,
    args.discoveredOpportunities
      ? `All discovered opportunities:\n${JSON.stringify(args.discoveredOpportunities)}`
      : undefined,
    args.opportunityDecisions
      ? `Opportunity acceptance decisions:\n${JSON.stringify(args.opportunityDecisions)}`
      : undefined,
    args.opportunityReviews?.length
      ? `Scoped opportunity review findings:\n${JSON.stringify(args.opportunityReviews)}`
      : undefined,
    `Accepted opportunity plans:\n\n${renderedPlans}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function readCandidateChangeKind(opportunityJson: string): string | undefined {
  try {
    const candidate = JSON.parse(opportunityJson) as { changeKind?: unknown };
    return typeof candidate.changeKind === "string" ? candidate.changeKind : undefined;
  } catch {
    return undefined;
  }
}
