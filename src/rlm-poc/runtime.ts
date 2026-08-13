import { approveAll, CopilotClient } from "@github/copilot-sdk";
import type { SessionConfig } from "@github/copilot-sdk";
import { SpanStatusCode, trace } from "@opentelemetry/api";
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
  prepareRlmSkillPolicy,
  type RlmClient,
  type RlmClientFactory,
  type RlmSessionReference,
} from "./session.js";
import { buildRlmSubmindSystemPrompt } from "./submindPrompt.js";
import { snapshotConversation } from "./conversationContext.js";
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

export const DEFAULT_RLM_MAX_DEPTH = 3;
export const DEFAULT_RLM_MODEL = "mai-code-1.1-flash";
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
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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
        const submindSessionReference: RlmSessionReference = {
          instructions: options.systemPrompt,
        };
        // Registered on the root *and*, via `additionalTools`, on every recursive session, so any
        // depth can reach a foreign harness rather than routing everything through the root.
        trellage = options.enableTrellage
          ? await setupTrellageIntegration({
              runId,
              executionBudget,
              modelCatalog,
              answer: createTrellageAnswerer({
                model: answererModelDecision.model,
                clientFactory:
                  options.clientFactory ??
                  (async () =>
                    new CopilotClient(await buildDefaultCopilotClientOptions()) as RlmClient),
                getConversationContext: () => snapshotConversation(submindSessionReference),
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
          systemMessage: { mode: "append", content: options.systemPrompt },
          onPermissionRequest: approveAll,
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
              ownerSessionReference: submindSessionReference,
              sendTimeoutMs,
              askUserMode: "submind",
              executionBudget,
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
        submindSessionReference.current = session;
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
          span.setStatus({ code: SpanStatusCode.OK });
          const worktrees = await trellage?.finalize();
          return {
            finalText,
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
