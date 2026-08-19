import { describe, expect, it, vi } from "vitest";
import type {
  SelfImprovementReport,
  SubmindTraceSummary,
} from "../../src/generated/baml_client/index.js";
import type { WeavekitConfig } from "../../src/config.js";
import { MastermindAction } from "../../src/mastermind/domain/events.js";
import { MastermindState } from "../../src/mastermind/domain/events.js";
import type { LinearGateway } from "../../src/mastermind/linear/client.js";
import { SelfImprovementCoordinator } from "../../src/mastermind/selfImprovement/coordinator.js";
import type { SubmindTraceSource } from "../../src/mastermind/selfImprovement/traceSource.js";
import type {
  ExecutionAttempt,
  LinearTicketSnapshot,
  MastermindWorkItem,
} from "../../src/mastermind/store/store.js";

function makeConfig(
  overrides: Partial<NonNullable<WeavekitConfig["mastermind"]["selfImprovement"]>> = {},
) {
  return {
    mastermind: {
      selfImprovement: {
        enabled: true,
        targetTeamId: "team-weavekit",
        minSeverity: "IMPORTANT" as const,
        ...overrides,
      },
    },
  } as unknown as WeavekitConfig;
}

function makeWork(state: MastermindState): MastermindWorkItem {
  return {
    id: "work-1",
    organizationId: "org-1",
    issueId: "issue-1",
    state,
  } as unknown as MastermindWorkItem;
}

function makeAttempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return {
    id: "attempt-1",
    workId: "work-1",
    attemptNumber: 1,
    action: MastermindAction.DELEGATE_SUBMIND,
    projectPolicyId: "policy-1",
    projectPolicyVersion: "1",
    executorKind: "rlm",
    state: MastermindState.SUCCEEDED,
    retryEligible: false,
    rowVersion: 1,
    createdAt: "now",
    updatedAt: "now",
    result: {
      submindTrace: {
        traceId: "trace-1",
        conversationId: "conv-1",
        url: "https://langfuse/trace-1",
      },
      runRecord: {
        schemaVersion: 1,
        runId: "run-1",
        calls: [
          {
            callId: "run-1:call-1",
            callNumber: 1,
            profile: "general",
            depthUsed: 1,
            status: "succeeded",
            model: "gpt-5.6-sol",
            startedAt: "2026-08-13T12:00:00.000Z",
            completedAt: "2026-08-13T12:00:10.000Z",
            summary: "Did the work.",
          },
        ],
      },
    },
    ...overrides,
  } as unknown as ExecutionAttempt;
}

const ticketSnapshot: LinearTicketSnapshot = {
  id: "issue-1",
  identifier: "ENG-10",
  url: "https://linear.app/issue-1",
  title: "Do the thing",
  description: "Do the thing well.",
  labels: [],
  status: "In Progress",
  teamId: "team-eng",
};

const traceSummary: SubmindTraceSummary = {
  traceId: "trace-1",
  url: "https://langfuse/trace-1",
  rootInput: "in",
  rootOutput: "out",
  observations: [],
};

function makeReport(findings: SelfImprovementReport["findings"]): SelfImprovementReport {
  return { summary: "analysis", findings };
}

describe("SelfImprovementCoordinator", () => {
  it("skips when the feature is disabled", async () => {
    const traceSource: SubmindTraceSource = { fetchSubmindTraceSummary: vi.fn() };
    const decisions = { analyzeSubmindTrace: vi.fn() };
    const store = { getLatestTicketSnapshot: vi.fn() };
    const linear = {} as LinearGateway;
    const coordinator = new SelfImprovementCoordinator(
      makeConfig({ enabled: false }),
      store,
      linear,
      traceSource,
      decisions,
    );

    await coordinator.process(makeWork(MastermindState.COMPLETED), makeAttempt());

    expect(traceSource.fetchSubmindTraceSummary).not.toHaveBeenCalled();
  });

  it("skips when the work item is not in an analyzable terminal state", async () => {
    const traceSource: SubmindTraceSource = { fetchSubmindTraceSummary: vi.fn() };
    const decisions = { analyzeSubmindTrace: vi.fn() };
    const store = { getLatestTicketSnapshot: vi.fn() };
    const linear = {} as LinearGateway;
    const coordinator = new SelfImprovementCoordinator(
      makeConfig(),
      store,
      linear,
      traceSource,
      decisions,
    );

    await coordinator.process(makeWork(MastermindState.RUNNING), makeAttempt());

    expect(traceSource.fetchSubmindTraceSummary).not.toHaveBeenCalled();
  });

  it("skips when the attempt has no captured Submind run record", async () => {
    const traceSource: SubmindTraceSource = { fetchSubmindTraceSummary: vi.fn() };
    const decisions = { analyzeSubmindTrace: vi.fn() };
    const store = { getLatestTicketSnapshot: vi.fn() };
    const linear = {} as LinearGateway;
    const coordinator = new SelfImprovementCoordinator(
      makeConfig(),
      store,
      linear,
      traceSource,
      decisions,
    );

    await coordinator.process(
      makeWork(MastermindState.COMPLETED),
      makeAttempt({ result: {} as ExecutionAttempt["result"] }),
    );

    expect(traceSource.fetchSubmindTraceSummary).not.toHaveBeenCalled();
  });

  it("filters findings below the configured minimum severity and files one issue per surviving finding", async () => {
    const traceSource: SubmindTraceSource = {
      fetchSubmindTraceSummary: vi.fn().mockResolvedValue(traceSummary),
    };
    const decisions = {
      analyzeSubmindTrace: vi.fn().mockResolvedValue(
        makeReport([
          {
            severity: "SUGGESTION",
            category: "OTHER",
            title: "Minor nit",
            description: "d",
            evidence: [],
            suggestedTicketBody: "b",
          },
          {
            severity: "BLOCKING",
            category: "MISSION_DEVIATION",
            title: "Deviated from mission",
            description: "d",
            evidence: [],
            suggestedTicketBody: "b",
          },
        ]),
      ),
    };
    const store = { getLatestTicketSnapshot: vi.fn().mockResolvedValue(ticketSnapshot) };
    const linear: LinearGateway = {
      findIssueCommentByMarker: vi.fn().mockResolvedValue(undefined),
      createIssueComment: vi.fn().mockResolvedValue("comment-1"),
      createIssue: vi
        .fn()
        .mockResolvedValue({ id: "iss-1", identifier: "WEAVE-1", url: "https://linear.app/iss-1" }),
    } as unknown as LinearGateway;
    const coordinator = new SelfImprovementCoordinator(
      makeConfig(),
      store,
      linear,
      traceSource,
      decisions,
    );

    await coordinator.process(makeWork(MastermindState.COMPLETED), makeAttempt());

    expect(linear.createIssue).toHaveBeenCalledTimes(1);
    expect((linear.createIssue as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      teamId: "team-weavekit",
      title: expect.stringContaining("Deviated from mission"),
    });
  });

  it("is idempotent: skips filing entirely if the attempt marker already exists", async () => {
    const traceSource: SubmindTraceSource = {
      fetchSubmindTraceSummary: vi.fn().mockResolvedValue(traceSummary),
    };
    const decisions = {
      analyzeSubmindTrace: vi.fn().mockResolvedValue(
        makeReport([
          {
            severity: "BLOCKING",
            category: "ERROR_OR_RETRY",
            title: "Retried unnecessarily",
            description: "d",
            evidence: [],
            suggestedTicketBody: "b",
          },
        ]),
      ),
    };
    const store = { getLatestTicketSnapshot: vi.fn().mockResolvedValue(ticketSnapshot) };
    const linear: LinearGateway = {
      findIssueCommentByMarker: vi.fn().mockResolvedValue("existing-comment-id"),
      createIssueComment: vi.fn(),
      createIssue: vi.fn(),
    } as unknown as LinearGateway;
    const coordinator = new SelfImprovementCoordinator(
      makeConfig(),
      store,
      linear,
      traceSource,
      decisions,
    );

    await coordinator.process(makeWork(MastermindState.COMPLETED), makeAttempt());

    expect(linear.createIssue).not.toHaveBeenCalled();
    expect(linear.createIssueComment).not.toHaveBeenCalled();
  });

  it("never throws when reading the run record fails", async () => {
    const traceSource: SubmindTraceSource = {
      fetchSubmindTraceSummary: vi.fn().mockRejectedValue(new Error("run record unreadable")),
    };
    const decisions = { analyzeSubmindTrace: vi.fn() };
    const store = { getLatestTicketSnapshot: vi.fn() };
    const linear = {} as LinearGateway;
    const coordinator = new SelfImprovementCoordinator(
      makeConfig(),
      store,
      linear,
      traceSource,
      decisions,
    );

    await expect(
      coordinator.process(makeWork(MastermindState.COMPLETED), makeAttempt()),
    ).resolves.toBeUndefined();
  });

  it("never throws when the BAML analysis call fails", async () => {
    const traceSource: SubmindTraceSource = {
      fetchSubmindTraceSummary: vi.fn().mockResolvedValue(traceSummary),
    };
    const decisions = { analyzeSubmindTrace: vi.fn().mockRejectedValue(new Error("baml failed")) };
    const store = { getLatestTicketSnapshot: vi.fn().mockResolvedValue(ticketSnapshot) };
    const linear = {} as LinearGateway;
    const coordinator = new SelfImprovementCoordinator(
      makeConfig(),
      store,
      linear,
      traceSource,
      decisions,
    );

    await expect(
      coordinator.process(makeWork(MastermindState.COMPLETED), makeAttempt()),
    ).resolves.toBeUndefined();
  });

  it("never throws when Linear rejects createIssue", async () => {
    const traceSource: SubmindTraceSource = {
      fetchSubmindTraceSummary: vi.fn().mockResolvedValue(traceSummary),
    };
    const decisions = {
      analyzeSubmindTrace: vi.fn().mockResolvedValue(
        makeReport([
          {
            severity: "BLOCKING",
            category: "OTHER",
            title: "Something",
            description: "d",
            evidence: [],
            suggestedTicketBody: "b",
          },
        ]),
      ),
    };
    const store = { getLatestTicketSnapshot: vi.fn().mockResolvedValue(ticketSnapshot) };
    const linear: LinearGateway = {
      findIssueCommentByMarker: vi.fn().mockResolvedValue(undefined),
      createIssueComment: vi.fn().mockResolvedValue("comment-1"),
      createIssue: vi.fn().mockRejectedValue(new Error("linear rejected")),
    } as unknown as LinearGateway;
    const coordinator = new SelfImprovementCoordinator(
      makeConfig(),
      store,
      linear,
      traceSource,
      decisions,
    );

    await expect(
      coordinator.process(makeWork(MastermindState.COMPLETED), makeAttempt()),
    ).resolves.toBeUndefined();
  });
});
