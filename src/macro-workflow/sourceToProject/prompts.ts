export function buildSourceReadingPrompt(source: string, maxToolCalls = 40, prefetchedSourceContent?: string): string {
  const prefetchedContent = prefetchedSourceContent?.trim();
  return [
    "Read the Source artifact and extract claims, assumptions, evidence, and transferable lessons.",
    "Do not inspect the target project in this step.",
    "Do not ask the user for input. This is an unattended workflow run.",
    prefetchedContent ? "Use the prefetched X post markdown below as the primary Source artifact." : undefined,
    prefetchedContent ? "Do not fetch, browse, or re-resolve the Source URL unless the prefetched markdown is internally inconsistent or incomplete." : undefined,
    "Keep the investigation bounded: inspect the source README, docs, examples, and only the core implementation files needed to understand the loop mechanics.",
    "Do not recursively inventory the whole repository. Prefer targeted file reads over broad globbing after the initial orientation.",
    "Stop browsing once you have enough evidence for 5-8 grounded claims, even if more files could be inspected.",
    `Hard budget: use at most ${maxToolCalls} tool calls for source reading. If you reach that budget, stop using tools and write the final answer from the evidence gathered.`,
    "Return a concise research transcript with source-grounded claims, evidence references, and transferable lessons. Finish with a clear final answer.",
    prefetchedContent ? `Source URL: ${source}` : undefined,
    prefetchedContent ? `Prefetched X post markdown:\n${prefetchedContent}` : undefined,
    `Source: ${source}`,
  ].filter((part): part is string => Boolean(part)).join("\n\n");
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
    "If the Source findings do not map cleanly to the Target project, say so in the research transcript instead of forcing a fit.",
    "Be precise about tool names vs. file formats. A local tool named 'qmd', 'mdvs', or similar is not the same as a file format or extension with the same name (e.g., Quarto Markdown .qmd files). When you encounter a tool name, confirm via file inspection whether it is a local binary/script or a file format before making claims about file types.",
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
    "IMPORTANT: Plan changes only to the target project described in the project JSON below. The target project's working tree is specified in the 'workingTree' field of the Project JSON — all planned changes must be to files at or below that path.",
    "Do not plan changes to the workflow runner, the weakekit codebase, or any other repository. Do not reference or propose changes to weakekit src/, plans/, CONTEXT.md, docs/adr, entities/, or CI configuration for the workflow runner.",
    "The target project may be a completely different type of system (e.g., a documentation vault, a Python service, a shell script collection) — respect its actual architecture and toolchain.",
    "When the opportunity involves adopting a tool or library from the source (e.g., by adding a config file or invoking its CLI), prefer that direct approach over reimplementing equivalent functionality in custom code. Only propose custom reimplementation when direct adoption is explicitly infeasible for the target project.",
    rawPlanArtifactPath ? `Raw plan artifact path:\n${rawPlanArtifactPath}` : undefined,
    "The candidate has already passed selection. Do not switch to a different opportunity or bundle.",
    "The plan must explain the user-visible/project improvement before listing files, tests, or infrastructure chores.",
    `Selected candidate JSON:\n${opportunityJson}`,
    `Project JSON:\n${projectJson}`,
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}
