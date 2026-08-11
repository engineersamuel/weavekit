import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomInt, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  loadSubmindOperatingSkill,
  SUBMIND_OPERATING_SKILL_NAME,
} from "../submind/instructions.js";
import {
  SubmindManifestSchema,
  SubmindOrchestratorModel,
  SubmindRunStatus,
  type SubmindOrchestratorModel as SubmindOrchestratorModelValue,
  type SubmindRunState,
} from "./contracts.js";
import { SubmindStore } from "./store.js";
import { submindSkill } from "./skill.js";

const tracer = trace.getTracer("weavekit");

export type ControllerDependencies = {
  controlRoot: string;
  canonicalRepository(cwd: string): Promise<string>;
  provision(state: SubmindRunState): Promise<{
    worktreePath: string;
    workspaceId: string;
    rootPaneId: string;
  }>;
  stageSkill(worktreePath: string, skillName: string, content: string): Promise<void>;
  preflight(input: { paneId: string; workspaceId: string; worktreePath: string }): Promise<void>;
  startOrchestrator(input: {
    paneId: string;
    workspaceId: string;
    worktreePath: string;
    agentPrefix: string;
    name: string;
    command: string;
    args: string[];
  }): Promise<{ agentId: string }>;
  promptOrchestrator(input: {
    agentId: string;
    workspaceId: string;
    worktreePath: string;
    agentPrefix: string;
    prompt: string;
  }): Promise<void>;
  inspectLive?(
    state: SubmindRunState,
  ): Promise<"active" | "done" | "failed" | "unknown" | "unavailable">;
  selectOrchestratorModel?: () => SubmindOrchestratorModelValue;
  now?: () => Date;
  runId?: () => string;
};

export class SubmindController {
  constructor(private readonly dependencies: ControllerDependencies) {}

  async start(cwd: string, detach: boolean): Promise<SubmindRunState> {
    const now = (this.dependencies.now ?? (() => new Date()))();
    const runId = (this.dependencies.runId ?? defaultRunId)();
    const sourceRepositoryPath = await this.dependencies.canonicalRepository(cwd);
    const runDirectory = join(this.dependencies.controlRoot, ".weavekit", "submind-poc", runId);
    const store = new SubmindStore(runDirectory);
    const orchestratorModel = this.selectOrchestratorModel();
    let state: SubmindRunState = {
      schemaVersion: 1,
      runId,
      state: SubmindRunStatus.PROVISIONING,
      sourceRepositoryPath,
      branchName: `submind/poc-${runId}`,
      runDirectory,
      agentPrefix: `submind-${runId}-`,
      orchestratorModel,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await store.initialize(state);
    await store.appendEvent({
      runId,
      type: "intent",
      timestamp: now.toISOString(),
      data: { sourceRepositoryPath, branchName: state.branchName, orchestratorModel },
    });

    return tracer.startActiveSpan(
      "submind.run",
      {
        attributes: {
          "weavekit.submind.run_id": runId,
          "weavekit.submind.detached": detach,
        },
      },
      async (span) => {
        try {
          const provisioned = await this.dependencies.provision(state);
          state = {
            ...state,
            ...provisioned,
            updatedAt: this.timestamp(),
          };
          await store.writeState(state);
          await store.appendEvent({
            runId,
            type: "receipt",
            timestamp: this.timestamp(),
            data: { operation: "worktree.provision", ...provisioned },
          });
          const helperCommand = this.helperCommand(runId);
          await this.stageSkills(provisioned.worktreePath, helperCommand);
          await this.dependencies.preflight({
            paneId: provisioned.rootPaneId,
            workspaceId: provisioned.workspaceId,
            worktreePath: provisioned.worktreePath,
          });
          state = {
            ...state,
            orchestratorLaunchIntentAt: this.timestamp(),
            updatedAt: this.timestamp(),
          };
          await store.writeState(state);
          await store.appendEvent({
            runId,
            type: "intent",
            timestamp: this.timestamp(),
            data: { operation: "orchestrator.launch", paneId: provisioned.rootPaneId },
          });
          const orchestratorName = `${state.agentPrefix}orchestrator`;
          const orchestrator = await this.dependencies.startOrchestrator({
            ...provisioned,
            paneId: provisioned.rootPaneId,
            agentPrefix: state.agentPrefix,
            name: orchestratorName,
            command: "copilot",
            args: orchestratorArgs(orchestratorModel),
          });
          await store.appendEvent({
            runId,
            type: "receipt",
            timestamp: this.timestamp(),
            data: {
              operation: "orchestrator.launch.accepted",
              agentId: orchestrator.agentId,
              paneId: provisioned.rootPaneId,
            },
          });
          state = {
            ...state,
            orchestratorAgentId: orchestrator.agentId,
            orchestratorPromptIntentAt: this.timestamp(),
            updatedAt: this.timestamp(),
          };
          await store.writeState(state);
          await store.appendEvent({
            runId,
            type: "intent",
            timestamp: this.timestamp(),
            data: { operation: "orchestrator.prompt", agentId: orchestrator.agentId },
          });
          const prompt = buildOrchestratorPrompt({
            runId,
            controlRoot: this.dependencies.controlRoot,
            helperScript: resolve(this.dependencies.controlRoot, "scripts", "submind-poc.ts"),
            agentPrefix: state.agentPrefix,
            manifestPath: store.manifestPath,
            sourceRepositoryPath: state.sourceRepositoryPath,
            worktreePath: provisioned.worktreePath,
            branchName: state.branchName,
            workspaceId: provisioned.workspaceId,
            orchestratorPaneId: provisioned.rootPaneId,
            orchestratorAgentId: orchestrator.agentId,
            orchestratorName,
            orchestratorModel,
          });
          await this.dependencies.promptOrchestrator({
            agentId: orchestrator.agentId,
            workspaceId: provisioned.workspaceId,
            worktreePath: provisioned.worktreePath,
            agentPrefix: state.agentPrefix,
            prompt,
          });
          state = {
            ...state,
            state: SubmindRunStatus.ORCHESTRATING,
            orchestratorAgentId: orchestrator.agentId,
            orchestratorPromptAcceptedAt: this.timestamp(),
            updatedAt: this.timestamp(),
          };
          await store.writeState(state);
          await store.appendEvent({
            runId,
            type: "receipt",
            timestamp: this.timestamp(),
            data: {
              operation: "orchestrator.prompt.accepted",
              agentId: orchestrator.agentId,
              paneId: provisioned.rootPaneId,
            },
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return detach ? state : await this.wait(runId);
        } catch (error) {
          const exception = asError(error);
          span.recordException(exception);
          span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
          if (isAmbiguousHerdrMutation(exception)) {
            await store.appendEvent({
              runId,
              type: "failure",
              timestamp: this.timestamp(),
              data: { message: exception.message, ambiguous: true, reconcilable: true },
            });
            throw exception;
          }
          const failed: SubmindRunState = {
            ...state,
            state: SubmindRunStatus.FAILED,
            failure: exception.message,
            updatedAt: this.timestamp(),
          };
          await store.writeState(failed);
          await store.appendEvent({
            runId,
            type: "failure",
            timestamp: this.timestamp(),
            data: { message: exception.message },
          });
          throw exception;
        } finally {
          span.end();
        }
      },
    );
  }

  async status(runId: string): Promise<SubmindRunState> {
    const store = this.store(runId);
    const state = await store.readState();
    if (state.state === SubmindRunStatus.COMPLETED || state.state === SubmindRunStatus.FAILED) {
      return state;
    }
    if (await exists(store.manifestPath)) {
      try {
        const completionReceipt = (await store.readEvents()).some(
          (event) =>
            event.type === "receipt" &&
            event.data.source === "helper" &&
            event.data.operation === "manifest.complete" &&
            event.data.verified === true,
        );
        if (!completionReceipt) {
          throw new Error("Submind manifest has no durable helper completion receipt.");
        }
        const manifest = SubmindManifestSchema.parse(
          JSON.parse(await readFile(store.manifestPath, "utf8")),
        );
        if (
          manifest.runId !== state.runId ||
          manifest.sourceRepositoryPath !== state.sourceRepositoryPath ||
          manifest.worktreePath !== state.worktreePath ||
          manifest.branchName !== state.branchName ||
          manifest.workspaceId !== state.workspaceId
        ) {
          throw new Error("Submind manifest identity does not match persisted run state.");
        }
        const next: SubmindRunState = {
          ...state,
          state: manifest.outcome,
          manifestPath: store.manifestPath,
          ...(manifest.failure ? { failure: manifest.failure } : {}),
          updatedAt: this.timestamp(),
        };
        await store.writeState(next);
        return next;
      } catch (error) {
        return this.failState(
          store,
          state,
          `Malformed submind manifest: ${asError(error).message}`,
        );
      }
    }
    if (state.state === SubmindRunStatus.PROVISIONING) {
      return this.resumeProvisioning(state, store);
    }
    const live = await this.dependencies.inspectLive?.(state);
    if (live === "done" || live === "failed") {
      return this.failState(store, state, "Orchestrator terminated without a valid manifest.");
    }
    return state;
  }

  async wait(runId: string, timeoutMs = 600_000): Promise<SubmindRunState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await this.status(runId);
      if (state.state === SubmindRunStatus.COMPLETED || state.state === SubmindRunStatus.FAILED) {
        return state;
      }
      if (Date.now() >= deadline) {
        return this.failState(
          this.store(runId),
          state,
          `Timed out waiting for submind run: ${runId}`,
        );
      }
      await delay(500);
    }
  }

  private async failState(
    store: SubmindStore,
    state: SubmindRunState,
    failure: string,
  ): Promise<SubmindRunState> {
    const failed: SubmindRunState = {
      ...state,
      state: SubmindRunStatus.FAILED,
      failure,
      updatedAt: this.timestamp(),
    };
    await store.writeState(failed);
    await store.appendEvent({
      runId: state.runId,
      type: "failure",
      timestamp: this.timestamp(),
      data: { message: failure },
    });
    return failed;
  }

  private async resumeProvisioning(
    initial: SubmindRunState,
    store: SubmindStore,
  ): Promise<SubmindRunState> {
    let state = initial;
    try {
      if (!state.orchestratorModel) {
        if (state.orchestratorLaunchIntentAt) {
          throw new Error(
            "Cannot recover submind orchestrator model after launch intent was persisted.",
          );
        }
        state = {
          ...state,
          orchestratorModel: this.selectOrchestratorModel(),
          updatedAt: this.timestamp(),
        };
        await store.writeState(state);
      }
      const provisioned = await this.dependencies.provision(state);
      state = { ...state, ...provisioned, updatedAt: this.timestamp() };
      await store.writeState(state);
      const helperCommand = this.helperCommand(state.runId);
      await this.stageSkills(provisioned.worktreePath, helperCommand);
      if (!state.orchestratorLaunchIntentAt) {
        await this.dependencies.preflight({
          paneId: provisioned.rootPaneId,
          workspaceId: provisioned.workspaceId,
          worktreePath: provisioned.worktreePath,
        });
      }
      if (!state.orchestratorLaunchIntentAt) {
        state = {
          ...state,
          orchestratorLaunchIntentAt: this.timestamp(),
          updatedAt: this.timestamp(),
        };
        await store.writeState(state);
        await store.appendEvent({
          runId: state.runId,
          type: "intent",
          timestamp: this.timestamp(),
          data: { operation: "orchestrator.launch", paneId: provisioned.rootPaneId },
        });
      }
      const orchestratorName = `${state.agentPrefix}orchestrator`;
      const orchestratorModel = state.orchestratorModel;
      if (!orchestratorModel) {
        throw new Error("Submind orchestrator model was not persisted before launch.");
      }
      const orchestrator = state.orchestratorAgentId
        ? { agentId: state.orchestratorAgentId }
        : await this.dependencies.startOrchestrator({
            ...provisioned,
            paneId: provisioned.rootPaneId,
            agentPrefix: state.agentPrefix,
            name: orchestratorName,
            command: "copilot",
            args: orchestratorArgs(orchestratorModel),
          });
      if (!state.orchestratorAgentId) {
        await store.appendEvent({
          runId: state.runId,
          type: "receipt",
          timestamp: this.timestamp(),
          data: {
            operation: "orchestrator.launch.accepted",
            agentId: orchestrator.agentId,
            paneId: provisioned.rootPaneId,
          },
        });
      }
      if (!state.orchestratorPromptIntentAt) {
        state = {
          ...state,
          orchestratorAgentId: orchestrator.agentId,
          orchestratorPromptIntentAt: this.timestamp(),
          updatedAt: this.timestamp(),
        };
        await store.writeState(state);
        await store.appendEvent({
          runId: state.runId,
          type: "intent",
          timestamp: this.timestamp(),
          data: { operation: "orchestrator.prompt", agentId: orchestrator.agentId },
        });
        await this.dependencies.promptOrchestrator({
          agentId: orchestrator.agentId,
          workspaceId: provisioned.workspaceId,
          worktreePath: provisioned.worktreePath,
          agentPrefix: state.agentPrefix,
          prompt: buildOrchestratorPrompt({
            runId: state.runId,
            controlRoot: this.dependencies.controlRoot,
            helperScript: resolve(this.dependencies.controlRoot, "scripts", "submind-poc.ts"),
            agentPrefix: state.agentPrefix,
            manifestPath: store.manifestPath,
            sourceRepositoryPath: state.sourceRepositoryPath,
            worktreePath: provisioned.worktreePath,
            branchName: state.branchName,
            workspaceId: provisioned.workspaceId,
            orchestratorPaneId: provisioned.rootPaneId,
            orchestratorAgentId: orchestrator.agentId,
            orchestratorName,
            orchestratorModel,
          }),
        });
      } else if (!state.orchestratorPromptAcceptedAt) {
        const live = await this.dependencies.inspectLive?.({
          ...state,
          orchestratorAgentId: orchestrator.agentId,
        });
        if (live === "unavailable" || live === undefined || live === "done") return state;
        if (live !== "active") {
          return this.failState(
            store,
            state,
            "Orchestrator prompt dispatch was interrupted and cannot be repeated safely.",
          );
        }
      }
      const next: SubmindRunState = {
        ...state,
        state: SubmindRunStatus.ORCHESTRATING,
        orchestratorAgentId: orchestrator.agentId,
        orchestratorPromptAcceptedAt: state.orchestratorPromptAcceptedAt ?? this.timestamp(),
        updatedAt: this.timestamp(),
      };
      await store.writeState(next);
      return next;
    } catch (error) {
      if (isAmbiguousHerdrMutation(error)) {
        await store.appendEvent({
          runId: state.runId,
          type: "failure",
          timestamp: this.timestamp(),
          data: {
            message: asError(error).message,
            ambiguous: true,
            reconcilable: true,
          },
        });
        return state;
      }
      return this.failState(store, state, asError(error).message);
    }
  }

  private store(runId: string): SubmindStore {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/u.test(runId)) {
      throw new Error("Invalid submind run ID.");
    }
    return new SubmindStore(join(this.dependencies.controlRoot, ".weavekit", "submind-poc", runId));
  }

  private async stageSkills(worktreePath: string, helperCommand: string): Promise<void> {
    await this.dependencies.stageSkill(
      worktreePath,
      SUBMIND_OPERATING_SKILL_NAME,
      await loadSubmindOperatingSkill(),
    );
    await this.dependencies.stageSkill(worktreePath, "submind-poc", submindSkill(helperCommand));
  }

  private selectOrchestratorModel(): SubmindOrchestratorModelValue {
    return (this.dependencies.selectOrchestratorModel ?? randomSubmindOrchestratorModel)();
  }

  private helperCommand(runId: string): string {
    return `nub ${shellArgument(resolve(this.dependencies.controlRoot, "scripts", "submind-poc.ts"))} helper --control-root ${shellArgument(this.dependencies.controlRoot)} --run ${runId}`;
  }

  private timestamp(): string {
    return (this.dependencies.now ?? (() => new Date()))().toISOString();
  }
}

export async function stageSubmindSkill(
  worktreePath: string,
  skillName: string,
  content: string,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(skillName)) {
    throw new Error(`Invalid staged submind skill name: ${skillName}`);
  }
  const directory = join(worktreePath, ".github", "skills", skillName);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), content, { flag: "wx" }).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(join(directory, "SKILL.md"), "utf8");
    if (existing !== content) throw new Error("Existing staged submind skill does not match run.");
  });
}

export function buildOrchestratorPrompt(input: {
  runId: string;
  controlRoot: string;
  helperScript: string;
  agentPrefix: string;
  manifestPath: string;
  sourceRepositoryPath: string;
  worktreePath: string;
  branchName: string;
  workspaceId: string;
  orchestratorPaneId: string;
  orchestratorAgentId: string;
  orchestratorName: string;
  orchestratorModel: SubmindOrchestratorModelValue;
}): string {
  const helper = `nub ${shellArgument(input.helperScript)} helper --control-root ${shellArgument(input.controlRoot)} --run ${input.runId}`;
  return [
    "Use the mastermind-submind skill first, then use the submind-poc skill.",
    "Complete this durable orchestration without asking the user.",
    `Run ID: ${input.runId}`,
    `Agent name prefix: ${input.agentPrefix}`,
    `Canonical worker names: ${input.agentPrefix}copilot, ${input.agentPrefix}grok, ${input.agentPrefix}codex, ${input.agentPrefix}claude-council`,
    `Final manifest: ${input.manifestPath}`,
    `Source repository path: ${input.sourceRepositoryPath}`,
    `Worktree path: ${input.worktreePath}`,
    `Branch: ${input.branchName}`,
    `Workspace ID: ${input.workspaceId}`,
    `Orchestrator: name=${input.orchestratorName} agent=${input.orchestratorAgentId} pane=${input.orchestratorPaneId}`,
    `Orchestrator model: ${input.orchestratorModel}`,
    `Scoped helper: ${helper} --operation <operation> --input '<json>'`,
    "Never call Herdr CLI or socket directly; all control must use the scoped helper.",
    "Create four worker tabs with run-prefixed labels and launch one worker per tab concurrently:",
    "- copilot --autopilot --allow-all --no-ask-user interactively; tell it not to inspect or modify files, then to ask your favorite color and acknowledge the answer",
    "- grx superpowers --permission-mode bypassPermissions; tell it not to inspect or modify files, then to ask your favorite movie and acknowledge the answer",
    "- codx interactively; switch it with helper plan before prompting, require its native request_user_input ask-user tool to ask your favorite book with three choices, then answer the choice and capture its acknowledgement",
    "- trellage --profile claude-council interactively; tell it not to inspect or modify files, then to ask your favorite programming language and acknowledge the answer",
    "Wait for each question, choose your own answer, reply with agent.prompt, and capture acknowledgement.",
    "Helper records operation receipts automatically. Complete only through helper complete with valid manifest.",
    "Leave worktree, panes, and agents open for inspection.",
  ].join("\n");
}

function defaultRunId(): string {
  return randomUUID().slice(0, 8);
}

export function randomSubmindOrchestratorModel(
  randomIndex = randomInt(2),
): SubmindOrchestratorModelValue {
  return randomIndex === 0
    ? SubmindOrchestratorModel.GPT_5_6_SOL
    : SubmindOrchestratorModel.CLAUDE_OPUS_5;
}

export function orchestratorArgs(model: SubmindOrchestratorModelValue): string[] {
  return [
    "--autopilot",
    "--allow-all",
    "--no-ask-user",
    "--model",
    model,
    "--reasoning-effort",
    "high",
  ];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAmbiguousHerdrMutation(error: unknown): boolean {
  return asError(error).message.includes("ambiguous operation state");
}

function shellArgument(value: string): string {
  return /^[a-zA-Z0-9_./:-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}
