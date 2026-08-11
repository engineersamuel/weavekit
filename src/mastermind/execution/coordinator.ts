import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { WeavekitConfig } from "../../config.js";
import {
  createDirectExecutionRequest,
  directExecutionAgentName,
  ExecutorKind,
  startDirectExecutionWithApprovedPreflight,
  validateResultForRequest,
  type DirectExecutionRequest,
  type DirectExecutionResult,
  type DirectExecutor,
  type ExecutorHandle,
  type VerificationEvidence,
} from "../../submind/index.js";
import type { ExecutionCommandRunner } from "../../submind/preflight.js";
import type { WorkspaceProvisioner } from "../../submind/workspace.js";
import type { PostImplementationReviewCoordinator } from "../codeReview/coordinator.js";
import { MastermindAction, MastermindEventType, MastermindState } from "../domain/events.js";
import { transitionMastermindState } from "../domain/machine.js";
import type { LinearGateway } from "../linear/client.js";
import type {
  ExecutionAttempt,
  MastermindEventRecord,
  MastermindStore,
  MastermindWorkItem,
} from "../store/store.js";
import { executionTelemetryAttributes, withMastermindSpan } from "../telemetry.js";
import { needsHuman, normalizeExecutionOutcome } from "./result.js";

export class MastermindExecutionCoordinator {
  constructor(
    private readonly config: WeavekitConfig,
    private readonly store: MastermindStore,
    private readonly linear: LinearGateway,
    private readonly provisioner: WorkspaceProvisioner,
    private readonly executor: DirectExecutor,
    private readonly validationRunner: ExecutionCommandRunner,
    private readonly onProgress?: (message: string) => void,
    private readonly codeReview?: PostImplementationReviewCoordinator,
  ) {}

  async process(workId: string): Promise<void> {
    const owner = this.config.mastermind.instanceId;
    const leased = await this.store.acquireLease(
      workId,
      owner,
      new Date(),
      this.config.mastermind.leaseDurationMs,
    );
    if (!leased) return;
    try {
      const attempt = await this.store.getCurrentExecutionAttempt(workId);
      if (attempt) {
        const project = this.config.projects[attempt.projectPolicyId];
        const workspaceLabel = attempt.workspace?.checkoutPath
          ? basename(attempt.workspace.checkoutPath)
          : "not provisioned";
        this.onProgress?.(
          `Attempt ${attempt.attemptNumber}: ${attempt.state}; repository mode ${
            project?.repositoryMode ?? "EXISTING_REPOSITORY"
          }; workspace ${workspaceLabel}.`,
        );
      }
      await withMastermindSpan(
        `mastermind.execution.${leased.state}`,
        executionTelemetryAttributes({
          work: leased,
          attempt,
          repositoryMode: attempt
            ? this.config.projects[attempt.projectPolicyId]?.repositoryMode
            : undefined,
        }),
        async () => this.processPhase(leased, attempt, owner),
      );
    } finally {
      await this.store.releaseLease(workId, owner);
    }
  }

  private async processPhase(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt | undefined,
    owner: string,
  ): Promise<void> {
    if (work.state === MastermindState.ACTION_PLANNED) {
      await this.beginExecution(work, owner);
      return;
    }
    if (!attempt) {
      return;
    }
    if (work.currentExecutionAttemptId !== attempt.id) {
      throw new Error(`Current execution attempt fence mismatch for work ${work.id}.`);
    }
    if (
      this.codeReview &&
      attempt.state === MastermindState.SUCCEEDED &&
      (work.state === MastermindState.SUCCEEDED ||
        work.state === MastermindState.CODE_REVIEW_PENDING ||
        work.state === MastermindState.CODE_REVIEWING)
    ) {
      if (work.state !== MastermindState.SUCCEEDED || attempt.projection?.projectedAt) {
        await this.codeReview.process(work, attempt, owner);
        return;
      }
    }
    switch (attempt.state) {
      case MastermindState.PROVISIONING:
        await this.provision(work, attempt, owner);
        return;
      case MastermindState.PREFLIGHTING:
        await this.preflight(work, attempt, owner);
        return;
      case MastermindState.LAUNCHING:
        await this.launch(work, attempt, owner);
        return;
      case MastermindState.RUNNING:
        await this.poll(work, attempt, owner);
        return;
      case MastermindState.COLLECTING:
        await this.collect(work, attempt, owner);
        return;
      case MastermindState.RETRY_WAIT:
        await this.retry(work, attempt, owner);
        return;
      case MastermindState.SUCCEEDED:
      case MastermindState.NEEDS_HUMAN:
      case MastermindState.FAILED:
        await this.project(work, attempt, owner);
        return;
      default:
        return;
    }
  }

  private async beginExecution(work: MastermindWorkItem, owner: string): Promise<void> {
    const execution = this.config.mastermind.execution;
    const project = work.projectPolicyId ? this.config.projects[work.projectPolicyId] : undefined;
    if (
      work.plannedAction !== MastermindAction.IMPLEMENT_DIRECTLY ||
      !execution ||
      !project?.directExecution?.enabled ||
      !project.directExecution.allowedExecutorKinds.includes(execution.executorKind)
    ) {
      return;
    }
    if (this.config.mastermind.inProgressStateName) {
      if (!this.linear.setIssueState) {
        throw new Error("Linear gateway does not support workflow-state projection.");
      }
      await this.linear.setIssueState(work.issueId, this.config.mastermind.inProgressStateName);
    }
    await this.store.createExecutionAttempt({
      work,
      owner,
      projectPolicyId: project.id,
      projectPolicyVersion: policyVersion(project),
      executorKind: execution.executorKind,
    });
  }

  private async retry(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    owner: string,
  ): Promise<void> {
    const execution = this.requireExecutionConfig();
    if (!attempt.retryEligible || attempt.attemptNumber >= execution.maxAttempts) {
      await this.toNeedsHuman(
        work,
        attempt,
        owner,
        "EXECUTION_RETRIES_EXHAUSTED",
        "Execution retry is not eligible or has exhausted the configured attempt limit.",
      );
      return;
    }
    await this.store.createExecutionAttempt({
      work,
      owner,
      projectPolicyId: attempt.projectPolicyId,
      projectPolicyVersion: attempt.projectPolicyVersion,
      executorKind: attempt.executorKind,
    });
  }

  private async provision(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    owner: string,
  ): Promise<void> {
    const project = this.config.projects[attempt.projectPolicyId];
    const ticket = await this.store.getLatestTicketSnapshot(work.id);
    if (!project || !ticket) {
      await this.toNeedsHuman(
        work,
        attempt,
        owner,
        "EXECUTION_CONTEXT_MISSING",
        "Execution project or ticket snapshot is unavailable.",
      );
      return;
    }
    let current = attempt;
    let workspace = current.workspace;
    if (!workspace) {
      workspace = await this.provisioner.describe({
        workId: work.id,
        workCreatedAt: work.createdAt,
        attemptId: attempt.id,
        ticket,
        project,
      });
      current = await this.store.patchExecutionAttempt({
        work,
        attempt: current,
        owner,
        patch: { workspace },
        eventType: "execution.workspace_intent_recorded",
      });
    }
    try {
      const provisioned = await this.provisioner.provision(workspace, project);
      await this.transition(work, current, owner, MastermindEventType.WORKSPACE_PROVISIONED, {
        workspace: provisioned,
      });
    } catch (error) {
      await this.toNeedsHuman(work, current, owner, "WORKSPACE_PROVISIONING", sanitizeError(error));
    }
  }

  private async preflight(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    owner: string,
  ): Promise<void> {
    const { request } = await this.loadContext(work, attempt);
    const report = await this.executor.preflight(request);
    const current = await this.requireCurrentAttempt(work.id, attempt.id);
    if (!report.accepted) {
      await this.toNeedsHuman(
        work,
        current,
        owner,
        "EXECUTOR_PREFLIGHT",
        report.checks
          .filter((check) => !check.accepted)
          .map((check) => check.summary)
          .join("; "),
        { preflight: report },
      );
      return;
    }
    await this.transition(work, current, owner, MastermindEventType.PREFLIGHT_PASSED, {
      preflight: report,
    });
  }

  private async launch(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    owner: string,
  ): Promise<void> {
    const execution = this.requireExecutionConfig();
    const { request } = await this.loadContext(work, attempt);
    const report = attempt.preflight;
    if (!report?.accepted) {
      await this.toNeedsHuman(
        work,
        attempt,
        owner,
        "PREFLIGHT_BYPASS_REJECTED",
        "Executor launch requires an accepted persisted preflight report.",
      );
      return;
    }
    const intent: ExecutorHandle = {
      executor: ExecutorKind.HERDR_COPILOT,
      agentName: directExecutionAgentName(work.id, attempt.attemptNumber),
      worktreePath: request.workspace.checkoutPath,
    };
    const current = attempt.executorHandle
      ? attempt
      : await this.store.patchExecutionAttempt({
          work,
          attempt,
          owner,
          patch: { executorHandle: intent },
          eventType: "execution.launch_intent_recorded",
        });
    try {
      const handle = await startDirectExecutionWithApprovedPreflight(
        this.executor,
        request,
        report,
      );
      await this.transition(work, current, owner, MastermindEventType.EXECUTOR_STARTED, {
        executorHandle: handle,
        launchedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.toNeedsHuman(work, current, owner, "EXECUTOR_LAUNCH", sanitizeError(error));
    }
    void execution;
  }

  private async poll(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    owner: string,
  ): Promise<void> {
    if (!attempt.executorHandle) {
      await this.toNeedsHuman(
        work,
        attempt,
        owner,
        "MISSING_EXECUTOR_HANDLE",
        "Running execution has no durable executor handle.",
      );
      return;
    }
    const status = await this.executor.status(attempt.executorHandle);
    status.unknownCount =
      status.state === "unknown" ? (attempt.lastStatus?.unknownCount ?? 0) + 1 : 0;
    if (status.state === "blocked") {
      await this.toNeedsHuman(
        work,
        attempt,
        owner,
        "EXECUTOR_BLOCKED",
        status.detail ?? "Executor is blocked.",
        { lastStatus: status },
      );
      return;
    }
    if (
      status.state === "unknown" &&
      status.unknownCount >= this.requireExecutionConfig().unknownStatusThreshold
    ) {
      await this.toNeedsHuman(
        work,
        attempt,
        owner,
        "EXECUTOR_STATUS_UNKNOWN",
        status.detail ?? "Executor status remained unknown.",
        { lastStatus: status },
      );
      return;
    }
    if (status.state === "idle" || status.state === "done") {
      await this.transition(work, attempt, owner, MastermindEventType.EXECUTOR_TERMINAL, {
        lastStatus: status,
        terminalAt: new Date().toISOString(),
      });
      return;
    }
    await this.store.patchExecutionAttempt({
      work,
      attempt,
      owner,
      patch: { lastStatus: status },
      eventType: "execution.status_observed",
    });
  }

  private async collect(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    owner: string,
  ): Promise<void> {
    if (!attempt.executorHandle || !attempt.lastStatus) {
      await this.toNeedsHuman(
        work,
        attempt,
        owner,
        "COLLECTION_STATE_MISSING",
        "Execution collection requires a terminal status and durable handle.",
      );
      return;
    }
    const { request } = await this.loadContext(work, attempt);
    try {
      const result = await this.executor.collect(attempt.executorHandle);
      validateResultForRequest(result, request);
      const verification = await this.runIndependentVerification(request, result);
      const normalized = normalizeExecutionOutcome({
        status: attempt.lastStatus,
        result,
        verification,
        attemptNumber: attempt.attemptNumber,
        maxAttempts: this.requireExecutionConfig().maxAttempts,
      });
      await this.transition(work, attempt, owner, normalized.eventType, {
        result,
        verification,
        retryEligible: normalized.retryEligible,
        failureClass: normalized.failureClass,
        failureMessage: normalized.failureMessage,
        collectedAt: new Date().toISOString(),
      });
    } catch (error) {
      const normalized = needsHuman("RESULT_COLLECTION", sanitizeError(error));
      await this.transition(work, attempt, owner, normalized.eventType, {
        retryEligible: false,
        failureClass: normalized.failureClass,
        failureMessage: normalized.failureMessage,
        collectedAt: new Date().toISOString(),
      });
    }
  }

  private async runIndependentVerification(
    request: DirectExecutionRequest,
    result: DirectExecutionResult,
  ): Promise<VerificationEvidence> {
    if (request.validationCommands.length === 0) {
      return {
        commands: result.verification.map((entry) => ({ ...entry, durationMs: 0 })),
        passed:
          result.verification.length > 0 &&
          result.verification.every((entry) => entry.exitCode === 0),
      };
    }
    const commands = [];
    for (const command of request.validationCommands) {
      const started = Date.now();
      const result = await this.validationRunner.run(
        "sh",
        ["-lc", command],
        request.workspace.checkoutPath,
      );
      commands.push({
        command,
        exitCode: result.exitCode ?? 1,
        summary: summarizeOutput(result.stdout, result.stderr),
        durationMs: Date.now() - started,
      });
    }
    return {
      commands,
      passed: commands.every((command) => command.exitCode === 0),
    };
  }

  private async project(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    owner: string,
  ): Promise<void> {
    if (attempt.projection?.disposition === "applied") return;
    if (!this.linear.findIssueCommentByMarker || !this.linear.createIssueComment) {
      throw new Error("Linear gateway does not support idempotent execution comments.");
    }
    const marker = `<!-- weavekit-mastermind-execution:${attempt.id} -->`;
    let current = attempt;
    if (current.projection?.disposition !== "pending") {
      current = await this.store.saveExecutionProjection({
        work,
        attempt: current,
        owner,
        projection: { disposition: "pending" },
      });
    }
    let commentId = await this.linear.findIssueCommentByMarker(work.issueId, marker);
    if (!commentId) {
      const ticket = await this.store.getLatestTicketSnapshot(work.id);
      commentId = await this.linear.createIssueComment(
        work.issueId,
        executionComment(current, marker, ticket?.identifier ?? work.id),
      );
    }
    if (current.state === MastermindState.SUCCEEDED) {
      await this.linear.replaceIssueLabels(work.issueId, {
        remove: [this.config.mastermind.readyLabelId],
        add: [],
      });
    } else if (current.state === MastermindState.NEEDS_HUMAN) {
      await this.linear.replaceIssueLabels(work.issueId, {
        remove: [],
        add: [this.config.mastermind.needsInputLabelId],
      });
    } else if (current.state === MastermindState.FAILED) {
      await this.linear.replaceIssueLabels(work.issueId, {
        remove: [this.config.mastermind.readyLabelId],
        add: [this.config.mastermind.reviewFailedLabelId],
      });
    }
    await this.store.saveExecutionProjection({
      work,
      attempt: current,
      owner,
      projection: {
        disposition: "applied",
        externalId: commentId,
        projectedAt: new Date().toISOString(),
      },
    });
  }

  private async loadContext(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
  ): Promise<{ project: WeavekitConfig["projects"][string]; request: DirectExecutionRequest }> {
    const project = this.config.projects[attempt.projectPolicyId];
    const ticket = await this.store.getLatestTicketSnapshot(work.id);
    const review = await this.store.getLatestReview(work.id);
    const decision = await this.store.getLatestDecision(work.id);
    if (!project || !ticket || !review || !decision || !attempt.workspace) {
      throw new Error("Execution context is incomplete or no longer configured.");
    }
    return {
      project,
      request: createDirectExecutionRequest(
        {
          workId: work.id,
          attemptId: attempt.id,
          attemptNumber: attempt.attemptNumber,
          objective: ticket.title,
          ticket,
          review,
          decision,
          workspace: attempt.workspace,
        },
        project,
      ),
    };
  }

  private async requireCurrentAttempt(
    workId: string,
    attemptId: string,
  ): Promise<ExecutionAttempt> {
    const current = await this.store.getCurrentExecutionAttempt(workId);
    if (!current || current.id !== attemptId) {
      throw new Error(`Execution attempt ${attemptId} is stale.`);
    }
    return current;
  }

  private transition(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    owner: string,
    eventType: MastermindEventRecord["eventType"],
    patch: Parameters<MastermindStore["transitionExecutionAttempt"]>[0]["patch"],
  ): Promise<{ work: MastermindWorkItem; attempt: ExecutionAttempt }> {
    const nextState = transitionMastermindState(attempt.state, { type: eventType } as never);
    return this.store.transitionExecutionAttempt({
      work,
      attempt,
      owner,
      event: { eventType, priorState: attempt.state, nextState },
      patch,
    });
  }

  private async toNeedsHuman(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    owner: string,
    failureClass: string,
    failureMessage: string,
    patch: Parameters<MastermindStore["transitionExecutionAttempt"]>[0]["patch"] = {},
  ): Promise<void> {
    await this.transition(work, attempt, owner, MastermindEventType.EXECUTION_NEEDS_HUMAN, {
      ...patch,
      failureClass,
      failureMessage,
      retryEligible: false,
    });
  }

  private requireExecutionConfig() {
    const execution = this.config.mastermind.execution;
    if (!execution) throw new Error("Mastermind direct execution is not configured.");
    return execution;
  }
}

function policyVersion(project: WeavekitConfig["projects"][string]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: project.id,
        repositoryMode: project.repositoryMode,
        workingTree: project.workingTree,
        provisioningRoot: project.provisioningRoot,
        mainline: project.mainline,
        validationCommands: project.validationCommands,
        directExecution: project.directExecution,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function executionComment(
  attempt: ExecutionAttempt,
  marker: string,
  attachmentSelector: string,
): string {
  const verification = attempt.verification?.commands ?? [];
  const handle = attempt.executorHandle;
  const attachmentCommands =
    handle?.agentName && handle.worktreePath
      ? [
          "",
          "Continue in Herdr:",
          "",
          "```bash",
          `mise run mastermind:attach ${shellQuote(attachmentSelector)}`,
          `herdr agent attach ${shellQuote(handle.agentName)}`,
          `herdr agent focus ${shellQuote(handle.agentName)}`,
          `herdr agent read ${shellQuote(handle.agentName)} --source recent-unwrapped --lines 100`,
          `cd ${shellQuote(handle.worktreePath)}`,
          "```",
        ]
      : [];
  return [
    marker,
    `Mastermind execution attempt ${attempt.attemptNumber}: **${attempt.state}**`,
    "",
    attempt.result?.summary ?? attempt.failureMessage ?? "Execution finished without a summary.",
    ...(verification.length > 0
      ? [
          "",
          "Verification:",
          ...verification.map(
            (entry) => `- \`${entry.command}\`: exit ${entry.exitCode} - ${entry.summary}`,
          ),
        ]
      : []),
    ...(attempt.result?.pullRequestUrl
      ? ["", `Pull request: ${attempt.result.pullRequestUrl}`]
      : []),
    ...attachmentCommands,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function summarizeOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].join("\n").replace(/\s+/gu, " ").trim().slice(0, 500) || "No output.";
}

function sanitizeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}
