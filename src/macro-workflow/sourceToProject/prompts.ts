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
    "Be precise about tool names vs. file formats. A local CLI tool and a file format can share the same name (e.g., a tool named 'mdvs' is not the same as a file type called '.mdvs'). When you encounter a name that could be either a tool or a file format, confirm via file inspection whether it is a local binary/script or a file format before making claims about file types.",
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

    // Tool integration completeness
    "TOOL INTEGRATION COMPLETENESS: When integrating an external tool that scans or validates files, the plan must be atomic and complete — do not defer automated enforcement to a future phase. A complete tool integration includes ALL of the following in the same plan: (1) the tool's config file at the project root unless the tool explicitly documents non-root placement; (2) an ignore file (e.g., .mdvsignore) and a .gitignore entry for the tool's output directory to exclude generated, private, or out-of-scope content; (3) wiring the tool's check/validate command into any existing health-check, validation, or CI script that already runs checks for the project; (4) updating relevant documentation to record the new tool's role.",
    "Do NOT produce a plan that creates only a config file and defers health-check or script integration. 'Scripts are out of scope' or 'health-check will be added later' is NOT an acceptable plan boundary. The automated enforcement wiring is the most important part of the plan — without it, the config file has no effect on the project's validation workflow.",

    // Config file placement
    "CONFIG FILE PLACEMENT: Tool config files (mdvs.toml, .eslintrc, pyproject.toml sections, etc.) belong at the project root by default. Only place a config file in a subdirectory if the tool's own documentation explicitly supports subdirectory config AND root placement would cause problems. When unsure, default to project root.",

    // Phase 1 scope conservatism with enumerated exclusion categories
    "PHASE 1 SCOPE CONSERVATISM: For Phase 1 / initial integration, be conservative about what the tool scans. The ignore file or exclusion config must enumerate exclusions by these five categories — mapped to the target project's actual paths: (1) TOOL OUTPUT: the tool's own generated output directory (e.g., .eslintcache, __pycache__, a .toolname/ cache dir); (2) EDITOR/IDE: editor and IDE config directories (e.g., .idea/, .vscode/, .cache/); (3) PRIVATE/RESTRICTED: directories containing private, sensitive, or access-controlled content; (4) RAW/UNPROCESSED SOURCES: directories of raw input material not yet normalized to the project's format (e.g., imported documents, raw downloads, staging areas); (5) AUTO-GENERATED: files and indexes generated by other tools that are not hand-authored (generated docs, build artifacts, lock files, log files). Do not leave the ignore file blank or minimal — enumerate explicit exclusion entries for each category above. Expanding scope to riskier content categories is a Phase 2 concern.",

    // Schema contract completeness
    "SCHEMA CONTRACT: When integrating a tool that enforces a schema, config, or structural contract on project files (e.g., a linter, validator, type-checker, or frontmatter validator), the plan must define a concrete initial schema — not leave required fields as TBD. The schema section of the plan must include: (1) the universal required fields/rules that apply to ALL included files; (2) any path-scoped or pattern-scoped rules that apply only to specific directories or file types; (3) at least one concrete example of a compliant input and one example of a non-compliant input that the tool would reject. A schema section that says 'define rules later' or 'TBD' is not actionable.",

    // Advisory-to-enforcement promotion path
    "ADVISORY-TO-ENFORCEMENT PATH: Starting with advisory/non-blocking mode is good practice for initial rollout — but the plan must also define a concrete promotion path. Include: (1) the criteria or observable threshold for when the tool's exit code should be promoted to a blocking check in CI, health-checks, or pre-commit hooks (e.g., 'after first clean advisory run with fewer than N violations'); (2) what the promoted blocking invocation looks like. A plan that says 'always run in advisory mode' or 'never propagate exit codes' without a promotion path leaves the tool's enforcement value permanently deferred.",

    // Existing content migration
    "EXISTING CONTENT MIGRATION: When the plan introduces new required constraints, annotations, or fields to an existing content base (e.g., schema validation over existing files, strict type-checking over existing code, required frontmatter over existing notes), the plan must include a migration step. Identify: (1) which file patterns or directories in scope currently do not meet the new requirements; (2) what minimal change brings them into compliance; (3) whether a script or one-time manual pass is appropriate. A plan that enforces rules on future content but silently ignores existing non-compliant content provides limited value and will generate false-failure noise from day one.",

    rawPlanArtifactPath ? `Raw plan artifact path:\n${rawPlanArtifactPath}` : undefined,
    "The candidate has already passed selection. Do not switch to a different opportunity or bundle.",
    "The plan must explain the user-visible/project improvement before listing files, tests, or infrastructure chores.",
    `Selected candidate JSON:\n${opportunityJson}`,
    `Project JSON:\n${projectJson}`,
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}
