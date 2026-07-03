export function buildSourceReadingPrompt(source: string, maxToolCalls = 40): string {
  return [
    "Read the Source artifact and extract claims, assumptions, evidence, and transferable lessons.",
    "Do not inspect the target project in this step.",
    "Do not ask the user for input. This is an unattended workflow run.",
    "Keep the investigation bounded: inspect the source README, docs, examples, and only the core implementation files needed to understand the loop mechanics.",
    "Do not recursively inventory the whole repository. Prefer targeted file reads over broad globbing after the initial orientation.",
    "Stop browsing once you have enough evidence for 5-8 grounded claims, even if more files could be inspected.",
    `Hard budget: use at most ${maxToolCalls} tool calls for source reading. If you reach that budget, stop using tools and write the final answer from the evidence gathered.`,
    "Return a concise research transcript with source-grounded claims, evidence references, and transferable lessons. Finish with a clear final answer.",
    `Source: ${source}`,
  ].join("\n\n");
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
    "Research the Target project in the configured working tree for this source-to-project objective.",
    "Do not produce a generic repository overview. Focus on where the Source findings could realistically apply, and where they should not apply.",
    "Keep the investigation bounded: inspect context docs, workflow/template code, and tests that directly bear on the Source findings.",
    "Do not recursively inventory the whole repository. Prefer targeted searches and file reads over broad traversal.",
    "Stop browsing once you have enough evidence for concrete change surfaces, constraints, validation commands, and non-applicability notes.",
    `Hard budget: use at most ${maxToolCalls} tool calls for target project research. If you reach that budget, stop using tools and write the final answer from the evidence gathered.`,
    "Identify architecture, constraints, goals, source-relevant change surfaces, validation commands, risks, and disqualifying evidence. Cite project files.",
    "If the Source findings do not map cleanly to the Target project, say so in the research transcript instead of forcing a fit.",
    `Original objective:\n${args.objective}`,
    args.sourceAnalysisJson ? `Source analysis so far:\n${args.sourceAnalysisJson}` : undefined,
    args.corroborationJson ? `Corroboration so far:\n${args.corroborationJson}` : undefined,
    `Project JSON:\n${args.projectJson}`,
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}

export function buildPlanPrompt(opportunityJson: string, projectJson: string, rawPlanArtifactPath?: string): string {
  return [
    "/plan",
    "Create an implementation plan for this single selected source-to-project candidate.",
    "Do not modify files. Produce a plan suitable for a later implementation harness.",
    "Return the final plan as markdown. The workflow harness will persist that markdown as the raw plan artifact.",
    rawPlanArtifactPath ? `Raw plan artifact path:\n${rawPlanArtifactPath}` : undefined,
    "The candidate has already passed selection. Do not switch to a different opportunity or bundle.",
    "The plan must explain the user-visible/project improvement before listing files, tests, or infrastructure chores.",
    `Selected candidate JSON:\n${opportunityJson}`,
    `Project JSON:\n${projectJson}`,
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}
