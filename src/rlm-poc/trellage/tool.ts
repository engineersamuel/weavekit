import { defineTool, type Tool, type ToolResultObject } from "@github/copilot-sdk";
import { ScopedHerdr } from "../../herdr/scope.js";
import { createHerdrClient } from "../../herdr/client.js";
import {
  claimRlmExecutionBudget,
  snapshotRlmExecutionBudget,
  type RlmExecutionBudget,
} from "../budget.js";
import { RlmCallBudgetExceededError } from "../contracts.js";
import type { CopilotModelCatalog } from "../modelCatalog.js";
import { buildTrellageCommand, type TrellageCatalog } from "./catalog.js";
import {
  TrellageOutcome,
  TrellageHarness,
  TrellageMode,
  TrellageEffortOverrideError,
  TrellageModelOverrideError,
  TrellageUnavailableError,
  TrellageUnhealthyProfileError,
  TrellageUnknownProfileError,
  createTrellageToolJsonSchema,
  type TrellageInvokeArgs,
  type TrellageInvokeResult,
} from "./contracts.js";
import { runTrellageDriveLoop, type TrellageAnswerer } from "./driveLoop.js";
import { createHerdrTrellageBackend } from "./herdrBackend.js";
import { prepareResultLocation, resolveResultLocation, writeTaskDocument } from "./result.js";
import { withTrellageSpan } from "./telemetry.js";
import type { TrellageWorktreeRegistry } from "./worktrees.js";
import type { TrellageBackend } from "./backend.js";

/** Readiness values that mean the profile cannot be trusted to run. */
const UNHEALTHY_READINESS = new Set(["unhealthy", "broken", "error", "failed"]);

export const DEFAULT_TRELLAGE_TIMEOUT_MS = 45 * 60_000;
export const DEFAULT_TRELLAGE_MAX_TURNS = 12;
export const DEFAULT_TRELLAGE_MAX_CONCURRENT = 2;

export type CreateTrellageToolOptions = {
  runId: string;
  catalog: TrellageCatalog;
  worktrees: TrellageWorktreeRegistry;
  /** Repository the RLM run started in; every delegated harness works in its worktree. */
  repositoryPath: string;
  /** Answers questions the delegated harness asks, on behalf of the root Submind. */
  answer: TrellageAnswerer;
  executionBudget: RlmExecutionBudget;
  timeoutMs?: number;
  maxTurns?: number;
  /** Overridable purely so tests do not pay the drive loop's real polling delays. */
  sleep?: (ms: number) => Promise<void>;
  /** Panes are scarce and user-visible, so concurrent harnesses are capped separately. */
  maxConcurrent?: number;
  modelCatalog?: CopilotModelCatalog;
  /** Overrides the Herdr-backed backend; tests supply a fake so they never need a real TTY. */
  createBackend?: (input: {
    workspaceId: string;
    worktreePath: string;
    agentPrefix: string;
  }) => Promise<{ backend: TrellageBackend; close: () => void }>;
};

/**
 * Builds the `invoke_trellage` tool (ADR 0011): delegate a task to a *different* agent harness,
 * running under a Trellage profile, in its own PTY and its own git worktree.
 *
 * This is the complement to `rlm`. `rlm` recurses Copilot-on-Copilot in-process and shares this
 * process's tooling; `invoke_trellage` hands work to a discovered foreign harness with its real
 * plugin and skill stack, which is the whole reason to reach outside this process.
 */
export function createTrellageTool(options: CreateTrellageToolOptions): Tool<TrellageInvokeArgs> {
  const profiles = options.catalog.list();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRELLAGE_TIMEOUT_MS;
  const maxTurns = options.maxTurns ?? DEFAULT_TRELLAGE_MAX_TURNS;
  const gate = createConcurrencyGate(options.maxConcurrent ?? DEFAULT_TRELLAGE_MAX_CONCURRENT);
  const copilotModelNames = options.modelCatalog
    ? [
        ...new Set(
          Object.values(options.modelCatalog.groups)
            .flat()
            .filter((id) => options.modelCatalog?.models.get(id)?.capabilities.toolCall),
        ),
      ]
    : [];
  let callNumber = 0;

  return defineTool<TrellageInvokeArgs>("invoke_trellage", {
    description:
      "Delegate a bounded task to a different agent harness running under a Trellage profile " +
      "selected from the current `trellage list --json` and `trx list --json` inventories. " +
      "Native discovery falls back to each launcher's own `list --json` if `trx` cannot aggregate. " +
      "Prefer this over `rlm` when the task genuinely needs another harness's tooling rather than another " +
      "Copilot session. Choose by capability first; among equally suitable profiles prefer a " +
      "sandboxed native launcher, then a container, then an unsandboxed native launcher. An " +
      "unsandboxed profile remains valid when its harness capability materially fits better. " +
      "Every profile runs through a Herdr-owned interactive PTY, allowing this call to read its " +
      "screen and answer questions until the result contract is complete. The delegated harness " +
      "starts with no conversation context and works inside a dedicated git worktree, so include " +
      "everything it needs in the prompt. It cannot delegate further, and this call blocks until " +
      "it finishes. A model override is supported for native Copilot (`cpx`) profiles (validated " +
      "against the run's model catalog) and for native Claude (`cldx`) profiles (the harness's " +
      "own model IDs, e.g. `claude-opus-5`); other profiles own their model configuration. " +
      "An `effort` override (e.g. `xhigh`) is supported only for native Claude (`cldx`) " +
      "profiles.\n\nAvailable profiles (safety-preferred order):\n" +
      profiles
        .map(
          (profile) =>
            `- ${profile.harness} / ${profile.name} [${profile.mode}, ` +
            `${profile.sandbox ? "sandboxed" : "unsandboxed"}; launcher=${profile.launcher}]: ` +
            profile.description,
        )
        .join("\n"),
    parameters: createTrellageToolJsonSchema(profiles, copilotModelNames),
    handler: async (args, invocation): Promise<ToolResultObject> => {
      try {
        const profile = options.catalog.resolve(args.harness, args.profile);
        const isNativeCopilot =
          profile.harness === TrellageHarness.Copilot &&
          profile.mode === TrellageMode.Native &&
          profile.launcher === "cpx";
        const isNativeClaude =
          profile.harness === TrellageHarness.Claude &&
          profile.mode === TrellageMode.Native &&
          profile.launcher === "cldx";
        if (args.model) {
          if (!isNativeCopilot && !isNativeClaude) {
            throw new TrellageModelOverrideError(
              "Model overrides are supported only for native Copilot (`cpx`) or native Claude " +
                "(`cldx`) profiles.",
            );
          }
          if (isNativeCopilot && !copilotModelNames.includes(args.model)) {
            throw new TrellageModelOverrideError(
              `Copilot model "${args.model}" is not in the current validated catalog candidates.`,
            );
          }
        }
        if (args.effort && !isNativeClaude) {
          throw new TrellageEffortOverrideError(
            "Effort overrides are supported only for native Claude (`cldx`) profiles.",
          );
        }
        const readiness = await options.catalog.readiness(profile);
        if (readiness && UNHEALTHY_READINESS.has(readiness.toLowerCase())) {
          throw new TrellageUnhealthyProfileError(profile.name, readiness);
        }
        const budget = claimRlmExecutionBudget(options.executionBudget);
        callNumber += 1;
        const callId = `${invocation.toolCallId ?? `call-${callNumber}`}`;
        const worktree = await options.worktrees.acquire(options.repositoryPath);
        const command = buildTrellageCommand(profile, args.model, args.effort).join(" ");

        const invoke = async (): Promise<TrellageInvokeResult> =>
          gate.run(() =>
            withTrellageSpan(
              {
                harness: args.harness,
                profile,
                prompt: args.prompt,
                command,
                worktreePath: worktree.worktreePath,
                branchName: worktree.branchName,
                ...(invocation.toolCallId ? { toolCallId: invocation.toolCallId } : {}),
                callNumber,
              },
              async (span) => {
                const location = resolveResultLocation(
                  worktree.worktreePath,
                  options.runId,
                  callId,
                );
                await prepareResultLocation(location);
                const launchPrompt = await writeTaskDocument(location, args.prompt);
                const agentPrefix = `rlm-t-${options.runId}`;
                const factory = options.createBackend ?? defaultBackendFactory;
                const { backend, close } = await factory({
                  workspaceId: worktree.workspaceId,
                  worktreePath: worktree.worktreePath,
                  agentPrefix,
                });
                try {
                  const session = await backend.launch({
                    profile,
                    ...(args.model ? { model: args.model } : {}),
                    ...(args.effort ? { effort: args.effort } : {}),
                    cwd: worktree.worktreePath,
                    label: `${agentPrefix}-${callNumber}`,
                  });
                  try {
                    const loop = await runTrellageDriveLoop({
                      backend,
                      session,
                      location,
                      prompt: launchPrompt,
                      answer: options.answer,
                      timeoutMs,
                      maxTurns,
                      ...(options.sleep ? { sleep: options.sleep } : {}),
                    });
                    span.setAttribute(
                      "langfuse.observation.output",
                      JSON.stringify({
                        outcome: loop.outcome,
                        turns: loop.turns,
                        transitions: loop.transitions,
                      }),
                    );
                    return {
                      text: loop.text,
                      outcome: loop.outcome,
                      harness: args.harness,
                      profile: profile.name,
                      ...(args.model ? { model: args.model } : {}),
                      ...(args.effort ? { effort: args.effort } : {}),
                      mode: profile.mode,
                      sandbox: profile.sandbox,
                      worktreePath: worktree.worktreePath,
                      branchName: worktree.branchName,
                      turns: loop.turns,
                      ...(loop.userInputs.length ? { userInputs: loop.userInputs } : {}),
                      ...(loop.evidence ? { evidence: loop.evidence } : {}),
                    };
                  } finally {
                    await backend.dispose(session);
                  }
                } finally {
                  close();
                }
              },
            ),
          );

        // Read-only work cannot corrupt a shared checkout, so it skips the per-worktree mutex and
        // is bounded only by the concurrency gate.
        const result = args.readOnly
          ? await invoke()
          : await options.worktrees.withExclusiveAccess(options.repositoryPath, invoke);

        return {
          textResultForLlm: JSON.stringify(result),
          resultType: result.outcome === TrellageOutcome.Completed ? "success" : "failure",
          ...(result.outcome === TrellageOutcome.Completed
            ? {}
            : { error: `harness outcome: ${result.outcome}` }),
          toolTelemetry: {
            invoke_trellage: {
              harness: args.harness,
              profile: profile.name,
              ...(args.model ? { model: args.model } : {}),
              ...(args.effort ? { effort: args.effort } : {}),
              mode: profile.mode,
              sandbox: profile.sandbox,
              outcome: result.outcome,
              turns: result.turns,
              budget,
            },
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          textResultForLlm: JSON.stringify({
            error: message,
            budget: snapshotRlmExecutionBudget(options.executionBudget),
            ...(isUsageError(error)
              ? {
                  hint:
                    "Pick a harness/profile pair from the tool description, or fall back to " +
                    "`rlm` if no Trellage profile fits.",
                }
              : {}),
          }),
          resultType: "failure",
          error: message,
        };
      }
    },
  });
}

function isUsageError(error: unknown): boolean {
  return (
    error instanceof TrellageUnknownProfileError ||
    error instanceof TrellageUnhealthyProfileError ||
    error instanceof TrellageUnavailableError ||
    error instanceof TrellageModelOverrideError ||
    error instanceof TrellageEffortOverrideError ||
    error instanceof RlmCallBudgetExceededError
  );
}

const defaultBackendFactory: NonNullable<CreateTrellageToolOptions["createBackend"]> = async (
  input,
) => {
  const client = await createHerdrClient(input.worktreePath);
  return {
    backend: createHerdrTrellageBackend(new ScopedHerdr(client, input)),
    close: () => client.close(),
  };
};

/**
 * Bounds how many harness panes exist at once, independently of the shared call budget.
 *
 * The slot is handed directly to the next waiter rather than released and re-acquired, so the
 * limit cannot be briefly exceeded by a caller arriving between the two.
 */
function createConcurrencyGate(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
      else active += 1;
      try {
        return await operation();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
      }
    },
  };
}
