import { z } from "zod";
import type { SessionConfig } from "@github/copilot-sdk";
import type { RlmExecutionBudgetSnapshot } from "./budget.js";
import type { RlmModelPolicy } from "./modelCatalog.js";

export type RlmReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;

/**
 * A `profile` is a local, versioned config bundle that `rlm`'s `profile` parameter resolves to.
 * Distinct from a Trellage profile (a container harness definition) - see docs/glossary.md.
 */
export type RlmProfile = {
  name: string;
  /** LLM-facing capability summary used to generate the main Submind's profile inventory. */
  description: string;
  purpose: RlmProfilePurpose;
  authority: RlmProfileAuthority;
  /** Whether this worker may create or modify repository files for its bounded task. */
  repositoryWritePermission: boolean;
  /**
   * Optional non-repository filesystem authority for skill-backed workers. Reads remain limited
   * to the prepared skill bundle and working directory; writes, when enabled, are limited to the
   * prepared working directory.
   */
  preparedFilesystemAccess?: RlmPreparedFilesystemAccess;
  model: string;
  /** Dynamic candidate policy. `model` remains the emergency/fixed fallback for custom profiles. */
  modelPolicy?: RlmModelPolicy;
  reasoningEffort?: RlmReasoningEffort;
  systemMessagePrompt: string;
  /** Optional profile-specific turn timeout for long-running delegated workflows. */
  sendTimeoutMs?: number;
  availableTools?: string[];
  excludedTools?: string[];
  skillDirectories?: string[];
  /** The complete skill-name allowlist, excluding skills installed for every recursive profile. */
  allowedSkillNames?: string[];
  /** Lazily installed, recursion-local skill bundle. The root session never receives this. */
  skillBundle?: RlmProfileSkillBundle;
  /** At least one listed skill must be invoked for the recursive result to be accepted. */
  requiredSkillNames?: string[];
  /** Profiles that this profile's recursively registered `rlm` tool may invoke. Unset means all. */
  allowedChildProfiles?: string[];
};

export const RlmPreparedFilesystemAccess = {
  ReadOnly: "read-only",
  WorkingDirectoryWrite: "working-directory-write",
} as const;
export type RlmPreparedFilesystemAccess =
  (typeof RlmPreparedFilesystemAccess)[keyof typeof RlmPreparedFilesystemAccess];

export const RlmProfilePurpose = {
  Validation: "validation",
  Execution: "execution",
  Design: "design",
  Deliberation: "deliberation",
  Media: "media",
  Research: "research",
  Submind: "submind",
  Review: "review",
} as const;
export type RlmProfilePurpose = (typeof RlmProfilePurpose)[keyof typeof RlmProfilePurpose];

export const RlmProfileAuthority = {
  Validation: "validation-only",
  Implementation: "implementation",
  Investigation: "investigation",
  Review: "read-only-review",
} as const;
export type RlmProfileAuthority = (typeof RlmProfileAuthority)[keyof typeof RlmProfileAuthority];

export const RlmProfileSkillBundle = {
  Superpowers: "superpowers",
  Council: "council",
  Research: "research",
  Design: "design",
  Media: "media",
} as const;
export type RlmProfileSkillBundle =
  (typeof RlmProfileSkillBundle)[keyof typeof RlmProfileSkillBundle];

/**
 * Parameters exposed to the calling LLM. `remainingDepth` is deliberately not part of this
 * schema: recursion depth is threaded and decremented by the `rlm` tool implementation itself,
 * never by the model (see ADR 0010).
 */
export const RlmToolArgsSchema = z.object({
  prompt: z.string().min(1).describe("The question or task to hand to the nested rlm session."),
  profile: z
    .string()
    .min(1)
    .describe("Name of the local rlm profile to use for the nested session."),
  model: z
    .string()
    .min(1)
    .optional()
    .describe("Optional model ID selected from the profile's current validated candidates."),
});
export type RlmToolArgs = z.infer<typeof RlmToolArgsSchema>;

/**
 * Raw JSON Schema equivalent of {@link RlmToolArgsSchema}, passed to `defineTool` instead of the
 * Zod schema directly: the installed `@github/copilot-sdk` version's `ZodSchema` interface
 * requires a `toJSONSchema()` method that the installed Zod version does not provide, so this
 * repo's `rlm` tool declares its JSON Schema by hand and keeps the Zod schema above only for
 * type inference (`RlmToolArgs`) and any future direct validation.
 */
export function createRlmToolJsonSchema(
  profileNames: readonly string[],
  modelNames: readonly string[] = [],
) {
  return {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The question or task to hand to the nested rlm session.",
      },
      profile: {
        type: "string",
        ...(profileNames.length > 0 ? { enum: [...profileNames] } : {}),
        description: "Name of the configured local rlm profile to use.",
      },
      model: {
        type: "string",
        ...(modelNames.length > 0 ? { enum: [...modelNames] } : {}),
        description:
          "Optional current model ID. It must be eligible for the selected profile; omit it to " +
          "use that profile's highest-ranked policy candidate.",
      },
    },
    required: ["prompt", "profile"],
    additionalProperties: false,
  } as const;
}

export type RlmCallResult = {
  text: string;
  depthUsed: number;
  model: string;
  modelRationale?: string;
  budget: RlmExecutionBudgetSnapshot;
  /** Explicit ask_user exchanges captured during this call, returned to the parent tool context. */
  userInputs?: RlmUserInputExchange[];
};

export type RlmUserInputExchange = {
  question: string;
  answer: string;
};

export class RlmDepthExceededError extends Error {
  constructor(readonly maxDepth: number) {
    super(`rlm recursion depth exceeded configured maximum of ${maxDepth}.`);
    this.name = "RlmDepthExceededError";
  }
}

export class RlmUnknownProfileError extends Error {
  constructor(readonly profile: string) {
    super(`Unknown rlm profile "${profile}".`);
    this.name = "RlmUnknownProfileError";
  }
}

export class RlmCallBudgetExceededError extends Error {
  constructor(readonly maxCalls: number) {
    super(`rlm total call budget exceeded configured maximum of ${maxCalls}.`);
    this.name = "RlmCallBudgetExceededError";
  }
}

export class RlmProfileNotAllowedError extends Error {
  constructor(readonly profile: string) {
    super(`RLM profile "${profile}" is not allowed from the current session.`);
    this.name = "RlmProfileNotAllowedError";
  }
}

export class RlmSkillPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RlmSkillPolicyError";
  }
}
