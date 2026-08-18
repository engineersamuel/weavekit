import type { Span } from "@opentelemetry/api";
import type {
  PermissionHandler,
  PermissionRequest,
  PermissionRequestResult,
  SessionEvent,
} from "@github/copilot-sdk";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  RlmDependencyReport,
  RlmRunBrief,
  RlmWorkerReport,
} from "../generated/baml_client/types.js";
import {
  DEFAULT_RLM_MAX_TOTAL_CALLS,
  claimRlmExecutionBudget,
  createRlmExecutionBudget,
  snapshotRlmExecutionBudget,
  type RlmExecutionBudget,
  type RlmExecutionBudgetSnapshot,
} from "./budget.js";
import {
  RlmCallBudgetExceededError,
  RlmDepthExceededError,
  RlmPreparedFilesystemAccess,
  RlmUnknownProfileError,
  RlmSkillPolicyError,
  clampRlmReasoningEffort,
  type RlmCallResult,
  type RlmProfile,
  type RlmToolArgs,
  type RlmUserInputExchange,
} from "./contracts.js";
import { defaultRlmProfileRegistry, type RlmProfileRegistry } from "./profiles.js";
import type { RlmModelDecision } from "./modelCatalog.js";
import {
  RLM_COMMON_PROFILE_SKILL_NAMES,
  prepareRlmProfileSkills,
  type PrepareRlmProfileSkills,
  type PreparedRlmProfileSkills,
} from "./profileSkills.js";
import { withRlmSpan } from "./telemetry.js";
import type { RlmWorkerContract } from "./workerContract.js";

export const DEFAULT_RLM_SEND_TIMEOUT_MS = 5 * 60_000;

/**
 * Minimal surface of `@github/copilot-sdk`'s session that `rlm` depends on. Kept narrow (rather
 * than importing the full `CopilotSession` type) so tests can supply a fake without spinning up a
 * real Copilot CLI process.
 */
export type RlmSession = {
  /** Canonical Copilot SDK conversation ID. */
  readonly sessionId?: string;
  sendAndWait(
    options: { prompt: string },
    timeout?: number,
  ): Promise<{ data?: { content?: string } } | undefined>;
  disconnect(): Promise<void>;
  /** Retrieves the complete persisted event history used to snapshot parent conversation context. */
  getEvents?(): Promise<SessionEvent[]>;
  /** Optional so fakes used in tests aren't forced to implement streaming subscriptions. */
  on?(handler: (event: SessionEvent) => void): () => void;
  rpc?: {
    skills: {
      ensureLoaded(): Promise<void>;
      list(): Promise<{ skills: RlmDiscoveredSkill[] }>;
    };
  };
};

/** Minimal surface of `@github/copilot-sdk`'s `CopilotClient` that `rlm` depends on. */
export type RlmClient = {
  start(): Promise<void>;
  createSession(config: Record<string, unknown>): Promise<RlmSession>;
  resumeSession?(sessionId: string, config: Record<string, unknown>): Promise<RlmSession>;
  stop(): Promise<unknown>;
  rpc?: {
    skills: {
      discover(options: {
        projectPaths?: string[];
        skillDirectories?: string[];
      }): Promise<{ skills: RlmDiscoveredSkill[] }>;
    };
  };
};

export type RlmDiscoveredSkill = {
  name: string;
  source: string;
  enabled: boolean;
  path?: string;
};

export type RlmSkillPolicy = {
  allowedSkillNames: readonly string[];
  allowedSkillDirectories: readonly string[];
  disabledSkills: string[];
};

export type RlmClientFactoryContext = {
  profile?: RlmProfile;
  preparedSkills?: PreparedRlmProfileSkills;
};

export type RlmClientFactory = (
  context?: RlmClientFactoryContext,
) => Promise<RlmClient> | RlmClient;

export type RlmSessionReference = {
  current?: RlmSession;
  /** Explicit application/profile instructions, excluding the SDK's internal harness prompt. */
  instructions?: string;
  /** Original root user request, retained even while the active turn is not yet persisted. */
  initialPrompt?: string;
};

export type RlmToolFactory = (
  depthRemaining: number,
  allowedProfiles?: readonly string[],
  parentCallId?: string,
) => unknown;

/** SDK permission handler, wrapped for profiles with prepared non-repository filesystem access. */
export type RlmPermissionHandler = PermissionHandler;

/**
 * Opaque pass-through for `@github/copilot-sdk`'s `UserInputHandler` (enables the native
 * `ask_user` tool on the nested session when present). Same rationale as {@link RlmPermissionHandler}.
 */
export type RlmUserInputHandler = unknown;

export type ExecuteRlmOptions = {
  args: RlmToolArgs;
  depthRemaining: number;
  maxDepth: number;
  profiles?: RlmProfileRegistry;
  toolCallId?: string;
  prepareProfileSkills?: PrepareRlmProfileSkills;
  clientFactory: RlmClientFactory;
  /** Repository/worktree root inherited from the root RLM invocation. */
  workingDirectory?: string;
  /** Canonical model decision already validated against the run's immutable catalog snapshot. */
  modelDecision?: RlmModelDecision;
  /** Run-owned identity and selected context for typed general Submind calls. */
  runId?: string;
  callId?: string;
  callNumber?: number;
  stateRevision?: number;
  parentCallId?: string;
  runBrief?: RlmRunBrief;
  dependencies?: readonly RlmDependencyReport[];
  workerContract?: RlmWorkerContract;
  /** Builds the `rlm` tool to register on the nested session, at the given remaining depth. */
  buildNestedTool: RlmToolFactory;
  /**
   * Extra tools registered alongside `rlm` on the nested session, so a recursive session can reach
   * the same foreign harnesses the root can (ADR 0011).
   */
  additionalTools?: readonly unknown[];
  /** Unattended nested sessions use `approveAll` in production (ADR 0010). */
  onPermissionRequest: RlmPermissionHandler;
  /** When provided, enables the native `ask_user` tool on the nested session. */
  onUserInputRequest?: RlmUserInputHandler;
  /** Mutable capture populated by the ask_user handler while the nested turn is active. */
  userInputExchanges?: RlmUserInputExchange[];
  /** Shared across the complete recursive call tree; defaults only for direct test/API usage. */
  executionBudget?: RlmExecutionBudget;
  sendTimeoutMs?: number;
  /**
   * When true (the default), requests streaming assistant/reasoning deltas from the SDK so a
   * console listener (see `consoleStreaming.ts`) can render output in real time instead of only
   * once the whole nested call finishes.
   */
  enableStreaming?: boolean;
  /**
   * Called with the freshly created nested session before the prompt is sent, so callers can
   * attach console streaming (or any other observer) without `session.ts` itself depending on
   * `process.stdout`. Receives the depth/profile/model context for labeling.
   */
  onSessionCreated?: (
    session: RlmSession,
    context: { depthUsed: number; maxDepth: number; profile: string; model: string },
  ) => void | (() => void);
};

/**
 * Creates a brand-new Copilot SDK client/session for one `rlm` recursive hop, sends the prompt,
 * and returns the result. Every call:
 * - starts a clean conversation slate (no inherited parent history);
 * - uses unattended permissions, narrowed for prepared non-repository filesystem profiles;
 * - registers `rlm` itself on the nested session (via `buildNestedTool`) so it can recurse again;
 * - is wrapped in one Langfuse span (`withRlmSpan`) so the recursion tree is observable.
 *
 * Throws `RlmDepthExceededError` when `depthRemaining <= 0` and `RlmUnknownProfileError` when
 * `args.profile` does not resolve. Callers (the `rlm` tool handler) are expected to convert these
 * into a `ToolResultObject` failure rather than letting them propagate to the LLM as exceptions.
 */
export async function executeRlm(options: ExecuteRlmOptions): Promise<RlmCallResult> {
  const { args, depthRemaining, maxDepth } = options;
  const profiles = options.profiles ?? defaultRlmProfileRegistry;
  const profile = profiles.resolve(args.profile);
  const modelDecision = options.modelDecision ?? {
    model: profile.model,
    rationale: `Profile uses configured model ${profile.model}.`,
    usedFallback: false,
    candidates: [],
  };
  const executionBudget =
    options.executionBudget ?? createRlmExecutionBudget(DEFAULT_RLM_MAX_TOTAL_CALLS);
  const sendTimeoutMs = computeRlmSessionTimeoutMs(
    profile,
    depthRemaining,
    profiles,
    options.sendTimeoutMs ?? DEFAULT_RLM_SEND_TIMEOUT_MS,
  );

  return withRlmSpan(
    {
      profile: profile.name,
      model: modelDecision.model,
      prompt: args.prompt,
      ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.callId ? { callId: options.callId } : {}),
      ...(options.callNumber ? { callNumber: options.callNumber } : {}),
      ...(options.stateRevision !== undefined ? { stateRevision: options.stateRevision } : {}),
      ...(options.parentCallId ? { parentCallId: options.parentCallId } : {}),
      ...(options.dependencies?.length
        ? { dependencyCallIds: options.dependencies.map(({ callId }) => callId) }
        : {}),
      depthRemaining,
      maxDepth,
      budget: snapshotRlmExecutionBudget(executionBudget),
      modelRationale: modelDecision.rationale,
      ...(modelDecision.requestedModel ? { requestedModel: modelDecision.requestedModel } : {}),
      modelFallback: modelDecision.usedFallback,
      modelCandidates: modelDecision.candidates.map(({ id }) => id),
    },
    async (span) => {
      if (depthRemaining <= 0) {
        throw new RlmDepthExceededError(maxDepth);
      }
      const claimedBudget = claimRlmExecutionBudget(executionBudget);
      let budgetClaimed = true;
      let preparedSkills: PreparedRlmProfileSkills | undefined;
      try {
        preparedSkills = await (options.prepareProfileSkills ?? prepareRlmProfileSkills)(profile);
        assertNoWriteProfileWorkspace(profile, preparedSkills);
      } catch (error) {
        if (error instanceof RlmSkillPolicyError) {
          executionBudget.usedCalls -= 1;
          budgetClaimed = false;
        }
        throw error;
      }
      const childDepthRemaining = depthRemaining - 1;
      const depthUsed = maxDepth - childDepthRemaining;
      span.setAttribute("langfuse.observation.input", JSON.stringify({ prompt: args.prompt }));
      const client = await options.clientFactory({ profile, preparedSkills });
      await client.start();
      let session: RlmSession | undefined;
      let unsubscribe: (() => void) | undefined;
      let unsubscribeSkillTracking: (() => void) | undefined;
      const invokedSkillNames = new Set<string>();
      try {
        const skillDirectories = collectSkillDirectories(profile, preparedSkills);
        const skillPolicy = await prepareRlmSkillPolicy(client, {
          allowedSkillNames: [
            ...(preparedSkills ? RLM_COMMON_PROFILE_SKILL_NAMES : []),
            ...(profile.allowedSkillNames ?? []),
          ],
          allowedSkillDirectories: skillDirectories,
          projectPaths: [
            preparedSkills?.workingDirectory ?? options.workingDirectory ?? process.cwd(),
          ],
        });
        span.setAttribute("weavekit.rlm.budget.used_calls", claimedBudget.usedCalls);
        span.setAttribute("weavekit.rlm.budget.remaining_calls", claimedBudget.remainingCalls);
        session = await client.createSession(
          buildSessionConfig(
            profile,
            options,
            childDepthRemaining,
            preparedSkills,
            skillPolicy,
            claimedBudget,
          ),
        );
        await assertRlmSessionSkillPolicy(session, skillPolicy);
        unsubscribeSkillTracking = session.on?.((event) => {
          if (event.type === "skill.invoked") {
            invokedSkillNames.add(event.data.name);
          }
        });
        unsubscribe =
          options.onSessionCreated?.(session, {
            depthUsed,
            maxDepth,
            profile: profile.name,
            model: modelDecision.model,
          }) ?? undefined;
        const workerPrompt =
          options.workerContract && options.runBrief
            ? await options.workerContract.renderPrompt({
                brief: options.runBrief,
                delegatedTask: args.prompt,
                dependencies: [...(options.dependencies ?? [])],
              })
            : args.prompt;
        const response = await session.sendAndWait({ prompt: workerPrompt }, sendTimeoutMs);
        assertRequiredSkillInvoked(profile, invokedSkillNames);
        const rawText = response?.data?.content ?? "";
        const report: RlmWorkerReport | undefined = options.workerContract
          ? options.workerContract.parseResponse(rawText)
          : undefined;
        const text = report ? report.summary.trim() : rawText;
        const result: RlmCallResult = {
          text,
          depthUsed,
          model: modelDecision.model,
          modelRationale: modelDecision.rationale,
          budget: snapshotRlmExecutionBudget(executionBudget),
          ...(options.runId ? { runId: options.runId } : {}),
          ...(options.callId ? { callId: options.callId } : {}),
          ...(options.parentCallId ? { parentCallId: options.parentCallId } : {}),
          ...(options.dependencies?.length
            ? { dependencyCallIds: options.dependencies.map(({ callId }) => callId) }
            : {}),
          ...(report ? { report } : {}),
          ...(options.userInputExchanges?.length
            ? { userInputs: [...options.userInputExchanges] }
            : {}),
        };
        span.setAttribute("weavekit.rlm.execution_status", "succeeded");
        if (report) {
          span.setAttribute("weavekit.rlm.worker_outcome", report.outcome);
        }
        recordOutput(span, result);
        return result;
      } catch (error) {
        if (budgetClaimed && error instanceof RlmSkillPolicyError) {
          executionBudget.usedCalls -= 1;
        }
        throw error;
      } finally {
        try {
          unsubscribeSkillTracking?.();
        } catch {
          // Best-effort cleanup; an unsubscribe failure must not mask the real result/error.
        }
        try {
          unsubscribe?.();
        } catch {
          // Best-effort cleanup; an unsubscribe failure must not mask the real result/error.
        }

        try {
          await session?.disconnect();
        } catch {
          // Best-effort cleanup; a disconnect failure must not mask the real result/error.
        }
        try {
          await client.stop();
        } catch {
          // Same as above.
        }
      }
    },
  );
}

function assertRequiredSkillInvoked(
  profile: RlmProfile,
  invokedSkillNames: ReadonlySet<string>,
): void {
  if (
    profile.requiredSkillNames?.length &&
    !profile.requiredSkillNames.some((name) => invokedSkillNames.has(name))
  ) {
    throw new Error(
      `RLM profile "${profile.name}" must invoke one of these loaded skills before returning: ` +
        profile.requiredSkillNames.join(", "),
    );
  }
}

function buildSessionConfig(
  profile: RlmProfile,
  options: ExecuteRlmOptions,
  childDepthRemaining: number,
  preparedSkills: PreparedRlmProfileSkills | undefined,
  skillPolicy: RlmSkillPolicy,
  budget: RlmExecutionBudgetSnapshot,
): Record<string, unknown> {
  const skillDirectories = collectSkillDirectories(profile, preparedSkills);
  const workingDirectory = preparedSkills?.workingDirectory ?? options.workingDirectory;
  const workerEnvelope = buildRlmWorkerExecutionEnvelope(profile, {
    remainingDepth: childDepthRemaining,
    budget,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.callId ? { callId: options.callId } : {}),
    ...(options.parentCallId ? { parentCallId: options.parentCallId } : {}),
    dependencyCallIds: options.dependencies?.map(({ callId }) => callId) ?? [],
  });
  const reasoningEffort = options.args.effort
    ? clampRlmReasoningEffort(options.args.effort, profile.maxReasoningEffort)
    : (options.modelDecision?.reasoningEffort ?? profile.reasoningEffort);
  return {
    model: options.modelDecision?.model ?? profile.model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    enableConfigDiscovery: true,
    enableSkills: skillDirectories.length > 0,
    memory: { enabled: false },
    systemMessage: {
      mode: "append",
      content: `${profile.systemMessagePrompt}\n\n${workerEnvelope}`,
    },
    ...(profile.availableTools ? { availableTools: profile.availableTools } : {}),
    ...(profile.excludedTools ? { excludedTools: profile.excludedTools } : {}),
    ...(skillDirectories.length > 0 ? { skillDirectories } : {}),
    ...(skillPolicy.disabledSkills.length > 0
      ? { disabledSkills: skillPolicy.disabledSkills }
      : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
    tools: [
      ...(childDepthRemaining <= 0 || profile.allowedChildProfiles?.length === 0
        ? []
        : [
            options.buildNestedTool(
              childDepthRemaining,
              profile.allowedChildProfiles,
              options.callId,
            ),
          ]),
      ...(options.additionalTools ?? []),
    ],
    onPermissionRequest: createRlmProfilePermissionHandler(
      profile,
      preparedSkills,
      options.onPermissionRequest,
      options.workingDirectory ?? process.cwd(),
    ),
    ...(options.onUserInputRequest ? { onUserInputRequest: options.onUserInputRequest } : {}),
    streaming: options.enableStreaming ?? true,
  };
}

export function createRlmProfilePermissionHandler(
  profile: RlmProfile,
  preparedSkills: PreparedRlmProfileSkills | undefined,
  fallback: PermissionHandler,
  repositoryRoot?: string,
): PermissionHandler {
  if (!profile.preparedFilesystemAccess) {
    return profile.writableSubpaths?.length
      ? createDestinationScopedPermissionHandler(profile, fallback, repositoryRoot ?? process.cwd())
      : fallback;
  }
  if (!preparedSkills?.workingDirectory) {
    throw new RlmSkillPolicyError(
      `RLM profile "${profile.name}" requires a prepared working directory for filesystem access.`,
    );
  }

  const readableRoots = [
    resolve(preparedSkills.workingDirectory),
    ...preparedSkills.skillDirectories.map((directory) => resolve(directory)),
  ];
  const writableRoot = resolve(preparedSkills.workingDirectory);
  const reject = (feedback: string): PermissionRequestResult => ({ kind: "reject", feedback });

  return (request, invocation) => {
    switch (request.kind) {
      case "read":
        return pathWithinRoots(request.path, readableRoots)
          ? { kind: "approve-once" }
          : reject("Reads are limited to the prepared skill bundle and working directory.");
      case "write":
        return profile.preparedFilesystemAccess ===
          RlmPreparedFilesystemAccess.WorkingDirectoryWrite &&
          pathWithinRoots(request.fileName, [writableRoot])
          ? { kind: "approve-once" }
          : reject("Writes are limited to the prepared non-repository working directory.");
      case "shell":
        return approvePreparedShell(request, profile, readableRoots, writableRoot, reject);
      case "mcp":
        return request.readOnly
          ? fallback(request, invocation)
          : reject("This profile may invoke only read-only MCP tools.");
      case "hook":
      case "extension-management":
      case "extension-permission-access":
        return reject("This profile cannot approve capability-changing operations.");
      case "url":
      case "memory":
      case "custom-tool":
        return fallback(request, invocation);
    }
  };
}

/**
 * Permission handler for a profile that must read the repository to do its job but must not change
 * it. Reads stay unrestricted; writes are confined to the profile's own output directories, so a
 * reviewer cannot modify the evidence it judges. Shell obeys the same rule, otherwise `bash` would
 * be a bypass around it.
 */
function createDestinationScopedPermissionHandler(
  profile: RlmProfile,
  fallback: PermissionHandler,
  repositoryRoot: string,
): PermissionHandler {
  const subpaths = profile.writableSubpaths ?? [];
  const writableRoots = subpaths.map((subpath) => resolve(repositoryRoot, subpath));
  const destinations = subpaths.join(", ");
  const reject = (feedback: string): PermissionRequestResult => ({ kind: "reject", feedback });

  return (request, invocation) => {
    switch (request.kind) {
      case "write":
        return pathWithinRoots(request.fileName, writableRoots)
          ? { kind: "approve-once" }
          : reject(`This profile may write only inside ${destinations}; write your output there.`);
      case "shell":
        return approveDestinationScopedShell(request, writableRoots, destinations, reject);
      case "mcp":
        return request.readOnly
          ? fallback(request, invocation)
          : reject("This profile may invoke only read-only MCP tools.");
      case "hook":
      case "extension-management":
      case "extension-permission-access":
        return reject("This profile cannot approve capability-changing operations.");
      case "read":
      case "url":
      case "memory":
      case "custom-tool":
        return fallback(request, invocation);
    }
  };
}

/**
 * Permission handler for the root Submind. The root reads the repository to confirm what a worker
 * reported and runs the run brief's validation commands itself; it never writes. Shell obeys the
 * same rule, otherwise `bash` would be a bypass around it.
 */
export function createReadOnlyPermissionHandler(fallback: PermissionHandler): PermissionHandler {
  const reject = (feedback: string): PermissionRequestResult => ({ kind: "reject", feedback });

  return (request, invocation) => {
    switch (request.kind) {
      case "write":
        return reject("The root Submind cannot write; delegate every repository change.");
      case "shell":
        if (request.requestSandboxBypass || request.commands.length === 0) {
          return reject("Sandbox bypass and unparsed shell commands are prohibited.");
        }
        return !request.hasWriteFileRedirection &&
          request.commands.every((command) => command.readOnly)
          ? { kind: "approve-once" }
          : reject("The root Submind may run only read-only shell commands; delegate the rest.");
      case "mcp":
        return request.readOnly
          ? fallback(request, invocation)
          : reject("The root Submind may invoke only read-only MCP tools.");
      case "hook":
      case "extension-management":
      case "extension-permission-access":
        return reject("The root Submind cannot approve capability-changing operations.");
      case "read":
      case "url":
      case "memory":
      case "custom-tool":
        return fallback(request, invocation);
    }
  };
}

function approveDestinationScopedShell(
  request: Extract<PermissionRequest, { kind: "shell" }>,
  writableRoots: readonly string[],
  destinations: string,
  reject: (feedback: string) => PermissionRequestResult,
): PermissionRequestResult {
  if (request.requestSandboxBypass || request.commands.length === 0) {
    return reject("Sandbox bypass and unparsed shell commands are prohibited.");
  }
  if (!request.hasWriteFileRedirection && request.commands.every((command) => command.readOnly)) {
    return { kind: "approve-once" };
  }
  return request.possiblePaths.length > 0 &&
    request.possiblePaths.every((path) => pathWithinRoots(path, writableRoots))
    ? { kind: "approve-once" }
    : reject(`Shell commands that write must target ${destinations}; reads are unrestricted.`);
}

function approvePreparedShell(
  request: Extract<PermissionRequest, { kind: "shell" }>,
  profile: RlmProfile,
  readableRoots: readonly string[],
  writableRoot: string,
  reject: (feedback: string) => PermissionRequestResult,
): PermissionRequestResult {
  if (request.requestSandboxBypass || request.commands.length === 0) {
    return reject("Sandbox bypass and unparsed shell commands are prohibited.");
  }
  const writesAllowed =
    profile.preparedFilesystemAccess === RlmPreparedFilesystemAccess.WorkingDirectoryWrite;
  if (
    !writesAllowed &&
    (request.hasWriteFileRedirection || request.commands.some((command) => !command.readOnly))
  ) {
    return reject("This profile permits provider detection only through read-only shell commands.");
  }
  const allowedRoots = writesAllowed ? [writableRoot, ...readableRoots] : readableRoots;
  return request.possiblePaths.every((path) => pathWithinRoots(path, allowedRoots))
    ? { kind: "approve-once" }
    : reject("Shell file access is limited to prepared non-repository paths.");
}

function pathWithinRoots(path: string, roots: readonly string[]): boolean {
  if (!isAbsolute(path)) return false;
  const resolvedPath = resolve(path);
  return roots.some((root) => {
    const child = relative(root, resolvedPath);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
}

function assertNoWriteProfileWorkspace(
  profile: RlmProfile,
  preparedSkills: PreparedRlmProfileSkills | undefined,
): void {
  if (
    !profile.repositoryWritePermission &&
    profile.availableTools?.includes("bash") &&
    !profile.writableSubpaths?.length &&
    (!preparedSkills?.workingDirectory || !profile.preparedFilesystemAccess)
  ) {
    throw new RlmSkillPolicyError(
      `RLM profile "${profile.name}" has shell access without configured isolated filesystem access.`,
    );
  }
}

function collectSkillDirectories(
  profile: RlmProfile,
  preparedSkills: PreparedRlmProfileSkills | undefined,
): string[] {
  return [...(profile.skillDirectories ?? []), ...(preparedSkills?.skillDirectories ?? [])];
}

export function buildRlmWorkerExecutionEnvelope(
  profile: RlmProfile,
  context: {
    remainingDepth: number;
    budget: RlmExecutionBudgetSnapshot;
    runId?: string;
    callId?: string;
    parentCallId?: string;
    dependencyCallIds?: readonly string[];
  },
): string {
  const allowedChildren = profile.allowedChildProfiles?.length
    ? profile.allowedChildProfiles.join(", ")
    : "none";
  return [
    "# Worker Execution Envelope",
    `Profile: ${profile.name}`,
    `Authority: ${profile.authority}`,
    `Repository write permission: ${profile.repositoryWritePermission ? "allowed" : "prohibited"}`,
    ...(profile.preparedFilesystemAccess
      ? [`Prepared filesystem access: ${profile.preparedFilesystemAccess}`]
      : []),
    `Remaining recursion depth: ${context.remainingDepth}`,
    `Remaining call budget: ${context.budget.remainingCalls}/${context.budget.maxCalls}`,
    `Allowed child profiles: ${allowedChildren}`,
    ...(context.runId ? [`Run ID: ${context.runId}`] : []),
    ...(context.callId ? [`Call ID: ${context.callId}`] : []),
    ...(context.parentCallId ? [`Parent call ID: ${context.parentCallId}`] : []),
    `Dependency call IDs: ${context.dependencyCallIds?.join(", ") || "none"}`,
    "",
    "Own and complete the bounded task according to this authority. You may recursively delegate " +
      "only narrower work to the allowed child profiles, but you remain accountable for the " +
      "correctness, integration, and verified output of the complete bounded task.",
    profile.repositoryWritePermission
      ? "Implement the requested bounded repository changes and verify them before returning."
      : "Do not create, modify, delete, or rename repository files.",
  ].join("\n");
}

export async function prepareRlmSkillPolicy(
  client: RlmClient,
  options: {
    allowedSkillNames: readonly string[];
    allowedSkillDirectories: readonly string[];
    projectPaths?: string[];
  },
): Promise<RlmSkillPolicy> {
  const policy: RlmSkillPolicy = {
    allowedSkillNames: [...options.allowedSkillNames],
    allowedSkillDirectories: options.allowedSkillDirectories.map((directory) => resolve(directory)),
    disabledSkills: [],
  };
  if (policy.allowedSkillDirectories.length === 0) {
    if (policy.allowedSkillNames.length > 0) {
      throw new RlmSkillPolicyError(
        "Allowed skill names require at least one prepared skill directory.",
      );
    }
    return policy;
  }
  if (!client.rpc) {
    throw new RlmSkillPolicyError(
      "Copilot SDK skill discovery is unavailable; refusing to enable explicit skill directories.",
    );
  }

  const discovered = await client.rpc.skills.discover({
    ...(options.projectPaths ? { projectPaths: options.projectPaths } : {}),
    skillDirectories: [...policy.allowedSkillDirectories],
  });
  const allowedNames = new Set(policy.allowedSkillNames);
  const blockedNames = new Set<string>();
  const allowedDiscoveredNames = new Set<string>();
  for (const skill of discovered.skills) {
    if (allowedNames.has(skill.name) && isAllowedSkillPath(skill.path, policy)) {
      allowedDiscoveredNames.add(skill.name);
    } else {
      blockedNames.add(skill.name);
    }
  }
  for (const name of allowedDiscoveredNames) {
    if (blockedNames.has(name)) {
      throw new RlmSkillPolicyError(
        `Skill "${name}" was discovered from both allowed and disallowed paths; refusing an ` +
          "ambiguous name-based enablement.",
      );
    }
  }
  const missing = policy.allowedSkillNames.filter((name) => !allowedDiscoveredNames.has(name));
  if (missing.length > 0) {
    throw new RlmSkillPolicyError(
      `Allowed skills were not discovered from the prepared profile directories: ${missing.join(", ")}`,
    );
  }
  policy.disabledSkills = [...blockedNames].sort();
  return policy;
}

export async function assertRlmSessionSkillPolicy(
  session: RlmSession,
  policy: RlmSkillPolicy,
): Promise<void> {
  if (!session.rpc) {
    if (policy.allowedSkillDirectories.length === 0 && policy.allowedSkillNames.length === 0)
      return;
    throw new RlmSkillPolicyError(
      "Copilot SDK session skill listing is unavailable; refusing to send the worker prompt.",
    );
  }
  await session.rpc.skills.ensureLoaded();
  const listed = await session.rpc.skills.list();
  const allowedNames = new Set(policy.allowedSkillNames);
  const invalid = listed.skills.filter(
    (skill) =>
      skill.enabled && (!allowedNames.has(skill.name) || !isAllowedSkillPath(skill.path, policy)),
  );
  if (invalid.length > 0) {
    throw new RlmSkillPolicyError(
      "Enabled skills outside the profile manifest/path: " +
        invalid
          .map((skill) => `${skill.name} (${skill.source}:${skill.path ?? "no-path"})`)
          .join(", "),
    );
  }
  const enabledNames = new Set(
    listed.skills
      .filter((skill) => skill.enabled && isAllowedSkillPath(skill.path, policy))
      .map((skill) => skill.name),
  );
  const missing = policy.allowedSkillNames.filter((name) => !enabledNames.has(name));
  if (missing.length > 0) {
    throw new RlmSkillPolicyError(
      `Allowed skills were not enabled in the recursive session: ${missing.join(", ")}`,
    );
  }
}

function isAllowedSkillPath(path: string | undefined, policy: RlmSkillPolicy): boolean {
  if (!path || !isAbsolute(path)) return false;
  const resolvedPath = resolve(path);
  return policy.allowedSkillDirectories.some((directory) => {
    const child = relative(directory, resolvedPath);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
}

export function computeRlmSessionTimeoutMs(
  profile: RlmProfile,
  depthRemaining: number,
  profiles: RlmProfileRegistry,
  fallbackTimeoutMs = DEFAULT_RLM_SEND_TIMEOUT_MS,
): number {
  const ownTimeout = profile.sendTimeoutMs ?? fallbackTimeoutMs;
  if (depthRemaining <= 1) return ownTimeout;

  const childProfiles = (
    profile.allowedChildProfiles ?? profiles.list().map(({ name }) => name)
  ).map((name) => profiles.resolve(name));
  if (childProfiles.length === 0) return ownTimeout;

  return (
    ownTimeout +
    Math.max(
      ...childProfiles.map((child) =>
        computeRlmSessionTimeoutMs(child, depthRemaining - 1, profiles, fallbackTimeoutMs),
      ),
    )
  );
}

function recordOutput(span: Span, result: RlmCallResult): void {
  span.setAttribute("langfuse.observation.output", JSON.stringify(result));
  span.setAttribute("weavekit.rlm.depth_used", result.depthUsed);
  span.setAttribute("weavekit.rlm.budget.used_calls", result.budget.usedCalls);
  span.setAttribute("weavekit.rlm.budget.remaining_calls", result.budget.remainingCalls);
}

export { RlmCallBudgetExceededError, RlmDepthExceededError, RlmUnknownProfileError };
