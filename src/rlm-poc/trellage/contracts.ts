import { z } from "zod";

/**
 * How a Trellage profile is launched.
 *
 * `container` runs `trellage --profile <name>` (Docker, bind-mounting the git worktree and its
 * `git_common_dir`). `native` runs one of the installed launchers directly.
 */
export const TrellageMode = {
  Container: "container",
  Native: "native",
} as const;
export type TrellageMode = (typeof TrellageMode)[keyof typeof TrellageMode];

/**
 * Selectable harness. `container` is the Trellage container runtime; the rest are native
 * launchers, keyed by the harness they run rather than the launcher binary name, because the
 * harness is what the model reasons about.
 */
export const TrellageHarness = {
  Container: "container",
  Copilot: "copilot",
  Grok: "grok",
  Codex: "codex",
  Claude: "claude",
  Prime: "prime",
  Jcode: "jcode",
  OhMyPi: "oh-my-pi",
} as const;
export type TrellageHarness = (typeof TrellageHarness)[keyof typeof TrellageHarness];

export type TrellageProfile = {
  harness: TrellageHarness;
  mode: TrellageMode;
  /** Launcher binary for native profiles; `trellage` for container profiles. */
  launcher: string;
  name: string;
  description: string;
  /** Whether the live Trellage/TRX inventory reports this profile as sandboxed. */
  sandbox: boolean;
  /**
   * `inventory --json` readiness, when the launcher reports it. Container mode has no `inventory`
   * subcommand, so this stays `undefined` there and readiness is not preflighted.
   */
  readiness?: string;
};

/** Terminal classification of one `invoke_trellage` invocation. */
export const TrellageOutcome = {
  Completed: "completed",
  TurnLimit: "turn_limit",
  Timeout: "timeout",
  Unclassifiable: "unclassifiable",
  Exited: "exited",
} as const;
export type TrellageOutcome = (typeof TrellageOutcome)[keyof typeof TrellageOutcome];

export type TrellageTransition = {
  status: string;
  at: string;
  note?: string;
};

export type TrellageInvokeArgs = {
  prompt: string;
  harness: string;
  profile: string;
  /**
   * When true the invocation is treated as non-mutating and may run concurrently with other
   * read-only invocations against the same worktree. Mutating invocations are serialized.
   */
  readOnly?: boolean;
  /**
   * Optional for native Copilot (`cpx`) profiles, validated against the run's model catalog, and
   * for native Claude (`cldx`) profiles, which own their own model IDs (e.g. `claude-opus-5`).
   * Unsupported for every other harness.
   */
  model?: string;
  /**
   * Reasoning-effort level forwarded as `--effort <value>` to native Claude (`cldx`) profiles
   * only, e.g. `xhigh` for a long-horizon, high-stakes delegated task. Unsupported elsewhere.
   */
  effort?: string;
};

export type TrellageUserInputExchange = {
  question: string;
  answer: string;
};

export type TrellageInvokeResult = {
  text: string;
  outcome: TrellageOutcome;
  harness: string;
  profile: string;
  model?: string;
  effort?: string;
  mode: TrellageMode;
  sandbox: boolean;
  /** Host path of the worktree the harness ran in. */
  worktreePath: string;
  branchName: string;
  /** Drive-loop turns consumed, including the initial prompt. */
  turns: number;
  /** Questions answered on behalf of the root Submind during the invocation. */
  userInputs?: TrellageUserInputExchange[];
  /** Screen evidence, retained when the result file was absent or the outcome was not success. */
  evidence?: string;
};

export const TrellageInvokeArgsSchema = z.object({
  prompt: z.string().min(1),
  harness: z.string().min(1),
  profile: z.string().min(1),
  readOnly: z.boolean().optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
});

/**
 * Raw JSON Schema passed to `defineTool`. Hand-written for the same reason as
 * `createRlmToolJsonSchema`: the installed `@github/copilot-sdk`'s `ZodSchema` interface requires a
 * `toJSONSchema()` method the installed Zod version does not provide.
 */
export function createTrellageToolJsonSchema(
  profiles: readonly TrellageProfile[],
  modelNames: readonly string[] = [],
) {
  const harnesses = [...new Set(profiles.map((profile) => profile.harness))];
  const profileNames = [...new Set(profiles.map((profile) => profile.name))];
  return {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "The complete task for the delegated harness. It shares no context with this " +
          "conversation, so include everything it needs.",
      },
      harness: {
        type: "string",
        enum: harnesses,
        description:
          "Which discovered harness to run. Choose by capability first, then prefer sandboxed " +
          "native launchers, then container profiles, then unsandboxed native launchers.",
      },
      profile: {
        type: "string",
        enum: profileNames,
        description: "Name of the Trellage profile, which must belong to the selected harness.",
      },
      readOnly: {
        type: "boolean",
        description:
          "Set true only when the task cannot modify files. Read-only invocations may run " +
          "concurrently; mutating ones are serialized per worktree.",
      },
      model: {
        type: "string",
        ...(modelNames.length > 0 ? { enum: [...modelNames] } : {}),
        description:
          "Optional model override. For native `copilot`/`cpx` profiles this must be a current " +
          "Copilot model ID from the enum above. For native `claude`/`cldx` profiles this is the " +
          "harness's own model ID (e.g. `claude-opus-5`), not validated against the Copilot " +
          "catalog. Unsupported for every other harness.",
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        description:
          "Optional reasoning-effort level, forwarded as `--effort <value>`. Supported only for " +
          "native `claude`/`cldx` profiles; use `xhigh` for a long-horizon, high-stakes " +
          "delegated task. Unsupported for every other harness.",
      },
    },
    required: ["prompt", "harness", "profile"],
    additionalProperties: false,
  } as const;
}

export class TrellageUnknownProfileError extends Error {
  constructor(
    readonly harness: string,
    readonly profile: string,
  ) {
    super(`Unknown Trellage profile "${profile}" for harness "${harness}".`);
    this.name = "TrellageUnknownProfileError";
  }
}

export class TrellageUnhealthyProfileError extends Error {
  constructor(
    readonly profile: string,
    readonly readiness: string,
  ) {
    super(`Trellage profile "${profile}" reports readiness "${readiness}"; refusing to launch.`);
    this.name = "TrellageUnhealthyProfileError";
  }
}

export class TrellageUnavailableError extends Error {
  constructor(reason: string) {
    super(`Trellage delegation is unavailable: ${reason}`);
    this.name = "TrellageUnavailableError";
  }
}

export class TrellageModelOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrellageModelOverrideError";
  }
}

export class TrellageEffortOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrellageEffortOverrideError";
  }
}
