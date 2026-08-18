import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { WeavekitConfig } from "../../config.js";
import {
  RLM_VISUALIZATION_HTML_PATH,
  RLM_VISUALIZATION_PNG_PATH,
} from "../../rlm-poc/visualization/contracts.js";
import {
  createDirectExecutionRequest,
  directExecutionAgentName,
  ExecutorKind,
  startDirectExecutionWithApprovedPreflight,
  validateResultForRequest,
  verificationPassed,
  type DirectExecutionRequest,
  type DirectExecutionResult,
  type DirectExecutor,
  type ExecutorHandle,
  type VerificationEvidence,
} from "../../submind/index.js";
import type { ExecutionCommandRunner } from "../../submind/preflight.js";
import type { WorkspaceProvisioner } from "../../submind/workspace.js";
import type { PostImplementationReviewCoordinator } from "../codeReview/coordinator.js";
import { createLeaseHeartbeat } from "../decision/loop.js";
import { MastermindAction, MastermindEventType, MastermindState } from "../domain/events.js";
import { transitionMastermindState } from "../domain/machine.js";
import type { LinearGateway } from "../linear/client.js";
import type { SelfImprovementCoordinator } from "../selfImprovement/coordinator.js";
import type {
  ExecutionAttempt,
  MastermindEventRecord,
  MastermindStore,
  MastermindWorkItem,
} from "../store/store.js";
import { executionTelemetryAttributes, withMastermindSpan } from "../telemetry.js";
import { needsHuman, normalizeExecutionOutcome } from "./result.js";

export type DirectExecutorResolver = Partial<Record<ExecutorKind, DirectExecutor>>;

export class MastermindExecutionCoordinator {
  constructor(
    private readonly config: WeavekitConfig,
    private readonly store: MastermindStore,
    private readonly linear: LinearGateway,
    private readonly provisioner: WorkspaceProvisioner,
    private readonly executors: DirectExecutorResolver,
    private readonly validationRunner: ExecutionCommandRunner,
    private readonly onProgress?: (message: string) => void,
    private readonly codeReview?: PostImplementationReviewCoordinator,
    private readonly selfImprovement?: SelfImprovementCoordinator,
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
        const project = this.resolveProject(leased, attempt.projectPolicyId);
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
            ? this.resolveProject(leased, attempt.projectPolicyId)?.repositoryMode
            : undefined,
        }),
        async (span) => {
          const heartbeat = createLeaseHeartbeat({
            store: this.store,
            workId,
            owner,
            durationMs: this.config.mastermind.leaseDurationMs,
            rootSpan: span,
          });
          try {
            await this.processPhase(leased, attempt, owner);
            await heartbeat.assertActive();
          } finally {
            await heartbeat.stop();
          }
        },
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
    if (this.selfImprovement) {
      // Best-effort and self-idempotent (see SelfImprovementCoordinator): safe to invoke on every
      // poll of a terminal work item, not just the transition into it.
      await this.selfImprovement.process(work, attempt);
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
    const project = work.projectPolicyId
      ? this.resolveProject(work, work.projectPolicyId)
      : undefined;
    const executionSelection = this.resolveExecutionSelectionForAction(work.plannedAction);
    if (
      !executionSelection ||
      !project?.directExecution?.enabled ||
      !project.directExecution.allowedExecutorKinds.includes(executionSelection.executorKind)
    ) {
      return;
    }
    if (this.config.mastermind.inProgressStateName) {
      if (!this.linear.setIssueState) {
        throw new Error("Linear gateway does not support workflow-state projection.");
      }
      await this.linear.setIssueState(work.issueId, this.config.mastermind.inProgressStateName);
    }
    await this.clearExecutionGateLabels(work.issueId);
    await this.store.createExecutionAttempt({
      work,
      owner,
      projectPolicyId: project.id,
      projectPolicyVersion: policyVersion(project),
      executorKind: executionSelection.executorKind,
      action: work.plannedAction!,
    });
  }

  private async retry(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    owner: string,
  ): Promise<void> {
    const execution = this.requireExecutionConfig(attempt.executorKind);
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
    await this.clearExecutionGateLabels(work.issueId);
    await this.store.createExecutionAttempt({
      work,
      owner,
      projectPolicyId: attempt.projectPolicyId,
      projectPolicyVersion: attempt.projectPolicyVersion,
      executorKind: attempt.executorKind,
      action: attempt.action,
    });
  }

  private async clearExecutionGateLabels(issueId: string): Promise<void> {
    await this.linear.replaceIssueLabels(issueId, {
      remove: [
        this.config.mastermind.readyLabelId,
        this.config.mastermind.needsInputLabelId,
        this.config.mastermind.reviewFailedLabelId,
      ],
      add: [],
    });
  }

  private async provision(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    owner: string,
  ): Promise<void> {
    const project = this.resolveProject(work, attempt.projectPolicyId);
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
    try {
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
    const report = await this.resolveExecutor(attempt.executorKind).preflight(request);
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
    const executor = this.resolveExecutor(attempt.executorKind);
    const intent: ExecutorHandle = {
      executor: attempt.executorKind,
      // Only the Herdr executor creates a named agent. The RLM submind is a detached child
      // process, so its handle carries pid/logPath instead. Naming it here produced a handle that
      // looked attachable and was not: `herdr agent focus` answered agent_not_found.
      ...(attempt.executorKind === ExecutorKind.RLM_SUBMIND
        ? {}
        : { agentName: directExecutionAgentName(work.id, attempt.attemptNumber) }),
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
      const handle = await startDirectExecutionWithApprovedPreflight(executor, request, report);
      await this.transition(work, current, owner, MastermindEventType.EXECUTOR_STARTED, {
        executorHandle: handle,
        launchedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.toNeedsHuman(work, current, owner, "EXECUTOR_LAUNCH", sanitizeError(error));
    }
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
    const status = await this.resolveExecutor(attempt.executorKind).status(attempt.executorHandle);
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
      status.unknownCount >=
        this.requireExecutionConfig(attempt.executorKind).unknownStatusThreshold
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
      const result = await this.resolveExecutor(attempt.executorKind).collect(
        attempt.executorHandle,
        request,
      );
      validateResultForRequest(result, request);
      const verification = await this.runIndependentVerification(request, result);
      const normalized = normalizeExecutionOutcome({
        status: attempt.lastStatus,
        result,
        verification,
        attemptNumber: attempt.attemptNumber,
        maxAttempts: this.requireExecutionConfig(attempt.executorKind).maxAttempts,
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
        passed: result.verification.length > 0 && result.verification.every(verificationPassed),
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
      // Uploads happen here, at the one point where the comment does not exist yet, so a retried
      // projection never publishes the same storyboard twice.
      const storyboard = await this.publishStoryboard(work, current);
      commentId = await this.linear.createIssueComment(
        work.issueId,
        executionComment(current, marker, ticket?.identifier ?? work.id, storyboard),
      );
    }
    if (current.state === MastermindState.SUCCEEDED) {
      await this.linear.replaceIssueLabels(work.issueId, {
        remove: [
          this.config.mastermind.readyLabelId,
          this.config.mastermind.needsInputLabelId,
          this.config.mastermind.reviewFailedLabelId,
        ],
        add: [],
      });
    } else if (current.state === MastermindState.NEEDS_HUMAN) {
      await this.linear.replaceIssueLabels(work.issueId, {
        remove: [this.config.mastermind.readyLabelId, this.config.mastermind.reviewFailedLabelId],
        add: [this.config.mastermind.needsInputLabelId],
      });
    } else if (current.state === MastermindState.FAILED) {
      await this.linear.replaceIssueLabels(work.issueId, {
        remove: [this.config.mastermind.readyLabelId, this.config.mastermind.needsInputLabelId],
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

  /**
   * Publishes the Submind storyboard to the ticket, if this attempt produced one and the gateway
   * supports uploads. Deliberately non-fatal: every failure becomes a line in the execution comment
   * and a progress message, because finished work must not fail over a picture.
   */
  private async publishStoryboard(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
  ): Promise<StoryboardPublication> {
    const publication: StoryboardPublication = { failures: [] };
    const worktreePath = attempt.executorHandle?.worktreePath;
    const artifactPaths = attempt.result?.artifactPaths ?? [];
    if (!worktreePath || !this.linear.uploadIssueAttachment) return publication;
    const targets = [
      {
        path: RLM_VISUALIZATION_PNG_PATH,
        contentType: "image/png",
        label: "png" as const,
      },
      {
        path: RLM_VISUALIZATION_HTML_PATH,
        contentType: "text/html",
        label: "html" as const,
      },
    ].filter((target) => artifactPaths.includes(target.path));
    for (const target of targets) {
      try {
        const data = await readFile(join(worktreePath, target.path));
        const uploaded = await this.linear.uploadIssueAttachment({
          issueId: work.issueId,
          fileName: `submind-storyboard-attempt-${attempt.attemptNumber}.${target.label}`,
          contentType: target.contentType,
          title: `Submind storyboard (attempt ${attempt.attemptNumber})`,
          data,
        });
        if (target.label === "png") publication.pngUrl = uploaded.assetUrl;
        else publication.htmlUrl = uploaded.assetUrl;
      } catch (error) {
        const message = `${target.path}: ${error instanceof Error ? error.message : String(error)}`;
        publication.failures.push(message);
        this.onProgress?.(`Storyboard upload failed for ${message}`);
      }
    }
    return publication;
  }

  private async loadContext(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
  ): Promise<{ project: WeavekitConfig["projects"][string]; request: DirectExecutionRequest }> {
    const project = this.resolveProject(work, attempt.projectPolicyId);
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

  private resolveProject(
    work: MastermindWorkItem,
    projectPolicyId: string,
  ): WeavekitConfig["projects"][string] | undefined {
    if (work.resolvedProject?.id === projectPolicyId) {
      return work.resolvedProject;
    }
    return this.config.projects[projectPolicyId];
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

  private resolveExecutionSelectionForAction(
    action: MastermindWorkItem["plannedAction"],
  ): { executorKind: ExecutorKind } | undefined {
    if (action === MastermindAction.IMPLEMENT_DIRECTLY && this.config.mastermind.execution) {
      return { executorKind: this.config.mastermind.execution.executorKind };
    }
    if (action === MastermindAction.DELEGATE_SUBMIND && this.config.mastermind.rlmExecution) {
      return { executorKind: this.config.mastermind.rlmExecution.executorKind };
    }
    return undefined;
  }

  private resolveExecutor(kind: ExecutorKind): DirectExecutor {
    const executor = this.executors[kind];
    if (!executor) {
      throw new Error(`No DirectExecutor is configured for executor kind "${kind}".`);
    }
    return executor;
  }

  private requireExecutionConfig(kind: ExecutorKind): {
    maxAttempts: number;
    unknownStatusThreshold: number;
    cancellationGraceMs: number;
  } {
    if (kind === ExecutorKind.RLM_SUBMIND) {
      const execution = this.config.mastermind.rlmExecution;
      if (!execution) throw new Error("Mastermind RLM execution is not configured.");
      return execution;
    }
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

/** Result of publishing one attempt's storyboard to Linear. Failures are reported, never thrown. */
type StoryboardPublication = {
  htmlUrl?: string;
  pngUrl?: string;
  failures: string[];
};

function executionComment(
  attempt: ExecutionAttempt,
  marker: string,
  attachmentSelector: string,
  storyboard: StoryboardPublication = { failures: [] },
): string {
  const verification = attempt.verification?.commands ?? [];
  const handle = attempt.executorHandle;
  const attachmentCommands = handle ? continuationCommands(handle, attachmentSelector) : [];
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
    ...storyboardSection(storyboard),
    ...attachmentCommands,
  ].join("\n");
}

function storyboardSection(storyboard: StoryboardPublication): string[] {
  if (!storyboard.pngUrl && !storyboard.htmlUrl && storyboard.failures.length === 0) {
    return [];
  }
  return [
    "",
    "Submind storyboard:",
    ...(storyboard.pngUrl ? ["", `![Submind storyboard](${storyboard.pngUrl})`] : []),
    ...(storyboard.htmlUrl ? ["", `Interactive storyboard: ${storyboard.htmlUrl}`] : []),
    ...storyboard.failures.map((failure) => `- Upload failed: ${failure}`),
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/**
 * Commands a human can actually run to continue this attempt, matched to how the executor runs.
 * A Herdr agent is attachable; a detached RLM submind process is not, so it gets the worktree,
 * the log, and the result manifest instead.
 */
function continuationCommands(handle: ExecutorHandle, attachmentSelector: string): string[] {
  if (!handle.worktreePath) {
    return [];
  }
  if (handle.executor === ExecutorKind.RLM_SUBMIND) {
    return [
      "",
      "Inspect the submind run:",
      "",
      "```bash",
      `mise run mastermind:attach ${shellQuote(attachmentSelector)}`,
      `cd ${shellQuote(handle.worktreePath)}`,
      ...(handle.logPath ? [`tail -n 100 ${shellQuote(handle.logPath)}`] : []),
      "cat .weavekit/mastermind-result.json",
      "```",
    ];
  }
  if (!handle.agentName) {
    return [];
  }
  return [
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
  ];
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
