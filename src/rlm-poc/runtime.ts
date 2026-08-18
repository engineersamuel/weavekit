import { approveAll, CopilotClient } from "@github/copilot-sdk";
import type { SessionConfig } from "@github/copilot-sdk";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { RlmRunBrief } from "../generated/baml_client/types.js";
import { buildDefaultCopilotClientOptions } from "../telemetry/copilotSdk.js";
import {
  DEFAULT_RLM_MAX_TOTAL_CALLS,
  createRlmExecutionBudget,
  snapshotRlmExecutionBudget,
} from "./budget.js";
import { attachConsoleStreaming } from "./consoleStreaming.js";
import {
  RLM_ROOT_CAPABILITY_MANIFEST,
  RlmProfileName,
  createRlmRootAvailableTools,
  defaultRlmProfileRegistry,
  type RlmProfileRegistry,
} from "./profiles.js";
import {
  prepareRlmRootSkills,
  type PrepareRlmProfileSkills,
  type PrepareRlmRootSkills,
} from "./profileSkills.js";
import {
  computeRlmSessionTimeoutMs,
  DEFAULT_RLM_SEND_TIMEOUT_MS,
  assertRlmSessionSkillPolicy,
  createReadOnlyPermissionHandler,
  prepareRlmSkillPolicy,
  type RlmClient,
  type RlmClientFactory,
  type RlmSessionReference,
} from "./session.js";
import { buildRlmSubmindSystemPrompt } from "./submindPrompt.js";
import { snapshotConversation } from "./conversationContext.js";
import {
  createRlmRunState,
  hydrateRlmRunState,
  interruptRunningRlmCalls,
  parseRlmRunStateSnapshot,
  setRlmRunBrief,
  setRlmRunIdentity,
  snapshotRlmRunState,
  type RlmRunState,
  type RlmRunStateSnapshot,
} from "./runState.js";
import {
  createTrellageAnswerer,
  setupTrellageIntegration,
  type TrellageIntegration,
} from "./trellage/integration.js";
import type { TrellageWorktreeDisposition } from "./trellage/worktrees.js";
import { buildRlmRootSpanName } from "./telemetry.js";
import { createRlmTool } from "./tool.js";
import {
  RLM_ANSWERER_MODEL_POLICY,
  loadCopilotModelCatalogWithFallback,
  resolveRlmModelDecision,
  type CopilotModelCatalog,
} from "./modelCatalog.js";
import {
  bamlRlmWorkerContract,
  emptyRlmRunBrief,
  resolveRlmRunBrief,
  type RlmWorkerContract,
} from "./workerContract.js";

export const DEFAULT_RLM_MAX_DEPTH = 3;
export const DEFAULT_RLM_MODEL = "gpt-5.6-sol";
type ReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;
export const DEFAULT_RLM_REASONING_EFFORT: ReasoningEffort = "medium";

const tracer = trace.getTracer("weavekit");
const ROOT_TIMEOUT_MARGIN_MS = 20 * 60_000;

export const RLM_VALIDATION_SYSTEM_PROMPT =
  "You are validating recursive Copilot SDK delegation. Follow the requested validation scenario " +
  "exactly, use only the `rlm` tool for delegated questions, and report its returned answers.";

export const RLM_VALIDATION_SCENARIO_PROMPT =
  "Obtain answers to exactly three questions by delegating each one, separately, to the `rlm` " +
  `tool with profile "${RlmProfileName.Validation}": (1) "What is your favorite movie?", ` +
  '(2) "What is your favorite book?", (3) "What is your favorite color?". Make three separate ' +
  "parallel `rlm` calls, one per question - do not answer them yourself and do not combine them. " +
  "In every delegated prompt, require the nested session to call native `ask_user` with the exact " +
  "question and return its answer verbatim. After all three calls return, report the three " +
  "question/answer pairs plainly, one per line.";

export type RlmPrototypeResult = {
  finalText: string;
  runId: string;
  conversationId?: string;
  traceId: string;
  /** Disposition of every Herdr worktree `invoke_trellage` provisioned during the run. */
  worktrees?: TrellageWorktreeDisposition[];
};

export type RlmRuntimeOptions = {
  maxDepth?: number;
  maxTotalCalls?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sendTimeoutMs?: number;
  rootTimeoutMs?: number;
  profiles?: RlmProfileRegistry;
  clientFactory?: RlmClientFactory;
  prepareProfileSkills?: PrepareRlmProfileSkills;
  prepareRootSkills?: PrepareRlmRootSkills;
  /** When true (the default), submind and every nested `rlm` call stream to `process.stdout`. */
  consoleStreaming?: boolean;
  /**
   * Enables the `invoke_trellage` tool, which delegates to foreign agent harnesses in dedicated
   * Herdr worktrees (ADR 0011). Off by default because it launches real, user-visible panes.
   */
  enableTrellage?: boolean;
  /** Provisions the delegation worktree at run start instead of on first delegation. */
  provisionTrellageWorktreeEagerly?: boolean;
  /** Borrows the current live Herdr linked worktree instead of provisioning a sibling. */
  reuseCurrentTrellageWorktree?: boolean;
  /**
   * Roots the root Copilot SDK session in this directory instead of `process.cwd()`. Used to point
   * a Submind run at an arbitrary target repository/worktree (e.g. a Mastermind-provisioned ticket
   * worktree) rather than always operating on the `weavekit` repository itself.
   */
  workingDirectory?: string;
  /** Immutable current-model snapshot. Loaded from ~/.copilot/models.json when omitted. */
  modelCatalog?: CopilotModelCatalog;
  /** Alternate catalog path for tests and operators maintaining a separate nightly snapshot. */
  modelCatalogPath?: string;
  /**
   * Operator-supplied run brief fields. Each present field replaces the value derived from the
   * prompt; absent fields are still derived. Supplying every list skips derivation entirely.
   */
  runBrief?: Partial<RlmRunBrief>;
  /** Injectable typed worker boundary. Defaults to the generated BAML contract. */
  workerContract?: RlmWorkerContract;
};

type RunRlmSessionOptions = RlmRuntimeOptions & {
  prompt: string;
  systemPrompt: string;
  traceName: string;
  conversationId?: string;
  requireConversationId?: boolean;
  /** Restricts the root validation session while leaving the orchestration root unrestricted. */
  availableTools?: string[];
  allowedProfiles?: readonly string[];
  /** Present only for the general Submind path; validation workers remain raw/verbatim. */
  workerContract?: RlmWorkerContract;
};

/**
 * Runs the narrow ADR 0010 validation scenario. The root can only call `rlm`, and every child uses
 * the restricted validation profile, keeping this proof separate from general repository work.
 */
export async function runRlmPrototype(
  options: RlmRuntimeOptions = {},
): Promise<RlmPrototypeResult> {
  const modelCatalog =
    options.modelCatalog ?? (await loadCopilotModelCatalogWithFallback(options.modelCatalogPath));
  return runRlmSession({
    ...options,
    modelCatalog,
    prompt: RLM_VALIDATION_SCENARIO_PROMPT,
    systemPrompt: RLM_VALIDATION_SYSTEM_PROMPT,
    traceName: "rlm-poc-validation-scenario",
    availableTools: ["custom:rlm"],
    allowedProfiles: [RlmProfileName.Validation],
    workerContract: undefined,
  });
}

/** Runs a general recursive Submind session using the profile-aware adapted orchestration prompt. */
export async function runRlmSubmind(
  prompt: string,
  options: RlmRuntimeOptions & { conversationId?: string } = {},
): Promise<RlmPrototypeResult> {
  const profiles = options.profiles ?? defaultRlmProfileRegistry;
  const maxTotalCalls = options.maxTotalCalls ?? DEFAULT_RLM_MAX_TOTAL_CALLS;
  const modelCatalog =
    options.modelCatalog ?? (await loadCopilotModelCatalogWithFallback(options.modelCatalogPath));
  return runRlmSession({
    ...options,
    modelCatalog,
    profiles,
    maxTotalCalls,
    prompt,
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    requireConversationId: true,
    workerContract: options.workerContract ?? bamlRlmWorkerContract,
    systemPrompt: buildRlmSubmindSystemPrompt(profiles, {
      maxTotalCalls,
      ...(options.enableTrellage ? { trellageEnabled: true } : {}),
      modelCatalog,
    }),
    traceName: "rlm-submind",
  });
}

async function runRlmSession(options: RunRlmSessionOptions): Promise<RlmPrototypeResult> {
  const maxDepth = options.maxDepth ?? DEFAULT_RLM_MAX_DEPTH;
  const maxTotalCalls = options.maxTotalCalls ?? DEFAULT_RLM_MAX_TOTAL_CALLS;
  const consoleStreaming = options.consoleStreaming ?? true;
  const sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_RLM_SEND_TIMEOUT_MS;
  const profiles = options.profiles ?? defaultRlmProfileRegistry;
  const rootProfiles = (options.allowedProfiles ?? profiles.list().map(({ name }) => name)).map(
    (name) => profiles.resolve(name),
  );
  const maxReachableChildTimeoutMs = Math.max(
    ...rootProfiles.map((profile) =>
      computeRlmSessionTimeoutMs(profile, maxDepth, profiles, sendTimeoutMs),
    ),
  );
  const rootTimeoutMs =
    options.rootTimeoutMs ?? maxReachableChildTimeoutMs + ROOT_TIMEOUT_MARGIN_MS;
  const executionBudget = createRlmExecutionBudget(maxTotalCalls);
  const modelCatalog =
    options.modelCatalog ?? (await loadCopilotModelCatalogWithFallback(options.modelCatalogPath));
  const answererModelDecision = resolveRlmModelDecision(modelCatalog, RLM_ANSWERER_MODEL_POLICY);
  const preparedRootSkills =
    RLM_ROOT_CAPABILITY_MANIFEST.allowedSkillNames.length > 0
      ? await (options.prepareRootSkills ?? prepareRlmRootSkills)()
      : undefined;
  const rootSkillDirectories = preparedRootSkills?.skillDirectories ?? [];
  const executionRunId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const runState = options.workerContract
    ? createRlmRunState(
        // A resumed turn discards this brief: `restoreRunStateFromConversation` either hydrates
        // the checkpoint or derives from the original prompt, so deriving here would be wasted.
        options.conversationId
          ? { ...emptyRlmRunBrief(options.prompt), ...options.runBrief }
          : await resolveRlmRunBrief(options.prompt, options.workerContract, options.runBrief),
        { runId: options.conversationId ?? executionRunId },
      )
    : undefined;

  return tracer.startActiveSpan(
    buildRlmRootSpanName(options.traceName),
    {
      attributes: {
        "langfuse.trace.name": options.traceName,
        "langfuse.observation.type": "chain",
        "langfuse.observation.input": JSON.stringify({
          prompt: options.prompt,
          mode: options.traceName,
          depthUsed: 0,
          maxDepth,
          maxTotalCalls,
          ...(options.allowedProfiles ? { allowedProfiles: options.allowedProfiles } : {}),
        }),
        "weavekit.rlm.depth_used": 0,
        "weavekit.rlm.run_id": runState?.runId ?? executionRunId,
        "weavekit.rlm.max_depth": maxDepth,
        "weavekit.rlm.budget.max_calls": maxTotalCalls,
        "weavekit.rlm.model_catalog.path": modelCatalog.sourcePath,
        ...(modelCatalog.generatedAt
          ? { "weavekit.rlm.model_catalog.generated_at": modelCatalog.generatedAt }
          : {}),
        ...(modelCatalog.fallbackReason
          ? { "weavekit.rlm.model_catalog.fallback_reason": modelCatalog.fallbackReason }
          : {}),
        "weavekit.rlm.root_model.operator_pin": options.model ?? DEFAULT_RLM_MODEL,
        "weavekit.rlm.root_model.catalog_tool_call":
          modelCatalog.models.get(options.model ?? DEFAULT_RLM_MODEL)?.capabilities.toolCall ??
          false,
        "weavekit.rlm.answerer_model.selected": answererModelDecision.model,
        "weavekit.rlm.answerer_model.rationale": answererModelDecision.rationale,
        "weavekit.rlm.answerer_model.used_fallback": answererModelDecision.usedFallback,
        "weavekit.rlm.answerer_model.candidates": JSON.stringify(
          answererModelDecision.candidates.map(({ id }) => id),
        ),
      },
    },
    async (span) => {
      const defaultClientFactory: RlmClientFactory = async () =>
        new CopilotClient(
          (options.workingDirectory
            ? {
                ...(await buildDefaultCopilotClientOptions()),
                workingDirectory: options.workingDirectory,
              }
            : await buildDefaultCopilotClientOptions()) as ConstructorParameters<
            typeof CopilotClient
          >[0],
        ) as RlmClient;
      const clientFactory = options.clientFactory ?? defaultClientFactory;
      const client = await clientFactory();
      await client.start();
      let trellage: TrellageIntegration | undefined;
      try {
        const rootSkillPolicy = await prepareRlmSkillPolicy(client, {
          allowedSkillNames: RLM_ROOT_CAPABILITY_MANIFEST.allowedSkillNames,
          allowedSkillDirectories: rootSkillDirectories,
          projectPaths: [process.cwd()],
        });
        const rootSessionReference: RlmSessionReference = {
          instructions: options.systemPrompt,
          initialPrompt: options.prompt,
        };
        // Registered on the root *and*, via `additionalTools`, on every recursive session, so any
        // depth can reach a foreign harness rather than routing everything through the root.
        trellage = options.enableTrellage
          ? await setupTrellageIntegration({
              runId: executionRunId,
              executionBudget,
              modelCatalog,
              answer: createTrellageAnswerer({
                model: answererModelDecision.model,
                clientFactory:
                  options.clientFactory ??
                  (async () =>
                    new CopilotClient(await buildDefaultCopilotClientOptions()) as RlmClient),
                getConversationContext: () => snapshotConversation(rootSessionReference),
              }),
              ...(options.provisionTrellageWorktreeEagerly ? { provisionEagerly: true } : {}),
              ...(options.reuseCurrentTrellageWorktree ? { reuseCurrentWorktree: true } : {}),
              ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}),
            })
          : undefined;
        const additionalTools = trellage ? [trellage.tool] : undefined;
        const sessionConfig = {
          model: options.model ?? DEFAULT_RLM_MODEL,
          reasoningEffort: options.reasoningEffort ?? DEFAULT_RLM_REASONING_EFFORT,
          enableConfigDiscovery: true,
          enableSkills: rootSkillDirectories.length > 0,
          memory: { enabled: false },
          systemMessage: { mode: "append", content: options.systemPrompt },
          onPermissionRequest: createReadOnlyPermissionHandler(approveAll),
          streaming: consoleStreaming,
          ...(rootSkillDirectories.length > 0 ? { skillDirectories: rootSkillDirectories } : {}),
          ...(rootSkillPolicy.disabledSkills.length > 0
            ? { disabledSkills: rootSkillPolicy.disabledSkills }
            : {}),
          ...((preparedRootSkills?.workingDirectory ?? options.workingDirectory)
            ? {
                workingDirectory: preparedRootSkills?.workingDirectory ?? options.workingDirectory,
              }
            : {}),
          availableTools: options.availableTools ?? createRlmRootAvailableTools(Boolean(trellage)),
          tools: [
            createRlmTool({
              depthRemaining: maxDepth,
              maxDepth,
              profiles,
              modelCatalog,
              answererModelDecision,
              consoleStreaming,
              rootSessionReference,
              sendTimeoutMs,
              askUserMode: "submind",
              executionBudget,
              ...(runState ? { runState } : {}),
              ...(options.workerContract ? { workerContract: options.workerContract } : {}),
              ...(options.prepareProfileSkills
                ? { prepareProfileSkills: options.prepareProfileSkills }
                : {}),
              clientFactory,
              ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
              ...(options.allowedProfiles ? { allowedProfiles: options.allowedProfiles } : {}),
              ...(additionalTools ? { additionalTools } : {}),
            }),
            ...(additionalTools ?? []),
          ],
        };
        const session = options.conversationId
          ? await resumeRlmSession(client, options.conversationId, sessionConfig)
          : await client.createSession(sessionConfig);
        const conversationId = session.sessionId ?? options.conversationId;
        if (options.requireConversationId && !conversationId) {
          throw new Error("Copilot SDK did not return a conversation ID for the Submind session.");
        }
        if (runState && conversationId) {
          if (options.conversationId) {
            await restoreRunStateFromConversation(
              session,
              runState,
              options.workerContract!,
              options.runBrief,
            );
          } else {
            setRlmRunIdentity(runState, conversationId);
          }
          span.setAttribute("weavekit.rlm.run_id", runState.runId);
        }
        rootSessionReference.current = session;
        const unsubscribe = consoleStreaming
          ? attachConsoleStreaming(session, { label: "submind d0", depthUsed: 0 })
          : undefined;
        try {
          await assertRlmSessionSkillPolicy(session, rootSkillPolicy);
          const response = await session.sendAndWait({ prompt: options.prompt }, rootTimeoutMs);
          const finalText = response?.data?.content ?? "";
          const budget = snapshotRlmExecutionBudget(executionBudget);
          span.setAttribute(
            "langfuse.observation.output",
            JSON.stringify({ text: finalText, depthUsed: 0, budget }),
          );
          span.setAttribute("weavekit.rlm.budget.used_calls", budget.usedCalls);
          span.setAttribute("weavekit.rlm.budget.remaining_calls", budget.remainingCalls);
          if (runState) {
            const state = snapshotRlmRunState(runState);
            span.setAttribute("weavekit.rlm.state.revision", state.revision);
            span.setAttribute("weavekit.rlm.state.call_count", state.calls.length);
            span.setAttribute(
              "weavekit.rlm.state.succeeded_calls",
              state.calls.filter(({ status }) => status === "succeeded").length,
            );
            span.setAttribute(
              "weavekit.rlm.state.failed_calls",
              state.calls.filter(({ status }) => status === "failed").length,
            );
          }
          span.setStatus({ code: SpanStatusCode.OK });
          const worktrees = await trellage?.finalize();
          return {
            finalText,
            runId: runState?.runId ?? executionRunId,
            ...(conversationId ? { conversationId } : {}),
            traceId: span.spanContext().traceId,
            ...(worktrees?.length ? { worktrees } : {}),
          };
        } finally {
          unsubscribe?.();
          await session.disconnect();
        }
      } catch (error) {
        const exception = error instanceof Error ? error : new Error(String(error));
        span.setAttribute(
          "langfuse.observation.output",
          JSON.stringify({ status: "failed", error: exception.message }),
        );
        span.recordException(exception);
        span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
        throw error;
      } finally {
        // Idempotent: a successful run already finalized, leaving nothing to reclaim. This exists
        // so a failed run does not strand an empty Herdr worktree.
        await trellage?.finalize().catch(() => undefined);
        span.end();
        await client.stop();
      }
    },
  );
}

async function restoreRunStateFromConversation(
  session: RlmSessionReference["current"],
  state: RlmRunState,
  workerContract: RlmWorkerContract,
  briefOverrides?: Partial<RlmRunBrief>,
): Promise<void> {
  if (!session?.getEvents) {
    throw new Error("Cannot restore RLM run state: resumed conversation events are unavailable.");
  }
  const events = await session.getEvents();
  let latest: RlmRunStateSnapshot | undefined;
  for (const event of events) {
    if (event.type !== "tool.execution_complete") continue;
    const content = event.data.result?.content;
    const payload = parseJsonObject(content);
    if (!payload || !("state" in payload)) continue;
    const storedState = parseJsonObject(payload.state);
    if (!storedState || !("schemaVersion" in storedState)) continue;
    const snapshot = parseRlmRunStateSnapshot(payload.state, (raw) =>
      workerContract.parseResponse(raw),
    );
    if (!latest || snapshot.revision > latest.revision) {
      latest = snapshot;
    }
  }
  if (latest) {
    hydrateRlmRunState(state, latest);
    interruptRunningRlmCalls(state);
    return;
  }
  const firstUserPrompt = events.find(
    (event) => event.type === "user.message" && event.data.content.trim().length > 0,
  );
  if (firstUserPrompt?.type === "user.message") {
    setRlmRunBrief(
      state,
      await resolveRlmRunBrief(firstUserPrompt.data.content, workerContract, briefOverrides),
    );
    return;
  }
  throw new Error(
    "Cannot restore RLM run state: the conversation has no state checkpoint or original user prompt.",
  );
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

async function resumeRlmSession(
  client: RlmClient,
  conversationId: string,
  sessionConfig: Record<string, unknown>,
) {
  if (!client.resumeSession) {
    throw new Error("The configured Copilot SDK client does not support session resumption.");
  }
  const session = await client.resumeSession(conversationId, sessionConfig);
  if (session.sessionId && session.sessionId !== conversationId) {
    throw new Error(
      `Copilot SDK resumed conversation ${session.sessionId}, expected ${conversationId}.`,
    );
  }
  return session;
}
