import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeepResearchProvider,
  ProjectRepositoryMode as ConfigProjectRepositoryMode,
  defaultCacheConfig,
  type WeavekitConfig,
} from "../../src/config.js";
import {
  MastermindAction,
  ProjectRepositoryMode,
  RepositoryEvidenceType,
  ReviewEvidenceKind,
  ReviewOpenItemKind,
  ReviewOpenItemOwner,
  ReviewReadiness,
  TicketKind,
  type LinearTicketInput,
  type MastermindNextActionDecision,
  type MastermindProjectPolicyInput,
  type MastermindReviewDecisionContext,
  type ProposedLinearTicketPatch,
  type TicketReviewDossier,
} from "../../src/generated/baml_client/index.js";
import type { MastermindDecisionProvider } from "../../src/mastermind/decision/bamlAdapters.js";
import { MastermindDecisionLoop } from "../../src/mastermind/decision/loop.js";
import { MastermindEventType, MastermindState } from "../../src/mastermind/domain/events.js";
import { transitionMastermindState } from "../../src/mastermind/domain/machine.js";
import { resolveMastermindFailureReasons } from "../../src/mastermind/failure.js";
import { ExecutorKind } from "../../src/submind/contracts.js";
import {
  validateMastermindExecutionRuntimeConfig,
  validateMastermindRuntimeConfig,
} from "../../src/mastermind/config.js";
import { mountLinearWebhook, verifyLinearSignature } from "../../src/mastermind/linear/channel.js";
import {
  LinearGraphQlGateway,
  type LinearGateway,
  type LinearIssueComment,
} from "../../src/mastermind/linear/client.js";
import type {
  TicketReviewHarness,
  TicketReviewRequest,
} from "../../src/mastermind/review/harness.js";
import { MastermindService } from "../../src/mastermind/service.js";
import { SqliteMastermindStore } from "../../src/mastermind/store/sqlite.js";
import type { LinearTicketSnapshot } from "../../src/mastermind/store/store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

function createConfig(databasePath: string): WeavekitConfig {
  return {
    env: {},
    copilot: { verboseEvents: false },
    flue: { model: "anthropic/claude-haiku-4-5" },
    mastermind: {
      enabled: true,
      host: "127.0.0.1",
      port: 8787,
      sqlitePath: databasePath,
      instanceId: "test-mastermind",
      webhookPath: "/webhooks/linear",
      linearOrganizationId: "organization-one",
      linearWebhookId: "webhook-one",
      synthesisModel: "gpt-5.5",
      reviewedLabelId: "reviewed-label-id",
      reviewedLabelName: "Mastermind Reviewed",
      readyLabelId: "ready-label-id",
      readyLabelName: "Mastermind Ready",
      needsInputLabelId: "needs-input-label-id",
      needsInputLabelName: "Mastermind Needs Input",
      reviewFailedLabelId: "review-failed-label-id",
      reviewFailedLabelName: "Mastermind Review Failed",
      leaseDurationMs: 30_000,
      reconcileIntervalMs: 1_000,
      maxDecisionIterations: 3,
      allowedActions: [
        MastermindAction.REVIEW_TICKET,
        MastermindAction.DELEGATE_SUBMIND,
        MastermindAction.WAIT,
        MastermindAction.NEEDS_HUMAN,
      ],
      projectMappings: [
        {
          teamId: "team-one",
          linearProjectId: "project-one",
          projectId: "weavekit",
        },
      ],
    },
    tooling: {},
    sourceToProject: {
      maxOpportunities: 1,
      thresholds: {
        minApplicability: 0.7,
        minConfidence: 0.65,
        minImpact: 0.5,
        minAcceptanceAverage: 0.85,
        maxRisk: 0.8,
      },
      mode: "advisory",
      offline: false,
      prLauncher: {
        provider: "herdr",
        agentCommand: "codex",
        agentArgs: [],
        split: "right",
        agentOptions: [],
      },
      budgetGate: {
        enabled: true,
        mode: "warn",
        ceilingUsd: 25,
        marginFactor: 1.5,
      },
      autoImplementOnReport: false,
    },
    router: {
      primaryModel: "gpt-5.5",
      catalog: [],
      preferences: [],
    },
    deepResearch: {
      providers: [DeepResearchProvider.EXA],
      maxIterations: 1,
      questionsPerIteration: 1,
      maxResultsPerQuestion: 1,
      providerRetryAttempts: 1,
      visualize: false,
    },
    verificationOptimizer: {
      mode: "autonomous-pr",
      externalResearch: false,
      thresholds: {
        minConfidence: 0.85,
        minImpact: 0.6,
        maxRisk: 0.35,
        maxImplementationCost: 0.45,
        minEvidenceReferences: 2,
        requireNonSpeculative: true,
        requireProofCommands: true,
      },
    },
    plugins: {},
    projects: {
      weavekit: {
        id: "weavekit",
        displayName: "Weavekit",
        workingTree: process.cwd(),
        mainline: "origin main",
        remote: "origin",
        contextDocs: ["CONTEXT.md"],
        validationCommands: ["nub run typecheck"],
        autonomousPrAllowed: true,
        notification: "cli",
        knowledgeExport: "off",
      },
    },
    cache: defaultCacheConfig(),
  };
}

async function createStore(): Promise<{
  store: SqliteMastermindStore;
  path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "weavekit-mastermind-"));
  tempDirs.push(directory);
  const path = join(directory, "mastermind.sqlite");
  const store = new SqliteMastermindStore(path);
  await store.initialize();
  return { store, path };
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 1_000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(stepMs);
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}

function createIssue(): LinearTicketSnapshot {
  return {
    id: "issue-one",
    identifier: "WK-1",
    url: "https://linear.app/weavekit/issue/WK-1/rough-title",
    title: "rough title",
    description: "rough description",
    teamId: "team-one",
    projectId: "project-one",
    status: "Todo",
    labels: [],
  };
}

class FakeLinearGateway implements LinearGateway {
  readonly issue = createIssue();
  fetchCalls = 0;
  readonly states: string[] = [];
  onFetch?: () => void;
  private failLabel = false;

  constructor(options?: { failLabelOnce?: boolean }) {
    this.failLabel = options?.failLabelOnce ?? false;
  }

  async fetchIssue(issueId: string): Promise<LinearTicketSnapshot> {
    expect(issueId).toBe(this.issue.id);
    this.fetchCalls += 1;
    this.onFetch?.();
    return structuredClone(this.issue);
  }

  async updateIssueContent(
    issueId: string,
    input: { title: string; description: string },
  ): Promise<void> {
    expect(issueId).toBe(this.issue.id);
    this.issue.title = input.title;
    this.issue.description = input.description;
  }

  async setIssueState(_issueId: string, stateName: string): Promise<void> {
    if (this.issue.status.toLocaleLowerCase() === stateName.toLocaleLowerCase()) return;
    this.issue.status = stateName;
    this.states.push(stateName);
  }

  async replaceIssueLabels(
    issueId: string,
    input: { remove: string[]; add: string[] },
  ): Promise<void> {
    expect(issueId).toBe(this.issue.id);
    if (this.failLabel) {
      this.failLabel = false;
      throw new Error("Temporary Linear label failure.");
    }
    const namesById: Record<string, string> = {
      "reviewed-label-id": "Mastermind Reviewed",
      "ready-label-id": "Mastermind Ready",
      "needs-input-label-id": "Mastermind Needs Input",
      "review-failed-label-id": "Mastermind Review Failed",
    };
    const remove = new Set(input.remove);
    this.issue.labels = this.issue.labels.filter((label) => !remove.has(label.id));
    for (const labelId of input.add) {
      if (!this.issue.labels.some((label) => label.id === labelId)) {
        this.issue.labels.push({ id: labelId, name: namesById[labelId] ?? labelId });
      }
    }
  }
}

/** FakeLinearGateway plus the optional comment surface the clarification flow depends on. */
class CommentRecordingLinearGateway extends FakeLinearGateway {
  readonly comments: LinearIssueComment[] = [];

  async listIssueComments(): Promise<LinearIssueComment[]> {
    return structuredClone(this.comments);
  }

  async findIssueCommentByMarker(_issueId: string, marker: string): Promise<string | undefined> {
    return this.comments.find((comment) => comment.body.includes(marker))?.id;
  }

  async createIssueComment(_issueId: string, body: string): Promise<string> {
    const id = `comment-${this.comments.length + 1}`;
    this.comments.push({
      id,
      body,
      createdAt: new Date(Date.now() + this.comments.length).toISOString(),
    });
    return id;
  }

  async updateIssueComment(commentId: string, body: string): Promise<void> {
    const comment = this.comments.find((candidate) => candidate.id === commentId);
    if (comment) {
      comment.body = body;
    }
  }
}

class FakeDecisionProvider implements MastermindDecisionProvider {
  synthesisCalls = 0;
  nextActionCalls = 0;
  nextActionContexts: MastermindReviewDecisionContext[] = [];

  async synthesizeTicketPatch(
    ticket: LinearTicketInput,
    _project: MastermindProjectPolicyInput,
    dossier: TicketReviewDossier,
  ): Promise<ProposedLinearTicketPatch> {
    this.synthesisCalls += 1;
    expect(ticket.id).toBe("issue-one");
    return {
      proposedTitle: "Implement durable Mastermind intake",
      proposedDescriptionMarkdown: "Build and verify the durable intake slice.",
      preservedIntent: dossier.preservedIntent,
      ticketKind: dossier.ticketKind,
      readiness: ReviewReadiness.READY,
      acceptanceCriteria: ["Signed webhook reaches action_planned."],
      assumptions: [],
      ambiguities: [],
      unansweredQuestions: [],
      openItemDispositions: [],
      dependencies: [],
      risks: [],
      automatedVerification: ["Run the Mastermind control-plane test."],
      manualVerification: [],
      validationSteps: ["Confirm the Linear ticket reaches action_planned."],
      observability: [],
      rolloutPlan: [],
      rollbackPlan: [],
      outOfScope: [],
      blockingReasons: [],
      warnings: [],
      evidence: dossier.repositoryEvidence,
      materialScopeChange: false,
      requiresHumanApproval: false,
      confidence: 0.95,
    };
  }

  async decideNextAction(
    _ticket: LinearTicketInput,
    _project: MastermindProjectPolicyInput,
    review: MastermindReviewDecisionContext,
  ): Promise<MastermindNextActionDecision> {
    this.nextActionCalls += 1;
    this.nextActionContexts.push(structuredClone(review));
    const reviewed = review.hasCurrentReview;
    const prerequisites = review.openItemDispositions
      .filter(
        (disposition) =>
          disposition.owner === ReviewOpenItemOwner.EXECUTOR_PREFLIGHT &&
          disposition.kind === ReviewOpenItemKind.UNANSWERED_QUESTION,
      )
      .map((disposition) => disposition.text);
    return {
      action: reviewed ? MastermindAction.DELEGATE_SUBMIND : MastermindAction.REVIEW_TICKET,
      rationale: reviewed ? "Ticket is ready." : "Ticket needs review.",
      prerequisites,
      policyEvidence: ["Project mapping permits this action."],
      suggestedExecutorShape: reviewed ? "bounded submind" : null,
      confidence: 0.95,
    };
  }
}

class ReviewAwarePreflightDecisionProvider extends FakeDecisionProvider {
  override async synthesizeTicketPatch(
    ticket: LinearTicketInput,
    project: MastermindProjectPolicyInput,
    dossier: TicketReviewDossier,
  ): Promise<ProposedLinearTicketPatch> {
    const patch = await super.synthesizeTicketPatch(ticket, project, dossier);
    return {
      ...patch,
      readiness: ReviewReadiness.READY_WITH_NONBLOCKING_GAPS,
      unansweredQuestions: ["Is the proxy runtime available in this environment?"],
      openItemDispositions: [
        {
          kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
          text: "Is the proxy runtime available in this environment?",
          owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
          rationale: "The executor can verify the proxy immediately before work starts.",
        },
      ],
      warnings: ["Verify the local proxy before implementation starts."],
    };
  }
}

class IncompletePreflightDecisionProvider extends ReviewAwarePreflightDecisionProvider {
  override async decideNextAction(
    ticket: LinearTicketInput,
    project: MastermindProjectPolicyInput,
    review: MastermindReviewDecisionContext,
  ): Promise<MastermindNextActionDecision> {
    const decision = await super.decideNextAction(ticket, project, review);
    return {
      ...decision,
      prerequisites: [],
    };
  }
}

class FakeReviewHarness implements TicketReviewHarness {
  reviewCalls = 0;

  async review(request: TicketReviewRequest): Promise<TicketReviewDossier> {
    this.reviewCalls += 1;
    expect(request.ticket.id).toBe("issue-one");
    return {
      ticketKind: TicketKind.USER_STORY,
      preservedIntent: "Create durable Mastermind intake.",
      repositoryEvidence: [
        {
          id: "repo-package",
          kind: ReviewEvidenceKind.REPOSITORY,
          repositoryEvidenceType: RepositoryEvidenceType.FILE,
          repositoryPath: "package.json",
          claim: "The repository uses Nub scripts.",
          confidence: 1,
        },
      ],
      linearEvidence: [],
      externalEvidence: [],
      assumptions: [],
      ambiguities: [],
      unansweredQuestions: [],
      dependencies: [],
      risks: [],
      suggestedAcceptanceCriteria: ["Signed webhook reaches action_planned."],
      automatedVerification: ["Run the Mastermind control-plane test."],
      manualVerification: [],
      validationSteps: ["Confirm the ticket reaches action_planned."],
      observability: [],
      rolloutPlan: [],
      rollbackPlan: [],
      outOfScope: [],
      materialScopeChange: false,
      summary: "Ticket is implementation-ready after clarification.",
      confidence: 0.95,
    };
  }
}

class StaleOnceReviewHarness extends FakeReviewHarness {
  private changed = false;

  constructor(private readonly linear: FakeLinearGateway) {
    super();
  }

  override async review(request: TicketReviewRequest): Promise<TicketReviewDossier> {
    const dossier = await super.review(request);
    if (!this.changed) {
      this.changed = true;
      this.linear.issue.description = "Human clarified the ticket during review.";
    }
    return dossier;
  }
}

class InvalidEvidenceReviewHarness extends FakeReviewHarness {
  override async review(request: TicketReviewRequest): Promise<TicketReviewDossier> {
    const dossier = await super.review(request);
    dossier.repositoryEvidence[0]!.repositoryPath = "missing-file.ts";
    dossier.repositoryEvidence[0]!.repositoryLine = 10;
    return dossier;
  }
}

class SearchEvidenceReviewHarness extends FakeReviewHarness {
  override async review(request: TicketReviewRequest): Promise<TicketReviewDossier> {
    const dossier = await super.review(request);
    dossier.repositoryEvidence = [
      {
        id: "repo-dotnet-search",
        kind: ReviewEvidenceKind.REPOSITORY,
        repositoryEvidenceType: RepositoryEvidenceType.SEARCH,
        repositoryPath: ".",
        repositoryQuery: "**/*.{csproj,sln,cs}",
        claim: "No existing .NET project was found.",
        confidence: 1,
      },
    ];
    return dossier;
  }
}

class GreenfieldReviewHarness extends FakeReviewHarness {
  override async review(request: TicketReviewRequest): Promise<TicketReviewDossier> {
    expect(request.project).toMatchObject({
      repositoryMode: ProjectRepositoryMode.GREENFIELD,
      provisioningRoot: expect.any(String),
    });
    const dossier = await super.review(request);
    return {
      ...dossier,
      summary: "The prototype is greenfield and has no repository yet.",
      repositoryEvidence: [],
    };
  }
}

class FailingReviewHarness implements TicketReviewHarness {
  async review(): Promise<TicketReviewDossier> {
    throw new Error("Frontier harness unavailable.");
  }
}

class BlockingReviewHarness extends FakeReviewHarness {
  readonly started: Promise<void>;
  private readonly markStarted: () => void;
  private readonly released: Promise<void>;
  private readonly markReleased: () => void;

  constructor() {
    super();
    let start!: () => void;
    let release!: () => void;
    this.started = new Promise<void>((resolve) => {
      start = resolve;
    });
    this.released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.markStarted = start;
    this.markReleased = release;
  }

  release(): void {
    this.markReleased();
  }

  override async review(request: TicketReviewRequest): Promise<TicketReviewDossier> {
    const dossier = await super.review(request);
    this.markStarted();
    await this.released;
    return dossier;
  }
}

class BlockedDecisionProvider extends FakeDecisionProvider {
  override async synthesizeTicketPatch(
    ticket: LinearTicketInput,
    project: MastermindProjectPolicyInput,
    dossier: TicketReviewDossier,
  ): Promise<ProposedLinearTicketPatch> {
    const patch = await super.synthesizeTicketPatch(ticket, project, dossier);
    return {
      ...patch,
      readiness: ReviewReadiness.BLOCKED,
      blockingReasons: ["Product owner must choose the compatibility policy."],
      unansweredQuestions: ["Which compatibility policy is required?"],
      openItemDispositions: [
        {
          kind: ReviewOpenItemKind.BLOCKING_REASON,
          text: "Product owner must choose the compatibility policy.",
          owner: ReviewOpenItemOwner.HUMAN,
          rationale: "Only a human owner can choose the compatibility promise.",
        },
        {
          kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
          text: "Which compatibility policy is required?",
          owner: ReviewOpenItemOwner.HUMAN,
          rationale: "Only a human owner can choose the compatibility promise.",
        },
      ],
      requiresHumanApproval: true,
    };
  }
}

class ExternalDependencyDecisionProvider extends FakeDecisionProvider {
  override async synthesizeTicketPatch(
    ticket: LinearTicketInput,
    project: MastermindProjectPolicyInput,
    dossier: TicketReviewDossier,
  ): Promise<ProposedLinearTicketPatch> {
    const patch = await super.synthesizeTicketPatch(ticket, project, dossier);
    return {
      ...patch,
      readiness: ReviewReadiness.BLOCKED,
      blockingReasons: ["The vendor sandbox is unavailable to the executor."],
      unansweredQuestions: ["When will the vendor sandbox become reachable again?"],
      openItemDispositions: [
        {
          kind: ReviewOpenItemKind.BLOCKING_REASON,
          text: "The vendor sandbox is unavailable to the executor.",
          owner: ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
          rationale: "The executor cannot unblock the vendor sandbox.",
        },
        {
          kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
          text: "When will the vendor sandbox become reachable again?",
          owner: ReviewOpenItemOwner.EXTERNAL_DEPENDENCY,
          rationale: "The executor cannot unblock the vendor sandbox.",
        },
      ],
      requiresHumanApproval: false,
    };
  }
}

class WaitForBlockedPreflightDecisionProvider extends FakeDecisionProvider {
  override async decideNextAction(
    _ticket: LinearTicketInput,
    _project: MastermindProjectPolicyInput,
    review: MastermindReviewDecisionContext,
  ): Promise<MastermindNextActionDecision> {
    this.nextActionCalls += 1;
    this.nextActionContexts.push(structuredClone(review));
    return {
      action: MastermindAction.WAIT,
      rationale: "The executor should wait for preflight clarity.",
      prerequisites: [],
      policyEvidence: ["The review is blocked."],
      suggestedExecutorShape: null,
      confidence: 0.61,
    };
  }
}

describe("Mastermind durable control plane", () => {
  it("yields an in-progress execution state to the execution coordinator", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174099",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    let work = (await store.acquireLease(delivery.workId, "test-mastermind", new Date(), 30_000))!;
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
          ? { metadata: { plannedAction: MastermindAction.DELEGATE_SUBMIND } }
          : {}),
      });
    }
    await store.setProjectPolicy(work.id, "weavekit");
    await store.createExecutionAttempt({
      work,
      owner: "test-mastermind",
      projectPolicyId: "weavekit",
      projectPolicyVersion: "policy-one",
      executorKind: ExecutorKind.RLM_SUBMIND,
      action: MastermindAction.DELEGATE_SUBMIND,
    });
    await store.releaseLease(work.id, "test-mastermind");
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      new FakeLinearGateway(),
      new FakeDecisionProvider(),
      new FakeReviewHarness(),
    );

    await expect(loop.process(work.id)).resolves.toBeUndefined();
    expect(await store.getWork(work.id)).toMatchObject({
      state: MastermindState.PROVISIONING,
    });
    store.close();
  });

  it("does not allow the same instance to acquire one work lease concurrently", async () => {
    const { store } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174008",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const now = new Date();

    await expect(
      store.acquireLease(delivery.workId, "test-mastermind", now, 30_000),
    ).resolves.toBeDefined();
    await expect(
      store.acquireLease(delivery.workId, "test-mastermind", new Date(now.getTime() + 1), 30_000),
    ).resolves.toBeUndefined();

    await store.releaseLease(delivery.workId, "test-mastermind");
    await expect(
      store.acquireLease(delivery.workId, "test-mastermind", new Date(now.getTime() + 2), 30_000),
    ).resolves.toBeDefined();
    store.close();
  });

  it("renews only an active lease owned by the caller", async () => {
    const { store } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174018",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const now = new Date();
    await store.acquireLease(delivery.workId, "test-mastermind", now, 100);

    await expect(
      store.renewLease(delivery.workId, "test-mastermind", new Date(now.getTime() + 25), 100),
    ).resolves.toBe(true);
    await expect(
      store.renewLease(delivery.workId, "other-instance", new Date(now.getTime() + 30), 100),
    ).resolves.toBe(false);
    await expect(
      store.renewLease(delivery.workId, "test-mastermind", new Date(now.getTime() + 200), 100),
    ).resolves.toBe(false);
    store.close();
  });

  it("rejects transitions after the lease expires", async () => {
    const { store } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174019",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const expired = await store.acquireLease(
      delivery.workId,
      "test-mastermind",
      new Date(Date.now() - 1_000),
      1,
    );
    expect(expired).toBeDefined();

    await expect(
      store.transition(expired!, "test-mastermind", {
        eventType: MastermindEventType.CLAIM,
        priorState: MastermindState.RECEIVED,
        nextState: MastermindState.CLAIMED,
      }),
    ).rejects.toThrow(`Stale Mastermind transition for work item ${delivery.workId}.`);
    store.close();
  });

  it("keeps the lease alive during a long-running review", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174020",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const config = createConfig(path);
    config.mastermind.leaseDurationMs = 600;
    const harness = new BlockingReviewHarness();
    const linear = new FakeLinearGateway();
    const loop = new MastermindDecisionLoop(
      config,
      store,
      linear,
      new FakeDecisionProvider(),
      harness,
    );

    const processing = loop.process(delivery.workId);
    await harness.started;
    expect(linear.states).toEqual(["In Progress"]);
    await delay(1_300);
    const activeWork = await store.getWork(delivery.workId);
    expect(Date.parse(activeWork?.leaseExpiresAt ?? "")).toBeGreaterThan(Date.now());
    harness.release();
    await processing;

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
    store.close();
  });

  it("fails closed when active work cannot project its Linear workflow state", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174021",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const backing = new FakeLinearGateway();
    const linear: LinearGateway = {
      fetchIssue: (issueId) => backing.fetchIssue(issueId),
      updateIssueContent: (issueId, input) => backing.updateIssueContent(issueId, input),
      replaceIssueLabels: (issueId, input) => backing.replaceIssueLabels(issueId, input),
    };
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new FakeDecisionProvider(),
      new FakeReviewHarness(),
    );

    await expect(loop.process(delivery.workId)).rejects.toThrow(
      "Linear gateway does not support workflow-state projection.",
    );
    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.DECIDING,
    });
    store.close();
  });

  it("joins duplicate service requests for the same work item", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174009",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const harness = new BlockingReviewHarness();
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      new FakeLinearGateway(),
      new FakeDecisionProvider(),
      harness,
    );
    const service = new MastermindService(createConfig(path).mastermind, store, loop);
    await service.start();
    await harness.started;

    const first = service.processAndWait(delivery.workId);
    const second = service.processAndWait(delivery.workId);
    expect(first).toBe(second);
    harness.release();
    await Promise.all([first, second]);

    expect(harness.reviewCalls).toBe(1);
    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
    });
    await service.stop();
  });

  it("fails closed when required runtime configuration is missing", async () => {
    const { path, store } = await createStore();
    const config = createConfig(path).mastermind;

    expect(() => validateMastermindRuntimeConfig(config, {})).toThrow("LINEAR_API_KEY");
    expect(() =>
      validateMastermindRuntimeConfig(config, {
        LINEAR_API_KEY: "test-key",
        LINEAR_WEBHOOK_SECRET: "test-secret",
      }),
    ).not.toThrow();
    store.close();
  });

  it("accepts RLM-only execution runtime configuration", async () => {
    const { path, store } = await createStore();
    const config = createConfig(path).mastermind;
    config.rlmExecution = {
      executorKind: "rlm-submind",
      profile: "general",
      maxDepth: 3,
      maxTotalCalls: 20,
      visualizationRenderer: "copilot-sdk",
      enableTrellage: true,
      pollIntervalMs: 1_000,
      unknownStatusThreshold: 3,
      cancellationGraceMs: 5_000,
      maxAttempts: 2,
    };

    expect(() =>
      validateMastermindExecutionRuntimeConfig(config, { LINEAR_API_KEY: "test-key" }),
    ).not.toThrow();
    store.close();
  });

  it("deduplicates signed Linear deliveries and rejects invalid signatures", async () => {
    const { store, path } = await createStore();
    const config = createConfig(path).mastermind;
    const app = new Hono();
    const accepted: string[] = [];
    mountLinearWebhook({
      app,
      config,
      webhookSecret: "test-secret",
      store,
      onAccepted: (workId) => accepted.push(workId),
    });
    const payload = JSON.stringify({
      action: "create",
      type: "Issue",
      organizationId: "organization-one",
      webhookId: "webhook-one",
      webhookTimestamp: Date.now(),
      data: { id: "issue-one" },
    });
    const signature = createHmac("sha256", "test-secret").update(payload).digest("hex");
    const headers = {
      "content-type": "application/json",
      "linear-delivery": "123e4567-e89b-42d3-a456-426614174000",
      "linear-signature": signature,
    };

    const first = await app.request("/webhooks/linear", {
      method: "POST",
      headers,
      body: payload,
    });
    const duplicate = await app.request("/webhooks/linear", {
      method: "POST",
      headers,
      body: payload,
    });
    const invalid = await app.request("/webhooks/linear", {
      method: "POST",
      headers: { ...headers, "linear-signature": "invalid" },
      body: payload,
    });

    expect(first.status).toBe(200);
    expect((await first.json()) as Record<string, unknown>).toMatchObject({
      accepted: true,
      duplicate: false,
    });
    expect((await duplicate.json()) as Record<string, unknown>).toMatchObject({
      accepted: true,
      duplicate: true,
    });
    expect(invalid.status).toBe(401);
    expect(accepted).toHaveLength(1);
    expect(verifyLinearSignature(payload, signature, "test-secret")).toBe(true);
    store.close();
  });

  it("reviews once, plans a submind, and survives restart without replay", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174001",
      organizationId: "organization-one",
      webhookId: "webhook-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new FakeLinearGateway();
    const progress: string[] = [];
    const decisions = new FakeDecisionProvider();
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      decisions,
      new FakeReviewHarness(),
      (message) => progress.push(message),
    );

    await loop.process(delivery.workId);

    const work = await store.getWork(delivery.workId);
    expect(work).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
      plannedAction: MastermindAction.DELEGATE_SUBMIND,
    });
    expect(linear.issue).toMatchObject({
      title: "Implement durable Mastermind intake",
      description: "Build and verify the durable intake slice.",
    });
    expect(linear.issue.labels.map((label) => label.name)).toContain("Mastermind Reviewed");
    expect(linear.issue.labels.map((label) => label.name)).toContain("Mastermind Ready");
    expect(decisions.nextActionContexts).toEqual([
      expect.objectContaining({
        hasCurrentReview: false,
        blockingReasons: [],
        warnings: [],
        unansweredQuestions: [],
        openItemDispositions: [],
      }),
      expect.objectContaining({
        hasCurrentReview: true,
        readiness: ReviewReadiness.READY,
        requiresHumanApproval: false,
        blockingReasons: [],
        warnings: [],
        unansweredQuestions: [],
        openItemDispositions: [],
        reviewConfidence: 0.95,
      }),
    ]);
    expect(progress).toEqual(
      expect.arrayContaining([
        "Selecting the initial review action.",
        "Frontier harness is inspecting repository evidence.",
        "Evidence dossier complete; BAML is synthesizing the ticket patch.",
        "Deterministic review policy gates complete.",
        "Applying the governed review result to Linear.",
      ]),
    );
    const events = await store.listEvents(delivery.workId);
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "REVIEW",
        "review.generated",
        "review.content_applied",
        "review.label_applied",
        "decision.recorded",
        "PLAN_ACTION",
      ]),
    );
    const reviewId = (await store.getLatestReview(delivery.workId))?.id;
    store.close();

    const restartedStore = new SqliteMastermindStore(path);
    await restartedStore.initialize();
    const restartedProgress: string[] = [];
    const restartedLoop = new MastermindDecisionLoop(
      createConfig(path),
      restartedStore,
      linear,
      new FakeDecisionProvider(),
      new FakeReviewHarness(),
      (message) => restartedProgress.push(message),
    );
    await restartedLoop.process(delivery.workId);
    const restartedWork = await restartedStore.getWork(delivery.workId);
    expect(restartedWork?.state).toBe(MastermindState.ACTION_PLANNED);
    expect((await restartedStore.getLatestReview(delivery.workId))?.id).toBe(reviewId);
    expect(restartedProgress).toContain(
      [
        "Pulled Linear ticket WK-1 — Implement durable Mastermind intake",
        "URL: https://linear.app/weavekit/issue/WK-1/rough-title",
        `Reason: Work item ${delivery.workId} is action_planned. Mastermind is verifying that the completed review and "Mastermind Reviewed" label still match Linear before reusing the planned action.`,
        "Next: The ticket still matches the completed review; keep action_planned and continue with DELEGATE_SUBMIND.",
      ].join("\n"),
    );
    restartedStore.close();
  });

  it("resumes a partially applied review without regenerating it", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174002",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new FakeLinearGateway({ failLabelOnce: true });
    const decisions = new FakeDecisionProvider();
    const harness = new FakeReviewHarness();
    const loop = new MastermindDecisionLoop(createConfig(path), store, linear, decisions, harness);

    await expect(loop.process(delivery.workId)).rejects.toThrow("Temporary Linear label failure.");
    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.APPLYING_REVIEW,
    });
    expect(await store.getLatestReview(delivery.workId)).toMatchObject({
      contentApplied: true,
      labelApplied: false,
      appliedSnapshot: expect.objectContaining({
        title: "Implement durable Mastermind intake",
        description: "Build and verify the durable intake slice.",
      }),
    });

    await loop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
    });
    expect(decisions.synthesisCalls).toBe(1);
    expect(harness.reviewCalls).toBe(1);
    store.close();
  });

  it("reopens instead of blessing a human edit after content is applied but labels fail", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174029",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new FakeLinearGateway({ failLabelOnce: true });
    const initialLoop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new FakeDecisionProvider(),
      new FakeReviewHarness(),
    );

    await expect(initialLoop.process(delivery.workId)).rejects.toThrow(
      "Temporary Linear label failure.",
    );
    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.APPLYING_REVIEW,
      plannedAction: undefined,
    });

    linear.issue.description = "Human rewrote the reviewed content before label retry.";

    const retryHarness = new BlockingReviewHarness();
    const retryLoop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new FakeDecisionProvider(),
      retryHarness,
    );

    const retrying = retryLoop.process(delivery.workId);
    await retryHarness.started;

    expect(linear.issue.labels.map((label) => label.name)).not.toContain("Mastermind Reviewed");
    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.REVIEWING,
      plannedAction: undefined,
    });
    expect((await store.listEvents(delivery.workId)).map((event) => event.eventType)).not.toContain(
      MastermindEventType.PLAN_ACTION,
    );

    retryHarness.release();
    await retrying;

    expect(retryHarness.reviewCalls).toBe(1);
    expect((await store.listEvents(delivery.workId)).map((event) => event.eventType)).toContain(
      "review.invalidated",
    );
    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
    });
    store.close();
  });

  it("re-reviews a ticket when the reviewed label exists without a stored review", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174023",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new FakeLinearGateway();
    linear.issue.labels.push({ id: "reviewed-label-id", name: "Mastermind Reviewed" });
    const decisions = new FakeDecisionProvider();
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      decisions,
      new FakeReviewHarness(),
    );

    await loop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
      plannedAction: MastermindAction.DELEGATE_SUBMIND,
    });
    expect(decisions.nextActionCalls).toBe(1);
    expect(decisions.nextActionContexts).toEqual([
      expect.objectContaining({
        hasCurrentReview: true,
        readiness: ReviewReadiness.READY,
      }),
    ]);
    store.close();
  });

  it("reopens action_planned work when the reviewed label remains but the stored review is missing", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174028",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new FakeLinearGateway();
    const decisions = new FakeDecisionProvider();
    const harness = new FakeReviewHarness();
    const progress: string[] = [];
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      decisions,
      harness,
      (message) => progress.push(message),
    );

    await loop.process(delivery.workId);
    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
      plannedAction: MastermindAction.DELEGATE_SUBMIND,
    });

    const database = new DatabaseSync(path);
    database
      .prepare(
        `DELETE FROM mastermind_reviews
         WHERE work_id = ?`,
      )
      .run(delivery.workId);
    database.close();

    progress.length = 0;
    await loop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
      plannedAction: MastermindAction.DELEGATE_SUBMIND,
    });
    expect(harness.reviewCalls).toBe(2);
    expect(decisions.synthesisCalls).toBe(2);
    expect((await store.listEvents(delivery.workId)).map((event) => event.eventType)).toContain(
      MastermindEventType.REOPEN_REVIEW,
    );
    expect(progress[0]).toBe(
      [
        "Pulled Linear ticket WK-1 — Implement durable Mastermind intake",
        "URL: https://linear.app/weavekit/issue/WK-1/rough-title",
        `Reason: Work item ${delivery.workId} is action_planned. Mastermind is verifying that the completed review and "Mastermind Reviewed" label still match Linear before reusing the planned action.`,
        'Next: Reopen review because no current stored review exists for the "Mastermind Reviewed" ticket; clear Mastermind labels and generate a fresh review.',
      ].join("\n"),
    );
    store.close();
  });

  it("reopens stale terminal reviewed work during service startup reconciliation", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174030",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new FakeLinearGateway();
    const initialLoop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new FakeDecisionProvider(),
      new FakeReviewHarness(),
    );

    await initialLoop.process(delivery.workId);
    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
    });
    store.close();

    linear.issue.description = "Human updated the ticket while Mastermind was offline.";

    const restartedStore = new SqliteMastermindStore(path);
    await restartedStore.initialize();
    const restartHarness = new BlockingReviewHarness();
    const restartLoop = new MastermindDecisionLoop(
      createConfig(path),
      restartedStore,
      linear,
      new FakeDecisionProvider(),
      restartHarness,
    );
    const service = new MastermindService(
      createConfig(path).mastermind,
      restartedStore,
      restartLoop,
    );

    await service.start();
    await restartHarness.started;

    expect(await restartedStore.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.REVIEWING,
    });

    restartHarness.release();
    await service.processAndWait(delivery.workId);

    expect(restartHarness.reviewCalls).toBe(1);
    expect(
      (await restartedStore.listEvents(delivery.workId)).map((event) => event.eventType),
    ).toContain(MastermindEventType.REOPEN_REVIEW);
    expect(await restartedStore.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
    });
    await service.stop();
  });

  it("checks unchanged terminal reviewed work on service startup without rerunning review", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174031",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new FakeLinearGateway();
    const initialLoop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new FakeDecisionProvider(),
      new FakeReviewHarness(),
    );

    await initialLoop.process(delivery.workId);
    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
      plannedAction: MastermindAction.DELEGATE_SUBMIND,
    });
    store.close();

    let markFetched!: () => void;
    const fetched = new Promise<void>((resolve) => {
      markFetched = resolve;
    });
    linear.onFetch = () => {
      linear.onFetch = undefined;
      markFetched();
    };

    const restartedStore = new SqliteMastermindStore(path);
    await restartedStore.initialize();
    const restartHarness = new FakeReviewHarness();
    const restartDecisions = new FakeDecisionProvider();
    const restartLoop = new MastermindDecisionLoop(
      createConfig(path),
      restartedStore,
      linear,
      restartDecisions,
      restartHarness,
    );
    const service = new MastermindService(
      createConfig(path).mastermind,
      restartedStore,
      restartLoop,
    );

    await service.start();
    await fetched;
    await waitFor(
      async () => (await restartedStore.getWork(delivery.workId))?.leaseOwner === undefined,
    );

    expect(linear.fetchCalls).toBeGreaterThan(0);
    expect(restartHarness.reviewCalls).toBe(0);
    expect(restartDecisions.nextActionCalls).toBe(0);
    expect(linear.states).toEqual(["In Progress"]);
    expect(
      (await restartedStore.listEvents(delivery.workId)).map((event) => event.eventType),
    ).not.toContain(MastermindEventType.REOPEN_REVIEW);
    expect(await restartedStore.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
      plannedAction: MastermindAction.DELEGATE_SUBMIND,
    });
    await service.stop();
  });

  it("paginates the startup terminal scan across more than 100 items and includes missing or invalidated review rows", async () => {
    const { store, path } = await createStore();
    const database = new DatabaseSync(path);
    const insertWork = database.prepare(
      `INSERT INTO mastermind_work_items
        (id, organization_id, issue_id, state, planned_action, lease_owner, lease_expires_at,
         retry_count, row_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertReview = database.prepare(
      `INSERT INTO mastermind_reviews
        (id, work_id, original_snapshot_json, original_content_hash, dossier_json, patch_json,
         review_json, validation_json, applied_snapshot_json, content_applied, label_applied,
         invalidated, invalidation_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const baseTimestamp = Date.parse("2026-01-01T00:00:00.000Z");
    const actionPlannedIds = Array.from({ length: 101 }, (_, index) => `work-action-${index + 1}`);
    const invalidatedReviewWorkId = "work-invalidated-review";
    const missingReviewWorkId = "work-missing-review";
    const failedNoReviewWorkId = "work-failed-no-review";
    const allWorkIds = [
      ...actionPlannedIds,
      invalidatedReviewWorkId,
      missingReviewWorkId,
      failedNoReviewWorkId,
    ];

    for (const [index, workId] of allWorkIds.entries()) {
      const timestamp = new Date(baseTimestamp + index * 1_000).toISOString();
      const state =
        workId === missingReviewWorkId
          ? MastermindState.NEEDS_HUMAN
          : workId === failedNoReviewWorkId
            ? MastermindState.FAILED
            : MastermindState.ACTION_PLANNED;
      insertWork.run(
        workId,
        "organization-one",
        `issue-${index + 1}`,
        state,
        state === MastermindState.ACTION_PLANNED ? MastermindAction.DELEGATE_SUBMIND : null,
        null,
        null,
        0,
        0,
        timestamp,
        timestamp,
      );
    }
    insertReview.run(
      "review-invalidated",
      invalidatedReviewWorkId,
      JSON.stringify(createIssue()),
      "hash-invalidated",
      "{}",
      "{}",
      "{}",
      null,
      JSON.stringify(createIssue()),
      1,
      1,
      1,
      "Superseded during restart coverage.",
      new Date(baseTimestamp + allWorkIds.length * 1_000).toISOString(),
      new Date(baseTimestamp + allWorkIds.length * 1_000).toISOString(),
    );
    database.close();

    const processedWorkIds: string[] = [];
    const loop = {
      async process(workId: string): Promise<void> {
        processedWorkIds.push(workId);
      },
    } as unknown as MastermindDecisionLoop;
    const config = createConfig(path).mastermind;
    config.reconcileIntervalMs = 60_000;
    const service = new MastermindService(config, store, loop);

    await service.start();
    await service.stop();

    expect(processedWorkIds).toHaveLength(allWorkIds.length);
    expect(new Set(processedWorkIds).size).toBe(allWorkIds.length);
    expect(processedWorkIds).toEqual(
      expect.arrayContaining([invalidatedReviewWorkId, missingReviewWorkId, failedNoReviewWorkId]),
    );
  });

  it("passes stored review readiness and open-item ownership into next-action selection", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174024",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const decisions = new ReviewAwarePreflightDecisionProvider();
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      new FakeLinearGateway(),
      decisions,
      new FakeReviewHarness(),
    );

    await loop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
      plannedAction: MastermindAction.DELEGATE_SUBMIND,
    });
    expect(decisions.nextActionContexts).toEqual([
      expect.objectContaining({
        hasCurrentReview: false,
      }),
      expect.objectContaining({
        hasCurrentReview: true,
        readiness: ReviewReadiness.READY_WITH_NONBLOCKING_GAPS,
        requiresHumanApproval: false,
        warnings: ["Verify the local proxy before implementation starts."],
        unansweredQuestions: ["Is the proxy runtime available in this environment?"],
        openItemDispositions: [
          expect.objectContaining({
            kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
            text: "Is the proxy runtime available in this environment?",
            owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
          }),
        ],
        reviewConfidence: 0.95,
      }),
    ]);
    store.close();
  });

  it("routes implementation recommendations without executor preflight coverage to needs_human", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174025",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      new FakeLinearGateway(),
      new IncompletePreflightDecisionProvider(),
      new FakeReviewHarness(),
    );

    await loop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.NEEDS_HUMAN,
      plannedAction: undefined,
    });
    expect(await store.listEvents(delivery.workId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: MastermindEventType.REQUIRE_HUMAN,
          metadata: expect.objectContaining({
            decision: expect.objectContaining({
              action: MastermindAction.DELEGATE_SUBMIND,
              prerequisites: [],
            }),
            decisionOverride: expect.objectContaining({
              originalAction: MastermindAction.DELEGATE_SUBMIND,
              overriddenAction: MastermindAction.NEEDS_HUMAN,
              missingExecutorPreflightItems: [
                "Is the proxy runtime available in this environment?",
              ],
            }),
          }),
        }),
      ]),
    );
    store.close();
  });

  it("routes blocked external dependencies to wait without misusing executor preflight", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174026",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const decisions = new ExternalDependencyDecisionProvider();
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      new FakeLinearGateway(),
      decisions,
      new FakeReviewHarness(),
    );

    await loop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
      plannedAction: MastermindAction.WAIT,
    });
    expect(decisions.nextActionCalls).toBe(1);
    expect(await store.listEvents(delivery.workId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: MastermindEventType.PLAN_ACTION,
          metadata: expect.objectContaining({
            deterministicRouting: expect.objectContaining({
              action: MastermindAction.WAIT,
              reason: "Stored review is blocked only by known external dependencies.",
            }),
          }),
        }),
      ]),
    );
    store.close();
  });

  it("fails closed when a blocked executor-preflight review is misrouted to wait", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174032",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new FakeLinearGateway();
    const initialLoop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new FakeDecisionProvider(),
      new FakeReviewHarness(),
    );

    await initialLoop.process(delivery.workId);
    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
    });

    const database = new DatabaseSync(path);
    const reviewRow = database
      .prepare(
        `SELECT id, patch_json
         FROM mastermind_reviews
         WHERE work_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(delivery.workId) as { id: string; patch_json: string };
    const blockedPatch = JSON.parse(reviewRow.patch_json) as ProposedLinearTicketPatch;
    blockedPatch.readiness = ReviewReadiness.BLOCKED;
    blockedPatch.blockingReasons = ["The executor must verify the runtime before implementation."];
    blockedPatch.unansweredQuestions = ["Which runtime is pinned for the executor?"];
    blockedPatch.openItemDispositions = [
      {
        kind: ReviewOpenItemKind.BLOCKING_REASON,
        text: "The executor must verify the runtime before implementation.",
        owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
        rationale: "The executor can verify the runtime immediately before implementation.",
      },
      {
        kind: ReviewOpenItemKind.UNANSWERED_QUESTION,
        text: "Which runtime is pinned for the executor?",
        owner: ReviewOpenItemOwner.EXECUTOR_PREFLIGHT,
        rationale: "The executor can verify the runtime immediately before implementation.",
      },
    ];
    database
      .prepare(
        `UPDATE mastermind_reviews
         SET patch_json = ?, validation_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(blockedPatch),
        JSON.stringify({
          accepted: true,
          requiresHumanApproval: false,
          reasons: [],
        }),
        new Date().toISOString(),
        reviewRow.id,
      );
    database
      .prepare(
        `UPDATE mastermind_work_items
         SET state = ?, planned_action = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(MastermindState.DECIDING, new Date().toISOString(), delivery.workId);
    database.close();

    const rerouteLoop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new WaitForBlockedPreflightDecisionProvider(),
      new FakeReviewHarness(),
    );

    await rerouteLoop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.NEEDS_HUMAN,
      plannedAction: undefined,
    });
    expect(await store.listEvents(delivery.workId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: MastermindEventType.REQUIRE_HUMAN,
          metadata: expect.objectContaining({
            decision: expect.objectContaining({
              action: MastermindAction.WAIT,
            }),
            decisionOverride: expect.objectContaining({
              originalAction: MastermindAction.WAIT,
              overriddenAction: MastermindAction.NEEDS_HUMAN,
            }),
          }),
        }),
      ]),
    );
    store.close();
  });

  it("invalidates a stale patch after a human edit and regenerates from current content", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174003",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new FakeLinearGateway();
    const harness = new StaleOnceReviewHarness(linear);
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new FakeDecisionProvider(),
      harness,
    );

    await loop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
    });
    expect(harness.reviewCalls).toBe(2);
    expect((await store.listEvents(delivery.workId)).map((event) => event.eventType)).toContain(
      "review.invalidated",
    );
    store.close();
  });

  it("reopens a completed review when a later human edit makes it stale", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174007",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new FakeLinearGateway();
    const harness = new FakeReviewHarness();
    const progress: string[] = [];
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new FakeDecisionProvider(),
      harness,
      (message) => progress.push(message),
    );
    await loop.process(delivery.workId);

    linear.issue.description = "Human added a new implementation constraint.";
    progress.length = 0;
    await loop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
    });
    expect(harness.reviewCalls).toBe(2);
    expect((await store.listEvents(delivery.workId)).map((event) => event.eventType)).toContain(
      MastermindEventType.REOPEN_REVIEW,
    );
    expect(progress[0]).toBe(
      [
        "Pulled Linear ticket WK-1 — Implement durable Mastermind intake",
        "URL: https://linear.app/weavekit/issue/WK-1/rough-title",
        `Reason: Work item ${delivery.workId} is action_planned. Mastermind is verifying that the completed review and "Mastermind Reviewed" label still match Linear before reusing the planned action.`,
        "Next: Reopen review because the Linear ticket content changed after the stored review was applied; invalidate the stored review, clear Mastermind labels, and generate a fresh review.",
      ].join("\n"),
    );
    store.close();
  });

  it("re-reviews legacy stored reviews that are missing open-item dispositions", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174027",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new FakeLinearGateway();
    const decisions = new ExternalDependencyDecisionProvider();
    const initialLoop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      decisions,
      new FakeReviewHarness(),
    );

    await initialLoop.process(delivery.workId);
    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
      plannedAction: MastermindAction.WAIT,
    });

    const database = new DatabaseSync(path);
    const reviewRow = database
      .prepare(
        `SELECT id, patch_json
         FROM mastermind_reviews
         WHERE work_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(delivery.workId) as { id: string; patch_json: string };
    const legacyPatch = JSON.parse(reviewRow.patch_json) as Record<string, unknown>;
    delete legacyPatch.openItemDispositions;
    database
      .prepare(
        `UPDATE mastermind_reviews
         SET patch_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(legacyPatch), new Date().toISOString(), reviewRow.id);
    database
      .prepare(
        `UPDATE mastermind_work_items
         SET state = ?, planned_action = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(MastermindState.DECIDING, new Date().toISOString(), delivery.workId);
    database.close();
    store.close();

    const restartedStore = new SqliteMastermindStore(path);
    await restartedStore.initialize();
    const harness = new FakeReviewHarness();
    const progress: string[] = [];
    const restartedLoop = new MastermindDecisionLoop(
      createConfig(path),
      restartedStore,
      linear,
      new ExternalDependencyDecisionProvider(),
      harness,
      (message) => progress.push(message),
    );

    await expect(restartedLoop.process(delivery.workId)).resolves.toBeUndefined();

    expect(harness.reviewCalls).toBe(1);
    expect(await restartedStore.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
      plannedAction: MastermindAction.WAIT,
    });
    expect(progress).toEqual(
      expect.arrayContaining([
        "Selecting the next action for the reviewed ticket.",
        "Frontier harness is inspecting repository evidence.",
      ]),
    );
    expect(await restartedStore.listEvents(delivery.workId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: MastermindEventType.REVIEW,
          metadata: expect.objectContaining({
            deterministicRouting: expect.objectContaining({
              action: MastermindAction.REVIEW_TICKET,
              reason:
                "the stored review predates open-item ownership for unanswered or blocking items",
            }),
          }),
        }),
      ]),
    );
    restartedStore.close();
  });

  it("fails closed and labels the ticket when harness evidence is invalid", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174004",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });

    const linear = new FakeLinearGateway();
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new FakeDecisionProvider(),
      new InvalidEvidenceReviewHarness(),
    );

    await loop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.FAILED,
    });
    expect(linear.issue.title).toBe("rough title");
    expect(linear.issue.labels.map((label) => label.name)).toContain("Mastermind Review Failed");
    expect(await store.listEvents(delivery.workId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "FAIL",
          metadata: expect.objectContaining({
            reviewFailureReasons: [
              "Repository evidence repo-package path does not exist: missing-file.ts.",
            ],
          }),
        }),
      ]),
    );
    await expect(resolveMastermindFailureReasons(store, delivery.workId)).resolves.toEqual([
      "Repository evidence repo-package path does not exist: missing-file.ts.",
    ]);
    store.close();
  });

  it("accepts structured negative-search evidence in an existing repository", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174021",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      new FakeLinearGateway(),
      new FakeDecisionProvider(),
      new SearchEvidenceReviewHarness(),
    );

    await loop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
    });
    store.close();
  });

  it("reviews a greenfield prototype without creating a child project directory", async () => {
    const { store, path } = await createStore();
    const provisioningRoot = join(path, "..", "prototypes");
    await mkdir(provisioningRoot);
    const config = createConfig(path);
    config.projects.prototypes = {
      ...config.projects.weavekit!,
      id: "prototypes",
      displayName: "Prototypes",
      workingTree: provisioningRoot,
      repositoryMode: ConfigProjectRepositoryMode.GREENFIELD,
      provisioningRoot,
    };
    config.mastermind.projectMappings = [
      {
        teamId: "team-one",
        linearProjectId: "project-one",
        projectId: "prototypes",
      },
    ];
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174022",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const loop = new MastermindDecisionLoop(
      config,
      store,
      new FakeLinearGateway(),
      new FakeDecisionProvider(),
      new GreenfieldReviewHarness(),
    );

    await loop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.ACTION_PLANNED,
    });
    expect(await readdir(provisioningRoot)).toEqual([]);
    store.close();
  });

  it("records a harness failure and applies the review-failed label", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174006",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new FakeLinearGateway();
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new FakeDecisionProvider(),
      new FailingReviewHarness(),
    );

    await loop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.FAILED,
    });
    expect(linear.issue.labels.map((label) => label.name)).toContain("Mastermind Review Failed");
    expect(await store.listEvents(delivery.workId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "FAIL",
          metadata: expect.objectContaining({
            reviewError: "Frontier harness unavailable.",
          }),
        }),
      ]),
    );
    await expect(resolveMastermindFailureReasons(store, delivery.workId)).resolves.toEqual([
      "Frontier harness unavailable.",
    ]);
    store.close();
  });

  it("keeps failed work without a stored review terminal until a real retry condition appears", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174032",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new FakeLinearGateway();
    const initialLoop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new FakeDecisionProvider(),
      new FailingReviewHarness(),
    );

    await initialLoop.process(delivery.workId);
    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.FAILED,
    });

    const progress: string[] = [];
    const retryHarness = new FakeReviewHarness();
    const retryLoop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new FakeDecisionProvider(),
      retryHarness,
      (message) => progress.push(message),
    );

    await retryLoop.process(delivery.workId);

    expect(retryHarness.reviewCalls).toBe(0);
    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.FAILED,
    });
    expect((await store.listEvents(delivery.workId)).map((event) => event.eventType)).not.toContain(
      MastermindEventType.REOPEN_REVIEW,
    );
    expect(progress[0]).toBe(
      [
        "Pulled Linear ticket WK-1 — rough title",
        "URL: https://linear.app/weavekit/issue/WK-1/rough-title",
        `Reason: Work item ${delivery.workId} is failed. Mastermind is checking for ticket edits or removal of the "Mastermind Review Failed" label before deciding whether the failed review should be retried.`,
        "Next: The ticket has not changed; keep failed and wait for an explicit retry condition.",
      ].join("\n"),
    );
    store.close();
  });

  it("routes blocked patches to human input without rewriting ticket content", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174005",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new FakeLinearGateway();
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new BlockedDecisionProvider(),
      new FakeReviewHarness(),
    );

    await loop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.NEEDS_HUMAN,
    });
    expect(linear.issue.title).toBe("rough title");
    expect(linear.issue.labels.map((label) => label.name)).toContain("Mastermind Needs Input");
    store.close();
  });

  it("posts the clarification comment on the same run that routes a review to human input", async () => {
    const { store, path } = await createStore();
    const delivery = await store.ingestDelivery({
      deliveryId: "123e4567-e89b-42d3-a456-426614174045",
      organizationId: "organization-one",
      eventType: "Issue",
      action: "create",
      issueId: "issue-one",
    });
    const linear = new CommentRecordingLinearGateway();
    const loop = new MastermindDecisionLoop(
      createConfig(path),
      store,
      linear,
      new BlockedDecisionProvider(),
      new FakeReviewHarness(),
    );

    await loop.process(delivery.workId);

    expect(await store.getWork(delivery.workId)).toMatchObject({
      state: MastermindState.NEEDS_HUMAN,
    });
    // The open items must reach Linear on this run, not only on a later self-healing run.
    expect(linear.comments).toHaveLength(1);
    const [comment] = linear.comments;
    expect(comment.body).toContain(`<!-- weavekit-mastermind-clarification:${delivery.workId} -->`);
    expect(comment.body).toContain("Which compatibility policy is required?");
    expect(comment.body).toContain("Product owner must choose the compatibility policy.");

    // Re-processing the same needs-human work item updates the existing comment instead of
    // posting a duplicate.
    await loop.process(delivery.workId);
    expect(linear.comments).toHaveLength(1);
    store.close();
  });

  it("uses the Linear GraphQL issue and mutation contracts", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);
      if (String(request.query).includes("query MastermindIssue")) {
        return Response.json({
          data: {
            issue: {
              id: "issue-one",
              identifier: "WK-1",
              url: "https://linear.app/weavekit/issue/WK-1/title",
              title: "Title",
              description: "Description",
              team: { id: "team-one" },
              project: { id: "project-one" },
              state: { name: "Todo" },
              labels: { nodes: [{ id: "existing", name: "Existing" }] },
            },
          },
        });
      }
      return Response.json({ data: { issueUpdate: { success: true } } });
    };
    const gateway = new LinearGraphQlGateway("test-key", "https://linear.test/graphql", fetcher);

    await expect(gateway.fetchIssue("issue-one")).resolves.toMatchObject({
      id: "issue-one",
      url: "https://linear.app/weavekit/issue/WK-1/title",
      teamId: "team-one",
      projectId: "project-one",
    });
    await gateway.updateIssueContent("issue-one", {
      title: "Rewritten",
      description: "Rewritten description",
    });
    await gateway.replaceIssueLabels("issue-one", {
      remove: [],
      add: ["reviewed-label-id"],
    });

    expect(requests).toHaveLength(4);
    expect(requests[1]?.variables).toEqual({
      id: "issue-one",
      title: "Rewritten",
      description: "Rewritten description",
    });
    expect(requests[3]?.variables).toEqual({
      id: "issue-one",
      labelIds: ["existing", "reviewed-label-id"],
    });
  });
});
