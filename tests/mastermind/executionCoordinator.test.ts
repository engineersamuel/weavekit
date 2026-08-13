import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProjectRepositoryMode,
  loadTypedWeavekitConfig,
  type WeavekitConfig,
} from "../../src/config.js";
import {
  PostImplementationReviewVerdict,
  type MastermindNextActionDecision,
} from "../../src/generated/baml_client/index.js";
import { acceptMastermindWork } from "../../src/mastermind/codeReview/accept.js";
import { PostImplementationReviewCoordinator } from "../../src/mastermind/codeReview/coordinator.js";
import { MastermindExecutionCoordinator } from "../../src/mastermind/execution/coordinator.js";
import type { DirectExecutorResolver } from "../../src/mastermind/execution/coordinator.js";
import {
  MastermindAction,
  MastermindEventType,
  MastermindState,
} from "../../src/mastermind/domain/events.js";
import { transitionMastermindState } from "../../src/mastermind/domain/machine.js";
import type { LinearGateway } from "../../src/mastermind/linear/client.js";
import { SqliteMastermindStore } from "../../src/mastermind/store/sqlite.js";
import type { LinearTicketSnapshot, MastermindWorkItem } from "../../src/mastermind/store/store.js";
import {
  ExecutorKind,
  type DirectExecutionRequest,
  type DirectExecutionResult,
  type DirectExecutor,
  type ExecutorHandle,
  type ExecutorStatus,
  type WorkspaceProvisioner,
} from "../../src/submind/index.js";
import type {
  ExecutionCommandRunner,
  ExecutionPreflightReport,
} from "../../src/submind/preflight.js";

const directories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Mastermind execution coordinator", () => {
  it("starts execution from a persisted dynamic project after restart", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "mastermind.sqlite");
    let store = new SqliteMastermindStore(path);
    await store.initialize();
    const work = await createPlannedDirectWork(store);
    const dynamicProject = {
      ...executionConfig(directory).projects.weavekit!,
      id: "prototype-wk-1",
      displayName: "Prototype WK-1",
      workingTree: "",
      repositoryMode: ProjectRepositoryMode.GREENFIELD,
      provisioningRoot: join(directory, "prototypes"),
      mainline: "main",
      validationCommands: [],
    };
    await store.setProjectPolicy(work.id, dynamicProject.id, dynamicProject);
    store.close();

    store = new SqliteMastermindStore(path);
    await store.initialize();
    const config = { ...executionConfig(directory), projects: {} };
    const coordinator = new MastermindExecutionCoordinator(
      config,
      store,
      new FakeExecutionLinear(),
      new FakeProvisioner(directory),
      executorResolver(new FakeExecutor()),
      { run: vi.fn() },
    );

    await coordinator.process(work.id);

    expect(await store.getWork(work.id)).toMatchObject({
      state: MastermindState.PROVISIONING,
      projectPolicyId: dynamicProject.id,
      resolvedProject: dynamicProject,
    });
    expect(await store.getCurrentExecutionAttempt(work.id)).toMatchObject({
      projectPolicyId: dynamicProject.id,
    });
    store.close();
  });

  it("reconciles every durable phase and projects one terminal outcome across restart", async () => {
    const directory = await tempDirectory();
    const store = new SqliteMastermindStore(join(directory, "mastermind.sqlite"));
    await store.initialize();
    const config = executionConfig(directory);
    config.mastermind.leaseDurationMs = 40;
    const work = await createPlannedDirectWork(store);
    const provisioner = new FakeProvisioner(directory);
    const executor = new FakeExecutor();
    const linear = new FakeExecutionLinear();
    const runner: ExecutionCommandRunner = {
      run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "passed", stderr: "" }),
    };
    let coordinator = new MastermindExecutionCoordinator(
      config,
      store,
      linear,
      provisioner,
      executorResolver(executor),
      runner,
    );

    await coordinator.process(work.id);
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.PROVISIONING });
    await coordinator.process(work.id);
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.PREFLIGHTING });
    await coordinator.process(work.id);
    expect(executor.preflightPaths).toEqual([directory]);
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.LAUNCHING });
    await coordinator.process(work.id);
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.RUNNING });
    await coordinator.process(work.id);
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.RUNNING });

    coordinator = new MastermindExecutionCoordinator(
      config,
      store,
      linear,
      provisioner,
      executorResolver(executor),
      runner,
    );
    await coordinator.process(work.id);
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.COLLECTING });
    await coordinator.process(work.id);
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.SUCCEEDED });
    await coordinator.process(work.id);
    await coordinator.process(work.id);

    expect(provisioner.provisionCalls).toBe(1);
    expect(executor.startCalls).toBe(1);
    expect(executor.collectCalls).toBe(1);
    expect(linear.commentCreates).toBe(1);
    expect(linear.comments).toHaveLength(1);
    expect(linear.comments[0]?.body).toContain("Continue in Herdr:");
    expect(linear.comments[0]?.body).toContain("mise run mastermind:attach 'WK-1'");
    expect(linear.comments[0]?.body).toContain("herdr agent attach 'mm-workone-a1'");
    expect(linear.comments[0]?.body).toContain("herdr agent focus 'mm-workone-a1'");
    expect(linear.comments[0]?.body).toContain(
      "herdr agent read 'mm-workone-a1' --source recent-unwrapped --lines 100",
    );
    expect(linear.comments[0]?.body).toContain(`cd '${directory}'`);
    expect(await store.getCurrentExecutionAttempt(work.id)).toMatchObject({
      attemptNumber: 1,
      state: MastermindState.SUCCEEDED,
      projection: { disposition: "applied" },
      verification: {
        passed: true,
        commands: [expect.objectContaining({ command: "nub run test", exitCode: 0 })],
      },
    });
    expect(await store.findExecutionAttachment("WK-1")).toMatchObject({
      workId: work.id,
      ticketIdentifier: "WK-1",
      attempt: {
        attemptNumber: 1,
        executorHandle: { agentName: "mm-workone-a1", worktreePath: directory },
      },
    });
    store.close();
  });

  it("does not launch without project opt-in", async () => {
    const directory = await tempDirectory();
    const store = new SqliteMastermindStore(join(directory, "mastermind.sqlite"));
    await store.initialize();
    const work = await createPlannedDirectWork(store);
    const config = executionConfig(directory);
    config.projects.weavekit!.directExecution = undefined;
    const executor = new FakeExecutor();
    const coordinator = new MastermindExecutionCoordinator(
      config,
      store,
      new FakeExecutionLinear(),
      new FakeProvisioner(directory),
      executorResolver(executor),
      { run: vi.fn() },
    );

    await coordinator.process(work.id);

    expect(await store.getWork(work.id)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
      currentExecutionAttemptId: undefined,
    });
    expect(executor.startCalls).toBe(0);
    store.close();
  });

  it("records and projects workspace description failures to Linear", async () => {
    const directory = await tempDirectory();
    const store = new SqliteMastermindStore(join(directory, "mastermind.sqlite"));
    await store.initialize();
    const work = await createPlannedDirectWork(store);
    const linear = new FakeExecutionLinear();
    const provisioner: WorkspaceProvisioner = {
      describe: vi
        .fn()
        .mockRejectedValue(
          new Error("ENOENT: no such file or directory, realpath '/missing/prototypes'"),
        ),
      provision: vi.fn(),
    };
    const coordinator = new MastermindExecutionCoordinator(
      executionConfig(directory),
      store,
      linear,
      provisioner,
      executorResolver(new FakeExecutor()),
      { run: vi.fn() },
    );

    await coordinator.process(work.id);
    await expect(coordinator.process(work.id)).resolves.toBeUndefined();
    expect(await store.getCurrentExecutionAttempt(work.id)).toMatchObject({
      state: MastermindState.NEEDS_HUMAN,
      failureClass: "WORKSPACE_PROVISIONING",
      failureMessage: "ENOENT: no such file or directory, realpath '/missing/prototypes'",
    });

    await coordinator.process(work.id);
    expect(linear.comments[0]?.body).toContain(
      "ENOENT: no such file or directory, realpath '/missing/prototypes'",
    );
    expect(linear.labelReplacements).toContainEqual({
      remove: ["ready", "failed"],
      add: ["needs-input"],
    });
    store.close();
  });

  it("delegates a DELEGATE_SUBMIND-planned work item to the RLM executor", async () => {
    const directory = await tempDirectory();
    const store = new SqliteMastermindStore(join(directory, "mastermind.sqlite"));
    await store.initialize();
    const config = executionConfig(directory);
    const work = await createPlannedDirectWork(store, MastermindAction.DELEGATE_SUBMIND);
    const provisioner = new FakeProvisioner(directory);
    const rlmExecutor = new FakeExecutor(ExecutorKind.RLM_SUBMIND);
    const linear = new FakeExecutionLinear();
    const coordinator = new MastermindExecutionCoordinator(
      config,
      store,
      linear,
      provisioner,
      { [ExecutorKind.RLM_SUBMIND]: rlmExecutor },
      { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "passed", stderr: "" }) },
    );

    await coordinator.process(work.id);
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.PROVISIONING });
    await coordinator.process(work.id);
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.PREFLIGHTING });
    await coordinator.process(work.id);
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.LAUNCHING });
    await coordinator.process(work.id);
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.RUNNING });
    expect(rlmExecutor.startCalls).toBe(1);

    const attempt = await store.getCurrentExecutionAttempt(work.id);
    expect(attempt).toMatchObject({ executorKind: ExecutorKind.RLM_SUBMIND });
    expect(attempt?.executorHandle).toMatchObject({ executor: ExecutorKind.RLM_SUBMIND });

    await coordinator.process(work.id);
    await coordinator.process(work.id);
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.COLLECTING });
    await coordinator.process(work.id);
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.SUCCEEDED });
    expect(rlmExecutor.collectCalls).toBe(1);
    store.close();
  });

  it("resumes a stored code-review result after its state transition is interrupted", async () => {
    const directory = await tempDirectory();
    await execFileAsync("git", ["init"], { cwd: directory });
    await execFileAsync("git", ["config", "user.email", "mastermind@example.test"], {
      cwd: directory,
    });
    await execFileAsync("git", ["config", "user.name", "Mastermind Test"], { cwd: directory });
    await writeFile(join(directory, "README.md"), "review fixture\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: directory });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: directory });

    const store = new SqliteMastermindStore(join(directory, "mastermind.sqlite"));
    await store.initialize();
    const config = executionConfig(directory);
    const work = await createPlannedDirectWork(store);
    const linear = new FakeExecutionLinear();
    const postReview = new PostImplementationReviewCoordinator(
      config,
      store,
      linear,
      {
        async review() {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return {
            summary: "Implementation satisfies the frozen ticket.",
            acceptanceCriteriaCoverage: ["Criterion covered by README.md."],
            verificationAssessment: ["Independent verification passed."],
            manualVerification: ["Open README.md and confirm the fixture."],
            findings: [],
            knownRisks: [],
            unansweredQuestions: [],
            confidence: 0.95,
          };
        },
      },
      {
        async synthesizeTicketPatch() {
          throw new Error("not used");
        },
        async decideNextAction() {
          throw new Error("not used");
        },
        async assessPostImplementationReview(_ticket, dossier) {
          return { ...dossier, verdict: PostImplementationReviewVerdict.PASS };
        },
      },
    );
    const coordinator = new MastermindExecutionCoordinator(
      config,
      store,
      linear,
      new FakeProvisioner(directory),
      executorResolver(new FakeExecutor()),
      { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "passed", stderr: "" }) },
      undefined,
      postReview,
    );
    const transition = store.transition.bind(store);
    let interrupted = false;
    store.transition = async (currentWork, owner, event) => {
      if (event.eventType === MastermindEventType.CODE_REVIEW_PASSED && !interrupted) {
        interrupted = true;
        throw new Error("simulated code-review transition interruption");
      }
      return transition(currentWork, owner, event);
    };

    for (let phase = 0; phase < 12; phase += 1) {
      try {
        await coordinator.process(work.id);
      } catch (error) {
        expect(error).toMatchObject({
          message: "simulated code-review transition interruption",
        });
      }
    }

    expect(interrupted).toBe(true);
    expect(await store.getWork(work.id)).toMatchObject({
      state: MastermindState.AWAITING_ACCEPTANCE,
    });
    expect(await store.getCurrentCodeReview(work.id)).toMatchObject({
      status: "passed",
      projection: { disposition: "applied" },
      review: { verdict: PostImplementationReviewVerdict.PASS },
    });
    expect(linear.states).toEqual(["In Progress", "In Review"]);
    expect(linear.comments).toHaveLength(2);
    expect(linear.comments[1]?.body).toContain("post-code review");
    await acceptMastermindWork({ selector: "WK-1", config, store, linear });
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.COMPLETED });
    expect(linear.states).toEqual(["In Progress", "In Review", "Done"]);
    expect(linear.comments).toHaveLength(3);
    expect(linear.comments[2]?.body).toContain("## Work location");
    expect(linear.comments[2]?.body).toContain(`cd '${directory}'`);
    expect(linear.comments[2]?.body).toContain("## Validation commands used");
    expect(linear.comments[2]?.body).toContain("nub run test");
    const acceptanceMarker = `<!-- weavekit-mastermind-acceptance:${work.id} -->`;
    linear.comments[2]!.body = `${acceptanceMarker}\nOld acceptance comment.`;
    await acceptMastermindWork({ selector: "WK-1", config, store, linear });
    expect(linear.comments).toHaveLength(3);
    expect(linear.comments[2]?.body).toContain("Canonical implementation worktree");
    store.close();
  });

  it("moves an exhausted retry to needs-human instead of throwing", async () => {
    const directory = await tempDirectory();
    const store = new SqliteMastermindStore(join(directory, "mastermind.sqlite"));
    await store.initialize();
    const work = await createPlannedDirectWork(store);
    const config = executionConfig(directory);
    config.mastermind.execution!.maxAttempts = 1;
    const linear = new FakeExecutionLinear();
    const coordinator = new MastermindExecutionCoordinator(
      config,
      store,
      linear,
      new FakeProvisioner(directory),
      executorResolver(new FakeExecutor()),
      { run: vi.fn() },
    );

    await coordinator.process(work.id);
    expect(linear.labelReplacements).toContainEqual({
      remove: ["ready", "needs-input", "failed"],
      add: [],
    });
    const leased = (await store.acquireLease(work.id, "test-mastermind", new Date(), 60_000))!;
    const attempt = (await store.getCurrentExecutionAttempt(work.id))!;
    await store.transitionExecutionAttempt({
      work: leased,
      attempt,
      owner: "test-mastermind",
      event: {
        eventType: MastermindEventType.RETRY,
        priorState: MastermindState.PROVISIONING,
        nextState: MastermindState.RETRY_WAIT,
      },
      patch: { retryEligible: true },
    });
    await store.releaseLease(work.id, "test-mastermind");

    await expect(coordinator.process(work.id)).resolves.toBeUndefined();
    expect(await store.getWork(work.id)).toMatchObject({ state: MastermindState.NEEDS_HUMAN });
    expect(await store.getCurrentExecutionAttempt(work.id)).toMatchObject({
      state: MastermindState.NEEDS_HUMAN,
      retryEligible: false,
      failureClass: "EXECUTION_RETRIES_EXHAUSTED",
    });
    await expect(coordinator.process(work.id)).resolves.toBeUndefined();
    expect(linear.labelReplacements).toContainEqual({
      remove: ["ready", "failed"],
      add: ["needs-input"],
    });
    store.close();
  });
});

class FakeProvisioner implements WorkspaceProvisioner {
  provisionCalls = 0;

  constructor(private readonly directory: string) {}

  async describe(request: Parameters<WorkspaceProvisioner["describe"]>[0]) {
    return {
      kind: "existing-repository-worktree" as const,
      sourceRepositoryPath: this.directory,
      checkoutPath: "",
      branchName: `mastermind/wk-1-${request.workId}`,
      parentWorkspaceLookupPath: this.directory,
      creatorAttemptId: request.attemptId,
    };
  }

  async provision(workspace: Parameters<WorkspaceProvisioner["provision"]>[0]) {
    this.provisionCalls += 1;
    return {
      ...workspace,
      checkoutPath: this.directory,
      lastObservedWorkspaceId: "workspace-one",
      lastObservedRootPaneId: "pane-one",
    };
  }
}

class FakeExecutor implements DirectExecutor {
  startCalls = 0;
  collectCalls = 0;
  preflightPaths: string[] = [];
  private statuses: ExecutorStatus["state"][] = ["working", "done"];
  private request?: DirectExecutionRequest;

  constructor(private readonly kind: ExecutorKind = ExecutorKind.HERDR_COPILOT) {}

  async preflight(request: DirectExecutionRequest): Promise<ExecutionPreflightReport> {
    this.preflightPaths.push(request.workspace.checkoutPath);
    return { accepted: true, checkedAt: new Date().toISOString(), checks: [] };
  }

  async start(
    request: DirectExecutionRequest,
    _approval: Parameters<DirectExecutor["start"]>[1],
  ): Promise<ExecutorHandle> {
    this.startCalls += 1;
    this.request = request;
    return {
      executor: this.kind,
      agentName: "mm-workone-a1",
      worktreePath: request.workspace.checkoutPath,
    };
  }

  async status(): Promise<ExecutorStatus> {
    return {
      state: this.statuses.shift() ?? "done",
      observedAt: new Date().toISOString(),
    };
  }

  async cancel(): Promise<{ confirmed: boolean; status: ExecutorStatus }> {
    return {
      confirmed: true,
      status: { state: "idle", observedAt: new Date().toISOString() },
    };
  }

  async collect(): Promise<DirectExecutionResult> {
    this.collectCalls += 1;
    if (!this.request) throw new Error("Executor was not started.");
    return {
      schemaVersion: 1,
      workId: this.request.workId,
      attemptId: this.request.attemptId,
      attemptNumber: this.request.attemptNumber,
      outcome: "succeeded",
      summary: "Implemented and verified.",
      artifactPaths: [],
      verification: [{ command: "nub run test", exitCode: 0, summary: "passed" }],
      knownRisks: [],
      remainingWork: [],
    };
  }
}

function executorResolver(executor: DirectExecutor): DirectExecutorResolver {
  return { [ExecutorKind.HERDR_COPILOT]: executor };
}

class FakeExecutionLinear implements LinearGateway {
  comments: Array<{ id: string; body: string }> = [];
  commentCreates = 0;
  states: string[] = [];
  labelReplacements: Array<{ remove: string[]; add: string[] }> = [];

  async fetchIssue(): Promise<LinearTicketSnapshot> {
    return ticket();
  }

  async updateIssueContent(): Promise<void> {}

  async replaceIssueLabels(
    _issueId: string,
    input: { remove: string[]; add: string[] },
  ): Promise<void> {
    this.labelReplacements.push(input);
  }

  async setIssueState(_issueId: string, stateName: string): Promise<void> {
    this.states.push(stateName);
  }

  async findIssueCommentByMarker(_issueId: string, marker: string): Promise<string | undefined> {
    return this.comments.find((comment) => comment.body.includes(marker))?.id;
  }

  async createIssueComment(_issueId: string, body: string): Promise<string> {
    this.commentCreates += 1;
    const id = `comment-${this.commentCreates}`;
    this.comments.push({ id, body });
    return id;
  }

  async updateIssueComment(commentId: string, body: string): Promise<void> {
    const comment = this.comments.find((candidate) => candidate.id === commentId);
    if (!comment) throw new Error(`Comment not found: ${commentId}`);
    comment.body = body;
  }
}

async function createPlannedDirectWork(
  store: SqliteMastermindStore,
  action: MastermindAction = MastermindAction.IMPLEMENT_DIRECTLY,
): Promise<MastermindWorkItem> {
  const delivery = await store.ingestDelivery({
    deliveryId: crypto.randomUUID(),
    organizationId: "organization-one",
    eventType: "Issue",
    action: "create",
    issueId: "issue-one",
  });
  let work = (await store.acquireLease(delivery.workId, "test-mastermind", new Date(), 60_000))!;
  for (const eventType of [
    MastermindEventType.CLAIM,
    MastermindEventType.DECIDE,
    MastermindEventType.PLAN_ACTION,
  ] as const) {
    const nextState = transitionMastermindState(work.state, { type: eventType });
    work = await store.transition(work, "test-mastermind", {
      eventType,
      priorState: work.state,
      nextState,
      ...(eventType === MastermindEventType.PLAN_ACTION
        ? { metadata: { plannedAction: action } }
        : {}),
    });
  }
  await store.setProjectPolicy(work.id, "weavekit");
  await store.saveTicketSnapshot(work.id, ticket());
  await store.saveReviewProposal(
    work.id,
    ticket(),
    "hash",
    { summary: "Ready." } as never,
    { automatedVerification: ["nub run test"] } as never,
  );
  const decision = {
    action,
    rationale:
      action === MastermindAction.IMPLEMENT_DIRECTLY
        ? "One bounded worker is sufficient."
        : "This work needs the recursive Submind harness.",
    prerequisites: [],
    policyEvidence: [],
    suggestedExecutorShape: action === MastermindAction.IMPLEMENT_DIRECTLY ? "direct" : "delegate",
    confidence: 0.95,
  } satisfies MastermindNextActionDecision;
  await store.saveDecision(work.id, decision);
  await store.releaseLease(work.id, "test-mastermind");
  return (await store.getWork(work.id))!;
}

function executionConfig(directory: string): WeavekitConfig {
  const config = loadTypedWeavekitConfig("/path/that/does/not/exist", {});
  return {
    ...config,
    mastermind: {
      ...config.mastermind,
      instanceId: "test-mastermind",
      leaseDurationMs: 60_000,
      readyLabelId: "ready",
      needsInputLabelId: "needs-input",
      reviewFailedLabelId: "failed",
      execution: {
        executorKind: ExecutorKind.HERDR_COPILOT,
        harnessKind: "copilot",
        maxAutopilotContinues: 5,
        allowTools: ["write"],
        denyTools: ["shell(git push)"],
        allowUrls: [],
        denyUrls: [],
        pollIntervalMs: 1000,
        unknownStatusThreshold: 3,
        cancellationGraceMs: 5000,
        promptAcceptanceTimeoutMs: 30000,
        maxAttempts: 2,
      },
      rlmExecution: {
        executorKind: ExecutorKind.RLM_SUBMIND,
        profile: "general",
        maxDepth: 3,
        maxTotalCalls: 20,
        enableTrellage: true,
        pollIntervalMs: 1000,
        unknownStatusThreshold: 3,
        cancellationGraceMs: 5000,
        maxAttempts: 2,
      },
    },
    projects: {
      weavekit: {
        id: "weavekit",
        displayName: "Weavekit",
        workingTree: directory,
        repositoryMode: ProjectRepositoryMode.EXISTING_REPOSITORY,
        mainline: "origin main",
        remote: "origin",
        contextDocs: [],
        validationCommands: ["nub run test"],
        autonomousPrAllowed: false,
        notification: "cli",
        knowledgeExport: "off",
        directExecution: {
          enabled: true,
          allowedExecutorKinds: [ExecutorKind.HERDR_COPILOT, ExecutorKind.RLM_SUBMIND],
          allowedPullRequestHosts: [],
        },
      },
    },
  };
}

function ticket(): LinearTicketSnapshot {
  return {
    id: "issue-one",
    identifier: "WK-1",
    url: "https://linear.app/example/issue/WK-1",
    title: "Implement direct execution",
    description: "Build the durable execution slice.",
    labels: [],
    status: "Todo",
    teamId: "team-one",
  };
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "weavekit-execution-coordinator-"));
  directories.push(directory);
  return directory;
}
