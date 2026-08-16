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
import type { LangfuseTraceFetcher } from "../../src/mastermind/selfImprovement/langfuseClient.js";
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
    const traceFetcher: LangfuseTraceFetcher = { fetchSubmindTraceSummary: vi.fn() };
    const decisions = { analyzeSubmindTrace: vi.fn() };
    const store = { getLatestTicketSnapshot: vi.fn() };
    const linear = {} as LinearGateway;
    const coordinator = new SelfImprovementCoordinator(
      makeConfig({ enabled: false }),
      store,
      linear,
      traceFetcher,
      decisions,
    );

    await coordinator.process(makeWork(MastermindState.COMPLETED), makeAttempt());

    expect(traceFetcher.fetchSubmindTraceSummary).not.toHaveBeenCalled();
  });

  it("skips when the work item is not in an analyzable terminal state", async () => {
    const traceFetcher: LangfuseTraceFetcher = { fetchSubmindTraceSummary: vi.fn() };
    const decisions = { analyzeSubmindTrace: vi.fn() };
    const store = { getLatestTicketSnapshot: vi.fn() };
    const linear = {} as LinearGateway;
    const coordinator = new SelfImprovementCoordinator(
      makeConfig(),
      store,
      linear,
      traceFetcher,
      decisions,
    );

    await coordinator.process(makeWork(MastermindState.RUNNING), makeAttempt());

    expect(traceFetcher.fetchSubmindTraceSummary).not.toHaveBeenCalled();
  });

  it("skips when the attempt has no Submind trace reference", async () => {
    const traceFetcher: LangfuseTraceFetcher = { fetchSubmindTraceSummary: vi.fn() };
    const decisions = { analyzeSubmindTrace: vi.fn() };
    const store = { getLatestTicketSnapshot: vi.fn() };
    const linear = {} as LinearGateway;
    const coordinator = new SelfImprovementCoordinator(
      makeConfig(),
      store,
      linear,
      traceFetcher,
      decisions,
    );

    await coordinator.process(
      makeWork(MastermindState.COMPLETED),
      makeAttempt({ result: {} as ExecutionAttempt["result"] }),
    );

    expect(traceFetcher.fetchSubmindTraceSummary).not.toHaveBeenCalled();
  });

  it("filters findings below the configured minimum severity and files one issue per surviving finding", async () => {
    const traceFetcher: LangfuseTraceFetcher = {
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
      traceFetcher,
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
    const traceFetcher: LangfuseTraceFetcher = {
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
      traceFetcher,
      decisions,
    );

    await coordinator.process(makeWork(MastermindState.COMPLETED), makeAttempt());

    expect(linear.createIssue).not.toHaveBeenCalled();
    expect(linear.createIssueComment).not.toHaveBeenCalled();
  });

  it("never throws when Langfuse fetch fails", async () => {
    const traceFetcher: LangfuseTraceFetcher = {
      fetchSubmindTraceSummary: vi.fn().mockRejectedValue(new Error("langfuse down")),
    };
    const decisions = { analyzeSubmindTrace: vi.fn() };
    const store = { getLatestTicketSnapshot: vi.fn() };
    const linear = {} as LinearGateway;
    const coordinator = new SelfImprovementCoordinator(
      makeConfig(),
      store,
      linear,
      traceFetcher,
      decisions,
    );

    await expect(
      coordinator.process(makeWork(MastermindState.COMPLETED), makeAttempt()),
    ).resolves.toBeUndefined();
  });

  it("never throws when the BAML analysis call fails", async () => {
    const traceFetcher: LangfuseTraceFetcher = {
      fetchSubmindTraceSummary: vi.fn().mockResolvedValue(traceSummary),
    };
    const decisions = { analyzeSubmindTrace: vi.fn().mockRejectedValue(new Error("baml failed")) };
    const store = { getLatestTicketSnapshot: vi.fn().mockResolvedValue(ticketSnapshot) };
    const linear = {} as LinearGateway;
    const coordinator = new SelfImprovementCoordinator(
      makeConfig(),
      store,
      linear,
      traceFetcher,
      decisions,
    );

    await expect(
      coordinator.process(makeWork(MastermindState.COMPLETED), makeAttempt()),
    ).resolves.toBeUndefined();
  });

  it("never throws when Linear rejects createIssue", async () => {
    const traceFetcher: LangfuseTraceFetcher = {
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
      traceFetcher,
      decisions,
    );

    await expect(
      coordinator.process(makeWork(MastermindState.COMPLETED), makeAttempt()),
    ).resolves.toBeUndefined();
  });
});
