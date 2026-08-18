export type RlmCliOptions = {
  prompt?: string;
  /** Reads the prompt from a file instead of an argument value; mutually exclusive with -p/--prompt. */
  promptFile?: string;
  resume?: string;
  /** Enables `invoke_trellage` delegation to foreign agent harnesses (ADR 0011). */
  trellage: boolean;
  /** Provisions the delegation worktree at run start rather than on first delegation. */
  eagerWorktree: boolean;
  /** Reuses the current live Herdr linked worktree instead of provisioning a sibling. */
  reuseCurrentWorktree?: boolean;
  /** Roots the root Copilot SDK session in this directory instead of `process.cwd()`. */
  cwd?: string;
  model?: string;
  maxDepth?: number;
  maxTotalCalls?: number;
  /**
   * Operator-supplied run brief fields. Each is repeatable. When any is present it replaces the
   * derived value for that field, so an operator can bind an exact acceptance contract instead of
   * relying on what the model extracts from the prompt.
   */
  acceptanceCriteria?: string[];
  constraints?: string[];
  validationCommands?: string[];
  /**
   * Writes the raw `RlmPrototypeResult` (finalText/conversationId/traceId/worktrees) as JSON to
   * this path the instant the run resolves, regardless of outcome. Used by
   * `RlmDirectExecutor` (Mastermind's `DELEGATE_SUBMIND` path) so a separate coordinator process
   * can read back Submind's literal final output after this detached process exits.
   */
  outputJsonPath?: string;
  help: boolean;
};

export const RLM_CLI_USAGE = `Usage:
  nub scripts/rlm-poc.ts
  nub scripts/rlm-poc.ts -p "<prompt>"
  nub scripts/rlm-poc.ts --prompt "<prompt>"
  nub scripts/rlm-poc.ts --prompt-file <path>
  nub scripts/rlm-poc.ts --resume <uuid> --prompt "<follow-up>"
  nub scripts/rlm-poc.ts --trellage --prompt "<prompt>"
  nub scripts/rlm-poc.ts --trellage --reuse-current-worktree --prompt "<prompt>"
  nub scripts/rlm-poc.ts --cwd <path> --prompt "<prompt>"
  nub scripts/rlm-poc.ts --model <model-id> --max-depth <n> --max-total-calls <n> --prompt "<prompt>"
  nub scripts/rlm-poc.ts --acceptance "<criterion>" --validation-command "<cmd>" --prompt "<prompt>"
  nub scripts/rlm-poc.ts --output-json <path> --prompt "<prompt>"

Without a prompt, the CLI runs the three-question validation scenario. With -p/--prompt, it runs
the general recursive Submind so the prompt can delegate through any configured RLM profile.
Use --prompt-file to read a (potentially large, multi-paragraph) prompt from a file instead of
passing it as a shell argument; it cannot be combined with -p/--prompt.
Use --resume with the conversation ID printed by a previous general Submind run to send one
follow-up turn. A resumed turn always requires -p/--prompt.

--trellage registers the invoke_trellage tool, letting the Submind delegate to a foreign agent
harness (Claude Code, Codex, Grok, Prime) under a Trellage profile, in a dedicated Herdr worktree.
It requires a Herdr session and is ignored without one. Add --eager-worktree to provision that
worktree at run start instead of on first delegation.
Use --reuse-current-worktree only from an already isolated live Herdr linked worktree. This
explicitly borrows that checkout for delegated harnesses and never reclaims it after the run.

--cwd roots the root Copilot SDK session in the given directory instead of the process's current
working directory, so the Submind operates on an arbitrary target repository/worktree.

--acceptance, --constraint, and --validation-command each bind one run-brief entry and may be
repeated. The Submind otherwise derives these from the prompt; supplying any of them replaces the
derived list for that field, so every delegated worker shares the exact contract you state.

--output-json writes the run's raw result (finalText, conversationId, traceId, worktrees) as JSON
to the given path as soon as the run resolves, so a caller polling this process from the outside
(e.g. Mastermind's RLM executor) can read back Submind's literal final output.
`;

export function parseRlmCliArgs(args: readonly string[]): RlmCliOptions {
  let prompt: string | undefined;
  let promptFile: string | undefined;
  let resume: string | undefined;
  let trellage = false;
  let eagerWorktree = false;
  let reuseCurrentWorktree = false;
  let cwd: string | undefined;
  let model: string | undefined;
  let maxDepth: number | undefined;
  let maxTotalCalls: number | undefined;
  let outputJsonPath: string | undefined;
  const acceptanceCriteria: string[] = [];
  const constraints: string[] = [];
  const validationCommands: string[] = [];
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "-h" || argument === "--help") {
      help = true;
      continue;
    }
    if (argument === "--trellage") {
      trellage = true;
      continue;
    }
    if (argument === "--eager-worktree") {
      eagerWorktree = true;
      continue;
    }
    if (argument === "--reuse-current-worktree") {
      reuseCurrentWorktree = true;
      continue;
    }

    let value: string | undefined;
    let optionName:
      | "prompt"
      | "prompt-file"
      | "resume"
      | "cwd"
      | "output-json"
      | "model"
      | "max-depth"
      | "max-total-calls"
      | "acceptance"
      | "constraint"
      | "validation-command";
    if (argument === "-p" || argument === "--prompt") {
      value = args[index + 1];
      index += 1;
      optionName = "prompt";
    } else if (argument.startsWith("--prompt=")) {
      value = argument.slice("--prompt=".length);
      optionName = "prompt";
    } else if (argument === "--prompt-file") {
      value = args[index + 1];
      index += 1;
      optionName = "prompt-file";
    } else if (argument.startsWith("--prompt-file=")) {
      value = argument.slice("--prompt-file=".length);
      optionName = "prompt-file";
    } else if (argument === "--resume") {
      value = args[index + 1];
      index += 1;
      optionName = "resume";
    } else if (argument.startsWith("--resume=")) {
      value = argument.slice("--resume=".length);
      optionName = "resume";
    } else if (argument === "--cwd") {
      value = args[index + 1];
      index += 1;
      optionName = "cwd";
    } else if (argument.startsWith("--cwd=")) {
      value = argument.slice("--cwd=".length);
      optionName = "cwd";
    } else if (argument === "--output-json") {
      value = args[index + 1];
      index += 1;
      optionName = "output-json";
    } else if (argument.startsWith("--output-json=")) {
      value = argument.slice("--output-json=".length);
      optionName = "output-json";
    } else if (argument === "--model") {
      value = args[index + 1];
      index += 1;
      optionName = "model";
    } else if (argument.startsWith("--model=")) {
      value = argument.slice("--model=".length);
      optionName = "model";
    } else if (argument === "--max-depth") {
      value = args[index + 1];
      index += 1;
      optionName = "max-depth";
    } else if (argument.startsWith("--max-depth=")) {
      value = argument.slice("--max-depth=".length);
      optionName = "max-depth";
    } else if (argument === "--max-total-calls") {
      value = args[index + 1];
      index += 1;
      optionName = "max-total-calls";
    } else if (argument.startsWith("--max-total-calls=")) {
      value = argument.slice("--max-total-calls=".length);
      optionName = "max-total-calls";
    } else if (argument === "--acceptance") {
      value = args[index + 1];
      index += 1;
      optionName = "acceptance";
    } else if (argument.startsWith("--acceptance=")) {
      value = argument.slice("--acceptance=".length);
      optionName = "acceptance";
    } else if (argument === "--constraint") {
      value = args[index + 1];
      index += 1;
      optionName = "constraint";
    } else if (argument.startsWith("--constraint=")) {
      value = argument.slice("--constraint=".length);
      optionName = "constraint";
    } else if (argument === "--validation-command") {
      value = args[index + 1];
      index += 1;
      optionName = "validation-command";
    } else if (argument.startsWith("--validation-command=")) {
      value = argument.slice("--validation-command=".length);
      optionName = "validation-command";
    } else {
      throw new Error(`Unknown argument "${argument}".\n\n${RLM_CLI_USAGE}`);
    }

    if (value === undefined || value.trim().length === 0) {
      const requirement =
        optionName === "prompt"
          ? "a non-empty prompt"
          : optionName === "resume"
            ? "a UUID"
            : optionName === "acceptance" ||
                optionName === "constraint" ||
                optionName === "validation-command"
              ? "a non-empty value"
              : "a non-empty path";
      throw new Error(`The ${argument} option requires ${requirement}.\n\n${RLM_CLI_USAGE}`);
    }

    if (optionName === "prompt") {
      if (prompt !== undefined) {
        throw new Error(`Specify -p/--prompt only once.\n\n${RLM_CLI_USAGE}`);
      }
      prompt = value;
      continue;
    }

    if (optionName === "prompt-file") {
      if (promptFile !== undefined) {
        throw new Error(`Specify --prompt-file only once.\n\n${RLM_CLI_USAGE}`);
      }
      promptFile = value;
      continue;
    }

    if (optionName === "cwd") {
      if (cwd !== undefined) {
        throw new Error(`Specify --cwd only once.\n\n${RLM_CLI_USAGE}`);
      }
      cwd = value;
      continue;
    }

    if (optionName === "output-json") {
      if (outputJsonPath !== undefined) {
        throw new Error(`Specify --output-json only once.\n\n${RLM_CLI_USAGE}`);
      }
      outputJsonPath = value;
      continue;
    }
    if (optionName === "model") {
      model = readSingleValue(model, value, "--model");
      continue;
    }
    if (optionName === "max-depth") {
      maxDepth = readPositiveInteger(maxDepth, value, "--max-depth");
      continue;
    }
    if (optionName === "max-total-calls") {
      maxTotalCalls = readPositiveInteger(maxTotalCalls, value, "--max-total-calls");
      continue;
    }
    if (optionName === "acceptance") {
      acceptanceCriteria.push(value);
      continue;
    }
    if (optionName === "constraint") {
      constraints.push(value);
      continue;
    }
    if (optionName === "validation-command") {
      validationCommands.push(value);
      continue;
    }

    if (resume !== undefined) {
      throw new Error(`Specify --resume only once.\n\n${RLM_CLI_USAGE}`);
    }
    if (!isUuid(value)) {
      throw new Error(`The --resume option requires a UUID.\n\n${RLM_CLI_USAGE}`);
    }
    resume = value;
  }

  if (prompt !== undefined && promptFile !== undefined) {
    throw new Error(`Specify only one of -p/--prompt or --prompt-file.\n\n${RLM_CLI_USAGE}`);
  }

  if (resume !== undefined && prompt === undefined && promptFile === undefined) {
    throw new Error(
      `The --resume option requires -p/--prompt or --prompt-file.\n\n${RLM_CLI_USAGE}`,
    );
  }

  if (eagerWorktree && !trellage) {
    throw new Error(`The --eager-worktree option requires --trellage.\n\n${RLM_CLI_USAGE}`);
  }
  if (reuseCurrentWorktree && !trellage) {
    throw new Error(`The --reuse-current-worktree option requires --trellage.\n\n${RLM_CLI_USAGE}`);
  }

  return {
    ...(prompt !== undefined ? { prompt } : {}),
    ...(promptFile !== undefined ? { promptFile } : {}),
    ...(resume !== undefined ? { resume } : {}),
    trellage,
    eagerWorktree,
    ...(reuseCurrentWorktree ? { reuseCurrentWorktree: true } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    ...(maxTotalCalls !== undefined ? { maxTotalCalls } : {}),
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    ...(constraints.length > 0 ? { constraints } : {}),
    ...(validationCommands.length > 0 ? { validationCommands } : {}),
    ...(outputJsonPath !== undefined ? { outputJsonPath } : {}),
    help,
  };
}

function readSingleValue(current: string | undefined, value: string, optionName: string): string {
  if (current !== undefined) {
    throw new Error(`Specify ${optionName} only once.\n\n${RLM_CLI_USAGE}`);
  }
  return value;
}

function readPositiveInteger(
  current: number | undefined,
  value: string,
  optionName: string,
): number {
  if (current !== undefined) {
    throw new Error(`Specify ${optionName} only once.\n\n${RLM_CLI_USAGE}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`The ${optionName} option requires a positive integer.\n\n${RLM_CLI_USAGE}`);
  }
  return parsed;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
