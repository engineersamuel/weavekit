import { approveAll, defineTool, type Tool, type ToolResultObject } from "@github/copilot-sdk";
import { buildDefaultCopilotClientOptions } from "../telemetry/copilotSdk.js";
import {
  DEFAULT_RLM_MAX_TOTAL_CALLS,
  createRlmExecutionBudget,
  snapshotRlmExecutionBudget,
  type RlmExecutionBudget,
} from "./budget.js";
import { attachConsoleStreaming } from "./consoleStreaming.js";
import { snapshotConversation } from "./conversationContext.js";
import { writeRlmOutput } from "./environment.js";
import {
  RlmDepthExceededError,
  RlmProfileNotAllowedError,
  RlmCallBudgetExceededError,
  RlmUnknownProfileError,
  createRlmToolJsonSchema,
  type RlmToolArgs,
  type RlmUserInputExchange,
} from "./contracts.js";
import { defaultRlmProfileRegistry, type RlmProfileRegistry } from "./profiles.js";
import {
  RLM_ANSWERER_MODEL_POLICY,
  resolveRlmModelCandidates,
  resolveRlmModelDecision,
  resolveRlmProfileModelDecision,
  type CopilotModelCatalog,
  type RlmModelDecision,
} from "./modelCatalog.js";
import type { PrepareRlmProfileSkills } from "./profileSkills.js";
import {
  RlmCallExecutionStatus,
  RlmRunStateError,
  beginRlmCall,
  failRlmCall,
  resolveRlmDependencies,
  snapshotRlmRunState,
  succeedRlmCall,
  type RlmRunState,
} from "./runState.js";
import {
  executeRlm,
  DEFAULT_RLM_SEND_TIMEOUT_MS,
  type RlmClient,
  type RlmClientFactory,
  type RlmSessionReference,
} from "./session.js";
import { createConsoleUserInputHandler, createSubmindUserInputHandler } from "./userInput.js";
import {
  RlmVisualizationAction,
  RlmVisualizationStatus,
  type RlmVisualizationObserver,
} from "./visualization/contracts.js";
import type { RlmWorkerContract } from "./workerContract.js";

export type RlmAskUserMode = "submind" | "console" | "off";

/** Identifies the session that additional tools are being registered on. */
export type RlmAdditionalToolContext = {
  /** The `rlm` call that owns the session, or `undefined` for the root session. */
  parentCallId?: string;
  /** Depth of an action issued from that session. 1 for the root session. */
  depth: number;
};

/**
 * Builds the non-`rlm` tools for one session. It is a factory rather than a fixed array so each
 * session's `invoke_trellage` instance can bind to the `rlm` call that owns it, which is what makes
 * the storyboard's parent-child hierarchy correct at every depth.
 */
export type RlmAdditionalToolFactory = (context: RlmAdditionalToolContext) => readonly unknown[];

export type CreateRlmToolOptions = {
  /** Recursion budget remaining for a call made *at this level*. Decremented per hop, never by the LLM. */
  depthRemaining: number;
  /** The configured maximum, carried through for `depthUsed` reporting. */
  maxDepth: number;
  profiles?: RlmProfileRegistry;
  /** Immutable model catalog snapshot shared by the root and every recursive tool. */
  modelCatalog?: CopilotModelCatalog;
  /** Independently resolved low-latency model for isolated ask_user answerers. */
  answererModelDecision?: RlmModelDecision;
  clientFactory?: RlmClientFactory;
  /** Repository/worktree root inherited by every recursive session. */
  workingDirectory?: string;
  prepareProfileSkills?: PrepareRlmProfileSkills;
  sendTimeoutMs?: number;
  /** When true (the default), nested session output streams to `process.stdout` in real time. */
  consoleStreaming?: boolean;
  /**
   * Controls how the nested session's native `ask_user` tool calls are answered:
   * - `"submind"` (the default) - answered by a fresh, independent, single-shot session told
   *   exactly what *this* `rlm` call was asked to do and grounded in the root Submind's current
   *   conversation snapshot, without live-session reentrancy or human involvement.
   * - `"console"` - answered by a real human via a blocking terminal prompt (stdin).
   * - `"off"` - `ask_user` is not enabled on the nested session.
   */
  askUserMode?: RlmAskUserMode;
  /** Lazy reference to the root Submind session; shared unchanged through the recursion tree. */
  rootSessionReference?: RlmSessionReference;
  /** Internal propagation hook that bubbles descendant ask_user exchanges toward the root. */
  onUserInputCaptured?: (exchange: RlmUserInputExchange) => void;
  /** Root-only total-call limit. Descendants share `executionBudget` instead. */
  maxTotalCalls?: number;
  /** Internal mutable budget shared by all tools in one recursion tree. */
  executionBudget?: RlmExecutionBudget;
  /** Root-owned semantic state shared by all tools in one recursion tree. */
  runState?: RlmRunState;
  /** Typed prompt/output boundary used by general Submind workers. */
  workerContract?: RlmWorkerContract;
  /** Call that owns the session on which this recursively registered tool is exposed. */
  parentCallId?: string;
  /**
   * Storyboard-only parent identity, used when the run has no semantic state model and therefore
   * no `parentCallId`. Kept separate so a synthetic identifier never reaches the LLM payload.
   */
  visualizationParentCallId?: string;
  /** Restricts profile switching for capability-scoped roots and recursive sessions. */
  allowedProfiles?: readonly string[];
  /**
   * Tools registered on every nested session in addition to `rlm` itself. Used to make
   * `invoke_trellage` reachable from recursive sessions, not just the root (ADR 0011).
   */
  additionalTools?: RlmAdditionalToolFactory;
  /** Run-owned storyboard recorder shared by the root, every nested tool, and every Trellage tool. */
  visualization?: RlmVisualizationObserver;
};

const defaultClientFactory: RlmClientFactory = async (context) => {
  const { CopilotClient } = await import("@github/copilot-sdk");
  const options = await buildDefaultCopilotClientOptions();
  const environment = context?.preparedSkills?.environment;
  return new CopilotClient({
    ...options,
    ...(environment
      ? {
          env: {
            ...((options.env as NodeJS.ProcessEnv | undefined) ?? process.env),
            ...environment,
          },
        }
      : {}),
  }) as unknown as RlmClient;
};

/**
 * Builds the `rlm` tool (ADR 0010): calling it spins up a brand-new, clean-slate Copilot SDK
 * session with `rlm` registered on it again (via a recursive call to this same factory, at
 * `depthRemaining - 1`), so the nested session can itself recurse until the depth budget is
 * exhausted.
 */
export function createRlmTool(options: CreateRlmToolOptions): Tool<RlmToolArgs> {
  const profiles = options.profiles ?? defaultRlmProfileRegistry;
  const clientFactory = options.clientFactory ?? defaultClientFactory;
  const sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_RLM_SEND_TIMEOUT_MS;
  const consoleStreaming = options.consoleStreaming ?? true;
  const askUserMode = options.askUserMode ?? "submind";
  const rootSessionReference = options.rootSessionReference ?? {};
  const allowedProfileSet = options.allowedProfiles ? new Set(options.allowedProfiles) : undefined;
  const profileInventory = profiles
    .list()
    .map((profile) => profile.name)
    .filter((name) => !allowedProfileSet || allowedProfileSet.has(name));
  const profileCandidates = new Map(
    profileInventory.map((name) => {
      const profile = profiles.resolve(name);
      return [
        name,
        options.modelCatalog && profile.modelPolicy
          ? resolveRlmModelCandidates(options.modelCatalog, profile.modelPolicy)
          : [],
      ] as const;
    }),
  );
  const modelInventory = [
    ...new Set([...profileCandidates.values()].flat().map((candidate) => candidate.id)),
  ];
  const answererModelDecision =
    options.answererModelDecision ??
    (options.modelCatalog
      ? resolveRlmModelDecision(options.modelCatalog, RLM_ANSWERER_MODEL_POLICY)
      : undefined);
  const executionBudget =
    options.executionBudget ??
    createRlmExecutionBudget(options.maxTotalCalls ?? DEFAULT_RLM_MAX_TOTAL_CALLS);
  if (Boolean(options.runState) !== Boolean(options.workerContract)) {
    throw new Error("RLM run state and worker contract must be configured together.");
  }
  const visualizationParentCallId = options.parentCallId ?? options.visualizationParentCallId;
  let syntheticCalls = 0;

  return defineTool<RlmToolArgs>("rlm", {
    description:
      "Recursively delegate a bounded sub-question or sub-task to a brand-new, independent " +
      "Copilot SDK session. Use this when a piece of work is cleanly separable and benefits " +
      "from a fresh, focused context rather than continuing in this conversation. The nested " +
      "session receives the immutable run brief, the prompt you give it, and only the completed " +
      "reports named in dependsOn. It does not inherit this conversation or the complete run " +
      "ledger, so include all other task-specific context in the prompt. Recursion " +
      `depth is bounded and enforced automatically. Configured profiles: ${profileInventory.join(", ")}.\n` +
      formatModelCandidates(profileCandidates),
    parameters: createRlmToolJsonSchema(profileInventory, modelInventory),
    handler: async (args, invocation): Promise<ToolResultObject> => {
      const userInputExchanges: RlmUserInputExchange[] = [];
      const depthUsed = options.maxDepth - options.depthRemaining + 1;
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      let runningCall: ReturnType<typeof beginRlmCall> | undefined;
      let callId: string | undefined;
      // Every recursive tool shares one recorder, so the call identity must be stable and unique
      // even when the run has no semantic state model to mint one. The parent identity is a prefix,
      // which keeps sibling subtrees distinct at every depth.
      syntheticCalls += 1;
      const syntheticCallId = `${visualizationParentCallId ?? "root"}/${
        invocation.toolCallId ?? `rlm-d${depthUsed}`
      }#${syntheticCalls}`;
      const visualizationCallId = () => callId ?? syntheticCallId;
      const recordCompletion = async (
        status: RlmVisualizationStatus,
        detail: {
          summary?: string;
          error?: string;
          model?: string;
          decisions?: readonly string[];
          artifacts?: readonly string[];
        },
      ): Promise<void> => {
        if (!options.visualization) return;
        // Deliberate non-fatal boundary: a storyboard failure must never change the delegated
        // work's own result, so the failure is reported and then dropped.
        try {
          await options.visualization.recordCompletion({
            action: RlmVisualizationAction.Rlm,
            status,
            callId: visualizationCallId(),
            ...(visualizationParentCallId ? { parentCallId: visualizationParentCallId } : {}),
            dependencyCallIds: args.dependsOn ?? [],
            depth: depthUsed,
            prompt: args.prompt,
            profile: args.profile,
            ...(detail.model ? { model: detail.model } : {}),
            ...(options.workingDirectory ? { worktreePath: options.workingDirectory } : {}),
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAtMs,
            ...(detail.summary ? { summary: detail.summary } : {}),
            ...(detail.error ? { error: detail.error } : {}),
            decisions: detail.decisions ?? [],
            artifacts: detail.artifacts ?? [],
          });
        } catch (visualizationError) {
          writeRlmOutput(
            `[visualization] rlm completion was not recorded: ${
              visualizationError instanceof Error
                ? visualizationError.message
                : String(visualizationError)
            }\n`,
          );
        }
      };
      const captureUserInput = (exchange: RlmUserInputExchange) => {
        userInputExchanges.push(exchange);
        options.onUserInputCaptured?.(exchange);
      };
      const buildNestedTool = (
        depthRemaining: number,
        nestedAllowedProfiles?: readonly string[],
        nestedParentCallId?: string,
      ): Tool<RlmToolArgs> =>
        createRlmTool({
          depthRemaining,
          maxDepth: options.maxDepth,
          profiles,
          ...(options.modelCatalog ? { modelCatalog: options.modelCatalog } : {}),
          ...(answererModelDecision ? { answererModelDecision } : {}),
          clientFactory,
          ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
          ...(options.prepareProfileSkills
            ? { prepareProfileSkills: options.prepareProfileSkills }
            : {}),
          sendTimeoutMs,
          consoleStreaming,
          askUserMode,
          rootSessionReference,
          onUserInputCaptured: captureUserInput,
          executionBudget,
          ...(options.runState ? { runState: options.runState } : {}),
          ...(options.workerContract ? { workerContract: options.workerContract } : {}),
          ...((nestedParentCallId ?? callId) ? { parentCallId: nestedParentCallId ?? callId } : {}),
          visualizationParentCallId: nestedParentCallId ?? callId ?? syntheticCallId,
          ...(nestedAllowedProfiles ? { allowedProfiles: nestedAllowedProfiles } : {}),
          ...(options.additionalTools ? { additionalTools: options.additionalTools } : {}),
          ...(options.visualization ? { visualization: options.visualization } : {}),
        });
      try {
        runningCall = options.runState
          ? beginRlmCall(options.runState, {
              ...(options.parentCallId ? { parentCallId: options.parentCallId } : {}),
              dependencyCallIds: args.dependsOn ?? [],
              profile: args.profile,
              depthUsed,
            })
          : undefined;
        callId = runningCall?.callId;
        if (!profileInventory.includes(args.profile)) {
          throw new RlmProfileNotAllowedError(args.profile);
        }
        const dependencies = options.runState
          ? resolveRlmDependencies(options.runState, args.dependsOn ?? [])
          : [];
        if (!options.runState && args.dependsOn?.length) {
          throw new RlmRunStateError(
            "RLM dependencies require the root-owned general Submind state model.",
          );
        }
        // Disambiguates parallel sibling calls at the same depth (e.g. the three
        // movie/book/color questions), which would otherwise share an identical label and
        // produce indistinguishable interleaved console output.
        const promptSnippet =
          args.prompt.length > 28 ? `${args.prompt.slice(0, 28)}...` : args.prompt;
        const label = `rlm ${args.profile} d${depthUsed}/${options.maxDepth} "${promptSnippet}"`;
        const profile = profiles.resolve(args.profile);
        const modelDecision = resolveRlmProfileModelDecision(
          options.modelCatalog,
          profile.model,
          profile.modelPolicy,
          args.model,
        );
        const onUserInputRequest =
          askUserMode === "submind"
            ? createSubmindUserInputHandler({
                label,
                depthUsed,
                delegatedPrompt: args.prompt,
                getConversationContext: () => snapshotConversation(rootSessionReference),
                model: answererModelDecision?.model ?? modelDecision.model,
                clientFactory,
                ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
                onAnswered: captureUserInput,
                sendTimeoutMs,
              })
            : askUserMode === "console"
              ? createConsoleUserInputHandler({
                  label,
                  depthUsed,
                  onAnswered: captureUserInput,
                })
              : undefined;
        const result = await executeRlm({
          args,
          depthRemaining: options.depthRemaining,
          maxDepth: options.maxDepth,
          profiles,
          toolCallId: invocation.toolCallId,
          ...(options.prepareProfileSkills
            ? { prepareProfileSkills: options.prepareProfileSkills }
            : {}),
          clientFactory,
          modelDecision,
          buildNestedTool,
          onPermissionRequest: approveAll,
          enableStreaming: consoleStreaming,
          ...(consoleStreaming
            ? {
                onSessionCreated: (session) =>
                  attachConsoleStreaming(session, { label, depthUsed }),
              }
            : {}),
          ...(onUserInputRequest ? { onUserInputRequest } : {}),
          userInputExchanges,
          executionBudget,
          sendTimeoutMs,
          ...(options.runState && options.workerContract && callId && runningCall
            ? {
                runId: options.runState.runId,
                callId,
                callNumber: runningCall.callNumber,
                stateRevision: options.runState.revision,
                ...(options.parentCallId ? { parentCallId: options.parentCallId } : {}),
                runBrief: options.runState.brief,
                dependencies,
                workerContract: options.workerContract,
              }
            : {}),
          ...(options.additionalTools
            ? {
                additionalTools: options.additionalTools({
                  parentCallId: callId ?? syntheticCallId,
                  depth: depthUsed + 1,
                }),
              }
            : {}),
        });
        if (options.runState && callId) {
          if (!result.report) {
            throw new RlmRunStateError(
              `RLM call "${callId}" completed without the required typed worker report.`,
            );
          }
          succeedRlmCall(options.runState, callId, {
            model: result.model,
            report: result.report,
          });
        }
        const payload = {
          ...result,
          ...(!options.parentCallId && options.runState
            ? { state: snapshotRlmRunState(options.runState) }
            : {}),
        };
        await recordCompletion(RlmVisualizationStatus.Succeeded, {
          summary: result.report?.summary ?? result.text,
          model: result.model,
          decisions: result.report?.decisions ?? [],
          artifacts: (result.report?.artifacts ?? []).map(
            (artifact) => `${artifact.locator} - ${artifact.description}`,
          ),
        });
        return {
          textResultForLlm: JSON.stringify(payload),
          resultType: "success",
          toolTelemetry: {
            rlm: {
              depthUsed: result.depthUsed,
              model: result.model,
              modelRationale: result.modelRationale,
              budget: result.budget,
            },
          },
        };
      } catch (error) {
        if (
          options.runState &&
          callId &&
          options.runState.calls.get(callId)?.status === RlmCallExecutionStatus.Running
        ) {
          failRlmCall(
            options.runState,
            callId,
            error instanceof Error ? error.message : String(error),
          );
        }
        const stateMetadata = {
          ...(options.runState ? { runId: options.runState.runId } : {}),
          ...(callId ? { callId } : {}),
          ...(options.parentCallId ? { parentCallId: options.parentCallId } : {}),
          ...(args.dependsOn?.length ? { dependencyCallIds: [...args.dependsOn] } : {}),
          ...(!options.parentCallId && options.runState
            ? { state: snapshotRlmRunState(options.runState) }
            : {}),
        };
        await recordCompletion(RlmVisualizationStatus.Failed, {
          error: error instanceof Error ? error.message : String(error),
          ...(args.model ? { model: args.model } : {}),
        });
        if (
          error instanceof RlmCallBudgetExceededError ||
          error instanceof RlmDepthExceededError ||
          error instanceof RlmProfileNotAllowedError ||
          error instanceof RlmUnknownProfileError ||
          error instanceof RlmRunStateError
        ) {
          const message = error.message;
          const budget = snapshotRlmExecutionBudget(executionBudget);
          return {
            textResultForLlm: JSON.stringify({
              error: message,
              budget,
              ...stateMetadata,
              ...(userInputExchanges.length ? { userInputs: userInputExchanges } : {}),
            }),
            resultType: "failure",
            error: message,
            toolTelemetry: {
              rlm: {
                depthUsed: options.maxDepth - options.depthRemaining + 1,
                budget,
              },
            },
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        const budget = snapshotRlmExecutionBudget(executionBudget);
        return {
          textResultForLlm: JSON.stringify({
            error: `rlm call failed: ${message}`,
            budget,
            ...stateMetadata,
            ...(userInputExchanges.length ? { userInputs: userInputExchanges } : {}),
          }),
          resultType: "failure",
          error: message,
          toolTelemetry: {
            rlm: {
              depthUsed: options.maxDepth - options.depthRemaining + 1,
              budget,
            },
          },
        };
      }
    },
  });
}

function formatModelCandidates(
  profiles: ReadonlyMap<string, readonly { id: string; name: string; description: string }[]>,
): string {
  const lines = [...profiles]
    .filter(([, candidates]) => candidates.length > 0)
    .map(
      ([profile, candidates]) =>
        `- ${profile}: ${candidates
          .map((candidate) => `${candidate.id} (${candidate.name}: ${candidate.description})`)
          .join("; ")}`,
    );
  return lines.length > 0
    ? `Current validated model candidates by profile:\n${lines.join("\n")}`
    : "Profiles use their configured fixed model fallbacks.";
}
