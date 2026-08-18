import {
  RlmPreparedFilesystemAccess,
  RlmProfileAuthority,
  RlmProfilePurpose,
  RlmProfileSkillBundle,
  RlmUnknownProfileError,
  type RlmProfile,
} from "./contracts.js";
import {
  RlmModelGroup,
  resolveRlmModelCandidates,
  type CopilotModelCatalog,
  type RlmModelPolicy,
} from "./modelCatalog.js";

export const RlmProfileName = {
  Validation: "validation",
  General: "general",
  Superpowers: "superpowers",
  Council: "council",
  Research: "research",
  Design: "design",
  Media: "media",
  Review: "review",
} as const;

const SCOPED_RECURSIVE_TOOLS = ["builtin:ask_user", "custom:rlm", "skill"];
const SCOPED_INVESTIGATION_TOOLS = [
  "builtin:ask_user",
  "custom:rlm",
  "skill",
  "bash",
  "view",
  "glob",
  "web_search",
  "web_fetch",
  "mcp:*",
];
/**
 * Repository-reading review tools. The read set mirrors the proven allowlist in
 * `src/mastermind/review/harness.ts`; `create`/`str_replace_editor` let the reviewer write its
 * report, and the destination-scoped permission handler confines those writes to
 * `writableSubpaths`. Note "bash", not "shell" - "shell" is only the permission-request kind.
 */
const REPOSITORY_REVIEW_TOOLS = [
  "builtin:ask_user",
  "custom:rlm",
  "skill",
  "bash",
  "read_file",
  "list_dir",
  "view",
  "glob",
  "grep",
  "create",
  "str_replace_editor",
  "web_search",
  "web_fetch",
  "mcp:*",
];
const SUPERPOWERS_SKILLS = [
  "using-superpowers",
  "brainstorming",
  "writing-plans",
  "executing-plans",
  "test-driven-development",
  "systematic-debugging",
  "dispatching-parallel-agents",
  "subagent-driven-development",
  "requesting-code-review",
  "receiving-code-review",
  "verification-before-completion",
  "using-git-worktrees",
  "finishing-a-development-branch",
];
export const DESIGN_SKILLS = [
  "visual-plan",
  "infographic-creator",
  "data-visualization",
  "frontend-design",
  "theme-factory",
  "brand-guidelines",
  "web-artifacts-builder",
  "canvas-design",
  "algorithmic-art",
  "img2threejs",
  "critique-affordance",
  "critique-brand-consistency",
  "critique-color",
  "critique-composition",
  "critique-information-density",
  "critique-typography",
  "critique-visual-hierarchy",
  "design-critique",
  "infographic-item-creator",
  "infographic-structure-creator",
  "infographic-syntax-creator",
  "infographic-template-updater",
  "accessibility-audit",
  "component-spec",
  "design-system-governance",
  "design-token",
  "documentation-template",
  "icon-system",
  "localization-design",
  "motion-system",
  "naming-convention",
  "pattern-library",
  "theming-system",
  "design-system-adoption",
  "design-token-audit",
];
export const HYPERRESEARCH_SKILLS = [
  "hyperresearch",
  "hyperresearch-1-decompose",
  "hyperresearch-1-5-chapter-partition",
  "hyperresearch-2-width-sweep",
  "hyperresearch-3-contradiction-graph",
  "hyperresearch-4-loci-analysis",
  "hyperresearch-5-depth-investigation",
  "hyperresearch-6-cross-locus-reconcile",
  "hyperresearch-7-source-tensions",
  "hyperresearch-8-corpus-critic",
  "hyperresearch-9-evidence-digest",
  "hyperresearch-10-triple-draft",
  "hyperresearch-11-synthesize",
  "hyperresearch-12-critics",
  "hyperresearch-13-gap-fetch",
  "hyperresearch-14-patcher",
  "hyperresearch-14-5-cite-check",
  "hyperresearch-15-polish",
  "hyperresearch-16-readability-audit",
];

export const RLM_ROOT_CAPABILITY_MANIFEST = {
  authority: "routing-synthesis-verification",
  repositoryWritePermission: false,
  allowedSkillNames: [],
  availableTools: ["custom:rlm", "mcp:*", "view", "glob", "grep", "bash"],
} as const;

export function createRlmRootAvailableTools(trellageEnabled: boolean): string[] {
  return [
    ...RLM_ROOT_CAPABILITY_MANIFEST.availableTools,
    ...(trellageEnabled ? ["custom:invoke_trellage"] : []),
  ];
}
const ROOT_QUESTION_GUIDANCE =
  " Native `ask_user` is available and encouraged whenever missing context may be present in the " +
  "root Submind conversation. The runtime answers from a current root-conversation snapshot; do " +
  "not avoid the tool or ask for external human interaction in prose.";
const HANDOFF_GUIDANCE =
  " The loaded `rlm-handoff` skill is available for durable context transfer. Invoke it only when " +
  "you are completely stuck or explicitly asked to prepare a continuation, and return the " +
  "temporary handoff document path with the evidence already gathered and remaining blocker.";
const BETTER_GITHUB_GUIDANCE =
  " The loaded `better-github-skill` is available for GitHub work. Invoke it when inspecting pull " +
  "requests, review conversations, CI failures, repository state, or non-trivial `gh` commands.";
export const DEFAULT_RLM_PROFILE_MODEL = "gpt-5.6-sol";
export const DEFAULT_RLM_PROFILE_REASONING_EFFORT = "medium";
const TOOL_MODEL_REQUIREMENTS = { toolCall: true } as const;
const REASONING_TOOL_MODEL_REQUIREMENTS = { reasoning: true, toolCall: true } as const;

function modelPolicy(
  preferredGroups: readonly RlmModelGroup[],
  options: Omit<RlmModelPolicy, "preferredGroups"> = {},
): RlmModelPolicy {
  return { preferredGroups, maxCandidates: 4, ...options };
}

const VALIDATION_PROFILE: RlmProfile = {
  name: RlmProfileName.Validation,
  description: "Restricted validation worker that can only ask the root Submind and recurse.",
  purpose: RlmProfilePurpose.Validation,
  authority: RlmProfileAuthority.Validation,
  repositoryWritePermission: false,
  model: "gemini-3.7-flash",
  modelPolicy: modelPolicy([RlmModelGroup.FastEfficient], {
    fallbackGroups: [RlmModelGroup.BalancedWorkhorse],
    requiredCapabilities: TOOL_MODEL_REQUIREMENTS,
  }),
  systemMessagePrompt:
    "You are a restricted RLM validation worker in a fresh Copilot SDK session. Follow the " +
    "delegated validation instruction exactly. Use native `ask_user` to obtain answers from the " +
    "root Submind conversation and return the answer verbatim. Do not perform repository work." +
    ROOT_QUESTION_GUIDANCE +
    HANDOFF_GUIDANCE +
    BETTER_GITHUB_GUIDANCE,
  availableTools: SCOPED_RECURSIVE_TOOLS,
  allowedChildProfiles: [RlmProfileName.Validation],
};

const GENERAL_PROFILE: RlmProfile = {
  name: RlmProfileName.General,
  description:
    "General-purpose recursive Copilot worker for bounded execution without profile-specific skills.",
  purpose: RlmProfilePurpose.Execution,
  authority: RlmProfileAuthority.Implementation,
  repositoryWritePermission: true,
  model: DEFAULT_RLM_PROFILE_MODEL,
  reasoningEffort: DEFAULT_RLM_PROFILE_REASONING_EFFORT,
  modelPolicy: modelPolicy([RlmModelGroup.CodingSpecialist], {
    fallbackGroups: [RlmModelGroup.BalancedWorkhorse],
    requiredCapabilities: REASONING_TOOL_MODEL_REQUIREMENTS,
    defaultReasoningEffort: DEFAULT_RLM_PROFILE_REASONING_EFFORT,
  }),
  systemMessagePrompt:
    "You are a general execution worker in a fresh Copilot SDK session. Complete only the " +
    "delegated task using the available Copilot tools. Use native `ask_user` when you need an " +
    "answer from the root Submind conversation, and use `rlm` only when a smaller independent " +
    "subtask genuinely benefits from another clean context. Return concrete results, evidence, " +
    "validation, risks, and unresolved ambiguity. Do not claim work you did not verify." +
    ROOT_QUESTION_GUIDANCE +
    HANDOFF_GUIDANCE +
    BETTER_GITHUB_GUIDANCE,
  allowedChildProfiles: Object.values(RlmProfileName),
};

const SUPERPOWERS_PROFILE: RlmProfile = {
  name: RlmProfileName.Superpowers,
  description:
    "GitHub Copilot CLI with Superpowers' design-first, TDD, root-cause debugging, review, " +
    "verification, and branch-finishing discipline.",
  purpose: RlmProfilePurpose.Execution,
  authority: RlmProfileAuthority.Implementation,
  repositoryWritePermission: true,
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
  modelPolicy: modelPolicy([RlmModelGroup.CodingSpecialist], {
    fallbackGroups: [RlmModelGroup.FrontierCurrent],
    requiredCapabilities: REASONING_TOOL_MODEL_REQUIREMENTS,
    defaultReasoningEffort: "medium",
  }),
  systemMessagePrompt:
    "You are an independent Superpowers execution harness in a fresh Copilot SDK session. " +
    "Treat this recursive session as the primary harness for its bounded task, not as a generic " +
    "subagent. Before acting, invoke and follow the relevant loaded Superpowers skills. Preserve " +
    "their design-first, test-driven, root-cause, review, verification, and branch-finishing " +
    "discipline. Use `rlm` with the `superpowers` profile when a clean recursive context is " +
    "genuinely useful. Return concrete changes, evidence, risks, and unresolved ambiguity." +
    ROOT_QUESTION_GUIDANCE +
    HANDOFF_GUIDANCE +
    BETTER_GITHUB_GUIDANCE,
  skillBundle: RlmProfileSkillBundle.Superpowers,
  allowedSkillNames: SUPERPOWERS_SKILLS,
  allowedChildProfiles: [
    RlmProfileName.Superpowers,
    RlmProfileName.Council,
    RlmProfileName.Research,
    RlmProfileName.Design,
    RlmProfileName.Media,
    RlmProfileName.Review,
    RlmProfileName.Validation,
  ],
};

const COUNCIL_PROFILE: RlmProfile = {
  name: RlmProfileName.Council,
  description:
    "Council of High Intelligence - structured multi-lens deliberation that preserves dissent, " +
    "kill criteria, and next steps. Use it for materially consequential decisions, pressure " +
    "tests, consensus checks, and hard architecture/product tradeoffs where one-shot reasoning " +
    "is unsafe. Skip factual lookups, small reversible edits, and pure implementation throughput.",
  purpose: RlmProfilePurpose.Deliberation,
  authority: RlmProfileAuthority.Investigation,
  repositoryWritePermission: false,
  preparedFilesystemAccess: RlmPreparedFilesystemAccess.ReadOnly,
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
  modelPolicy: modelPolicy([RlmModelGroup.FrontierCurrent], {
    requiredCapabilities: REASONING_TOOL_MODEL_REQUIREMENTS,
    defaultReasoningEffort: "medium",
  }),
  systemMessagePrompt:
    "You are a Council of High Intelligence coordinator in a fresh Copilot SDK session. Invoke " +
    "the loaded `/council` skill for the delegated decision. Preserve distinct lenses, dissent, " +
    "kill criteria, and concrete next steps. Where the upstream skill asks for spawned agents, " +
    "delegate each bounded council seat through `rlm` using the `council` profile and include the " +
    "seat instructions and shared decision context. Do not use this profile for simple factual " +
    "lookups or routine implementation. Select the smallest sufficient council panel and fit its " +
    "seat calls within the recursion tree's remaining call budget." +
    ROOT_QUESTION_GUIDANCE +
    HANDOFF_GUIDANCE +
    BETTER_GITHUB_GUIDANCE,
  sendTimeoutMs: 20 * 60_000,
  skillBundle: RlmProfileSkillBundle.Council,
  allowedSkillNames: ["council"],
  availableTools: SCOPED_INVESTIGATION_TOOLS,
  allowedChildProfiles: [
    RlmProfileName.Council,
    RlmProfileName.Research,
    RlmProfileName.Media,
    RlmProfileName.Review,
    RlmProfileName.Validation,
  ],
};

const RESEARCH_PROFILE: RlmProfile = {
  name: RlmProfileName.Research,
  description:
    "Hyperresearch's light tier plus last30days multi-source social research: a focused 5-step " +
    "pipeline for bounded factual queries, surveys, and comparisons with a persistent research " +
    "vault, and recency-scored pulls from Reddit, X, YouTube, HN, Polymarket, GitHub, and the web. " +
    "Use `/hyperresearch <prompt>` for vault-backed research, `/last30days <topic>` for recent " +
    "discourse, and `/last30days doctor` to diagnose source or authentication gaps.",
  purpose: RlmProfilePurpose.Research,
  authority: RlmProfileAuthority.Investigation,
  repositoryWritePermission: false,
  preparedFilesystemAccess: RlmPreparedFilesystemAccess.WorkingDirectoryWrite,
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
  modelPolicy: modelPolicy([RlmModelGroup.FrontierCurrent], {
    fallbackGroups: [RlmModelGroup.BalancedWorkhorse],
    requiredCapabilities: {
      ...REASONING_TOOL_MODEL_REQUIREMENTS,
      attachments: true,
    },
    defaultReasoningEffort: "medium",
  }),
  systemMessagePrompt:
    "You are a focused research harness in a fresh Copilot SDK session. Your first action must be " +
    "a `skill` tool call: invoke `hyperresearch` for bounded factual research, surveys, and " +
    "comparisons, or `last30days` for recent social and community evidence. Do not begin with " +
    "generic `web_search` or `web_fetch`; use those only as directed by the invoked skill. Invoke " +
    "`last30days` with its doctor workflow when source coverage or authentication is uncertain. " +
    "A response produced without invoking `hyperresearch` or `last30days` is invalid. Keep " +
    "citations, source provenance, dissent, and uncertainty explicit. Use `rlm` with the " +
    "`research` profile only for cleanly separable research branches. Keep the persistent vault " +
    "and every generated file under the prepared working directory; repository writes are denied." +
    ROOT_QUESTION_GUIDANCE +
    HANDOFF_GUIDANCE +
    BETTER_GITHUB_GUIDANCE,
  sendTimeoutMs: 60 * 60_000,
  skillBundle: RlmProfileSkillBundle.Research,
  allowedSkillNames: [...HYPERRESEARCH_SKILLS, "last30days"],
  requiredSkillNames: ["hyperresearch", "last30days"],
  availableTools: SCOPED_INVESTIGATION_TOOLS,
  allowedChildProfiles: [
    RlmProfileName.Research,
    RlmProfileName.Media,
    RlmProfileName.Review,
    RlmProfileName.Validation,
  ],
};

const DESIGN_PROFILE: RlmProfile = {
  name: RlmProfileName.Design,
  description:
    "Claude Opus 5 visual-design harness. Use `visual-plan` for reviewable architecture/UI/work " +
    "plans; `infographic-creator` for complex topics, comparisons, flows, hierarchies, and " +
    "infographics or visual summaries of completed work; `data-visualization` for chart/dashboard " +
    "principles; `frontend-design` with " +
    "`theme-factory`, `brand-guidelines`, and `web-artifacts-builder` for distinctive, " +
    "high-quality frontend HTML; visual-critique skills for final QA; `canvas-design` or " +
    "`algorithmic-art` for 2D generative work; and `img2threejs` only for reference-image-to-3D " +
    "Three.js reconstruction.",
  purpose: RlmProfilePurpose.Design,
  authority: RlmProfileAuthority.Implementation,
  repositoryWritePermission: true,
  model: "claude-opus-5",
  reasoningEffort: "medium",
  modelPolicy: modelPolicy([RlmModelGroup.FrontierCurrent], {
    requiredCapabilities: {
      ...REASONING_TOOL_MODEL_REQUIREMENTS,
      attachments: true,
    },
    requiredInputModalities: ["image"],
    preferredVendors: ["anthropic"],
    preferredFamilies: ["claude-opus"],
    defaultReasoningEffort: "medium",
  }),
  systemMessagePrompt:
    "You are a visual design harness in a fresh Copilot SDK session. Before acting, invoke the " +
    "loaded skill that best matches the deliverable. Use `visual-plan` for a human-reviewable " +
    "visual plan; `infographic-creator` for comparisons, complex-topic diagrams, flows, visual " +
    "summaries of completed work, hierarchies, and polished infographics, with its structure, " +
    "syntax, item, and template " +
    "skills as needed; `data-visualization` for charts and dashboards; and `frontend-design` as " +
    "the lead for distinctive production-quality frontend HTML, supported by `theme-factory`, " +
    "`brand-guidelines`, `web-artifacts-builder`, design-system skills, and a visual-critique " +
    "pass. Use `canvas-design` or `algorithmic-art` for custom 2D art. Use `img2threejs` only " +
    "when the task explicitly requires reconstructing an animation-ready Three.js model from a " +
    "reference image. Preserve source facts, create the requested artifact rather than only " +
    "describing it, and return its location plus verification evidence. Use `rlm` with the " +
    "`design` profile only when a cleanly separable visual branch genuinely helps." +
    ROOT_QUESTION_GUIDANCE +
    HANDOFF_GUIDANCE +
    BETTER_GITHUB_GUIDANCE,
  skillBundle: RlmProfileSkillBundle.Design,
  allowedSkillNames: DESIGN_SKILLS,
  allowedChildProfiles: [
    RlmProfileName.Design,
    RlmProfileName.Research,
    RlmProfileName.Media,
    RlmProfileName.Review,
    RlmProfileName.Validation,
  ],
};

const MEDIA_PROFILE: RlmProfile = {
  name: RlmProfileName.Media,
  description:
    "Video transcription and analysis harness for YouTube, Loom, Vimeo, Riverside, Zoom, social " +
    "video, and local media. Invoke `watch-video` in transcript, visual, or multimodal mode to " +
    "produce timestamped transcripts, key moments, summaries, decisions, and action items.",
  purpose: RlmProfilePurpose.Media,
  authority: RlmProfileAuthority.Investigation,
  repositoryWritePermission: false,
  preparedFilesystemAccess: RlmPreparedFilesystemAccess.WorkingDirectoryWrite,
  model: "claude-opus-5",
  modelPolicy: modelPolicy([RlmModelGroup.FrontierCurrent], {
    fallbackGroups: [RlmModelGroup.BalancedWorkhorse],
    requiredCapabilities: {
      ...REASONING_TOOL_MODEL_REQUIREMENTS,
      attachments: true,
    },
    requiredInputModalities: ["image"],
    preferredVendors: ["anthropic"],
  }),
  systemMessagePrompt:
    "You are a media analysis harness in a fresh Copilot SDK session. Your first action must be " +
    "a `skill` tool call invoking `watch-video` with the supplied URL or local media path and the " +
    "requested transcript, visual, or multimodal depth. Follow the skill's source detection, " +
    "platform-transcript-first fallback order, long-video cost confirmation, frame cadence, and " +
    "timestamped reporting contract. For visual and multimodal analysis, use the skill's local " +
    "`copilot-proxy-rs` Anthropic image path; never require `GEMINI_API_KEY`. Use native `ask_user` " +
    "when the source, depth, or permission to incur a long-running vision workload is unresolved. " +
    "Keep downloads and derived artifacts under the prepared working directory instead of " +
    "`~/Documents/videos`. Do not modify repository files; return the " +
    "generated media workdir, transcript or summary paths, source metadata, key moments, decisions, " +
    "action items, errors, and dependency gaps. A response produced without invoking " +
    "`watch-video` is invalid. Use `rlm` with the `media` profile only for cleanly separable media " +
    "items, and use `research` or `review` only for a bounded downstream task." +
    ROOT_QUESTION_GUIDANCE +
    HANDOFF_GUIDANCE +
    BETTER_GITHUB_GUIDANCE,
  sendTimeoutMs: 60 * 60_000,
  skillBundle: RlmProfileSkillBundle.Media,
  allowedSkillNames: ["watch-video"],
  requiredSkillNames: ["watch-video"],
  availableTools: SCOPED_INVESTIGATION_TOOLS,
  allowedChildProfiles: [
    RlmProfileName.Media,
    RlmProfileName.Research,
    RlmProfileName.Review,
    RlmProfileName.Validation,
  ],
};

const REVIEW_PROFILE: RlmProfile = {
  name: RlmProfileName.Review,
  description:
    "Reviewer that reads the repository to verify diffs, artifacts, requirements, and validation " +
    "evidence, and writes its report only under .weavekit/reviews.",
  purpose: RlmProfilePurpose.Review,
  authority: RlmProfileAuthority.Review,
  repositoryWritePermission: false,
  writableSubpaths: [".weavekit/reviews"],
  model: "claude-opus-5",
  reasoningEffort: "medium",
  modelPolicy: modelPolicy([RlmModelGroup.FrontierCurrent], {
    requiredCapabilities: REASONING_TOOL_MODEL_REQUIREMENTS,
    defaultReasoningEffort: "medium",
  }),
  systemMessagePrompt:
    "You are a bounded reviewer in a fresh Copilot SDK session. Read the repository directly to " +
    "check the requirements, diffs, artifacts, and validation evidence named in the delegated " +
    "prompt, and re-run verification commands read-only when the supplied evidence is thin. " +
    "Identify concrete defects, requirement gaps, risks, and missing verification. You must not " +
    "change the work you review: write your report and any supporting notes under " +
    ".weavekit/reviews/, and never edit the files, documents, or artifacts under review." +
    ROOT_QUESTION_GUIDANCE +
    HANDOFF_GUIDANCE +
    BETTER_GITHUB_GUIDANCE,
  availableTools: REPOSITORY_REVIEW_TOOLS,
  allowedChildProfiles: [RlmProfileName.Review, RlmProfileName.Research],
};

const BUILT_IN_PROFILES: Record<string, RlmProfile> = {
  [VALIDATION_PROFILE.name]: VALIDATION_PROFILE,
  [GENERAL_PROFILE.name]: GENERAL_PROFILE,
  [SUPERPOWERS_PROFILE.name]: SUPERPOWERS_PROFILE,
  [COUNCIL_PROFILE.name]: COUNCIL_PROFILE,
  [RESEARCH_PROFILE.name]: RESEARCH_PROFILE,
  [DESIGN_PROFILE.name]: DESIGN_PROFILE,
  [MEDIA_PROFILE.name]: MEDIA_PROFILE,
  [REVIEW_PROFILE.name]: REVIEW_PROFILE,
};

export type RlmProfileRegistry = {
  resolve(name: string): RlmProfile;
  list(): readonly RlmProfile[];
};

/**
 * Creates a profile registry. Additional profiles can be layered over the built-in defaults by
 * passing an `overrides` map (keyed by profile name); this is the extension point for future
 * profiles without needing a full entity-YAML pipeline for this prototype.
 */
export function createRlmProfileRegistry(
  overrides: Record<string, RlmProfile> = {},
): RlmProfileRegistry {
  const profiles: Record<string, RlmProfile> = { ...BUILT_IN_PROFILES, ...overrides };
  return {
    resolve(name: string): RlmProfile {
      const profile = profiles[name];
      if (!profile) {
        throw new RlmUnknownProfileError(name);
      }
      return profile;
    },
    list(): readonly RlmProfile[] {
      return Object.values(profiles);
    },
  };
}

export const defaultRlmProfileRegistry = createRlmProfileRegistry();

/** Deterministic dry-run view of the current candidate policy; does not create an SDK session. */
export function describeRlmProfileModelRouting(
  catalog: CopilotModelCatalog,
  profiles: RlmProfileRegistry = defaultRlmProfileRegistry,
) {
  return profiles.list().map((profile) => ({
    profile: profile.name,
    fallbackModel: profile.model,
    candidates: profile.modelPolicy
      ? resolveRlmModelCandidates(catalog, profile.modelPolicy).map((candidate) => ({
          id: candidate.id,
          group: candidate.group,
          name: candidate.name,
          description: candidate.description,
        }))
      : [],
  }));
}
