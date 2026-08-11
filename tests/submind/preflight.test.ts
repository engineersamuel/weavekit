import { describe, expect, it, vi } from "vitest";
import {
  ExecutionPreflightKind,
  createDirectExecutionRequest,
  ExecutorKind,
  runExecutionPreflight,
  startDirectExecutionWithPreflight,
  type ExecutionCommandRunner,
  type ExecutionPreflightReport,
  type DirectExecutionRequest,
  type DirectExecutor,
} from "../../src/submind/index.js";

const workspace = {
  kind: "existing-repository-worktree" as const,
  sourceRepositoryPath: "/tmp/source",
  checkoutPath: "/tmp/prototypes",
  branchName: "mastermind/wk-1-work-one",
  parentWorkspaceLookupPath: "/tmp/source",
  creatorAttemptId: "attempt-one",
};

const request = {
  workId: "work-one",
  attemptId: "attempt-one",
  attemptNumber: 1,
  objective: "Deploy the Azure prototype.",
  projectId: "prototypes",
  ticket: {} as DirectExecutionRequest["ticket"],
  review: {} as DirectExecutionRequest["review"],
  decision: {} as DirectExecutionRequest["decision"],
  workspace,
  validationCommands: [],
  preflightRequirements: [
    {
      kind: ExecutionPreflightKind.AZURE_CLI,
      subscriptionId: "subscription-one",
      tenantId: "tenant-one",
    },
  ],
  resultManifestPath: ".weavekit/mastermind-result.json",
  allowedPullRequestHosts: [],
} satisfies DirectExecutionRequest;

describe("Submind execution preflight", () => {
  it("derives executor requirements from authoritative project configuration", () => {
    const derived = createDirectExecutionRequest(
      {
        workId: "work-one",
        attemptId: "attempt-one",
        attemptNumber: 1,
        objective: "Deploy the Azure prototype.",
        ticket: request.ticket,
        review: request.review,
        decision: request.decision,
        workspace,
      },
      {
        id: "prototypes",
        displayName: "Prototypes",
        workingTree: "/tmp/prototypes",
        mainline: "origin main",
        remote: "origin",
        contextDocs: [],
        validationCommands: ["nub run test"],
        executionPreflightRequirements: request.preflightRequirements,
        autonomousPrAllowed: false,
        notification: "cli",
        knowledgeExport: "off",
      },
    );

    expect(derived).toEqual({
      ...request,
      validationCommands: ["nub run test"],
    });
    expect(derived.preflightRequirements).not.toBe(request.preflightRequirements);
  });

  it("accepts an authenticated Azure CLI on the required subscription", async () => {
    const runner: ExecutionCommandRunner = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          id: "subscription-one",
          tenantId: "tenant-one",
        }),
        stderr: "",
      }),
    };

    await expect(
      runExecutionPreflight({
        requirements: request.preflightRequirements,
        workspacePath: request.workspace.checkoutPath,
        runner,
        now: new Date("2026-08-05T18:00:00.000Z"),
      }),
    ).resolves.toEqual({
      accepted: true,
      checkedAt: "2026-08-05T18:00:00.000Z",
      checks: [
        {
          kind: ExecutionPreflightKind.AZURE_CLI,
          accepted: true,
          summary: "Azure CLI is authenticated and pinned to the required subscription.",
          context: {
            subscriptionId: "subscription-one",
            tenantId: "tenant-one",
          },
        },
      ],
    });
    expect(runner.run).toHaveBeenCalledWith(
      "az",
      ["account", "show", "--output", "json"],
      "/tmp/prototypes",
    );
  });

  it("fails closed when Azure CLI is pinned to the wrong subscription", async () => {
    const runner: ExecutionCommandRunner = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          id: "wrong-subscription",
          tenantId: "tenant-one",
        }),
        stderr: "",
      }),
    };

    const report = await runExecutionPreflight({
      requirements: request.preflightRequirements,
      workspacePath: request.workspace.checkoutPath,
      runner,
    });

    expect(report).toMatchObject({
      accepted: false,
      checks: [
        {
          accepted: false,
          context: {
            expectedSubscriptionId: "subscription-one",
            actualSubscriptionId: "wrong-subscription",
          },
        },
      ],
    });
  });

  it("fails closed when Azure CLI is pinned to the wrong tenant", async () => {
    const runner: ExecutionCommandRunner = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          id: "subscription-one",
          tenantId: "wrong-tenant",
        }),
        stderr: "",
      }),
    };

    const report = await runExecutionPreflight({
      requirements: request.preflightRequirements,
      workspacePath: request.workspace.checkoutPath,
      runner,
    });

    expect(report).toMatchObject({
      accepted: false,
      checks: [
        {
          accepted: false,
          context: {
            expectedTenantId: "tenant-one",
            actualTenantId: "wrong-tenant",
          },
        },
      ],
    });
  });

  it.each([
    {
      name: "Azure CLI is missing",
      result: {
        exitCode: null,
        stdout: "",
        stderr: "",
        errorCode: "ENOENT",
      },
      summary: "Azure CLI is not installed or not available on PATH.",
    },
    {
      name: "Azure CLI is unauthenticated",
      result: {
        exitCode: 1,
        stdout: "",
        stderr: "Please run 'az login' to setup account.",
      },
      summary: "Azure CLI is not authenticated.",
    },
    {
      name: "Azure CLI returns invalid JSON",
      result: {
        exitCode: 0,
        stdout: "not-json",
        stderr: "",
      },
      summary: "Azure CLI returned invalid account data.",
    },
  ])("fails closed when $name", async ({ result, summary }) => {
    const runner: ExecutionCommandRunner = {
      run: vi.fn().mockResolvedValue(result),
    };

    const report = await runExecutionPreflight({
      requirements: request.preflightRequirements,
      workspacePath: request.workspace.checkoutPath,
      runner,
    });

    expect(report).toMatchObject({
      accepted: false,
      checks: [{ accepted: false, summary }],
    });
  });

  it("passes an opaque successful preflight approval to the executor", async () => {
    const successfulReport: ExecutionPreflightReport = {
      accepted: true,
      checkedAt: "2026-08-05T18:00:00.000Z",
      checks: [],
    };
    const handle = {
      executor: ExecutorKind.HERDR_COPILOT,
      agentName: "mm-workone-a1",
      worktreePath: request.workspace.checkoutPath,
    };
    const start = vi.fn().mockResolvedValue(handle);
    const executor: DirectExecutor = {
      preflight: vi.fn().mockResolvedValue(successfulReport),
      start,
      status: vi.fn(),
      cancel: vi.fn(),
      collect: vi.fn(),
    };

    await expect(startDirectExecutionWithPreflight(executor, request)).resolves.toBe(handle);
    expect(start).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ report: successfulReport }),
    );
  });

  it("does not start a Submind when executor preflight fails", async () => {
    const failedReport: ExecutionPreflightReport = {
      accepted: false,
      checkedAt: "2026-08-05T18:00:00.000Z",
      checks: [
        {
          kind: ExecutionPreflightKind.AZURE_CLI,
          accepted: false,
          summary: "Azure CLI is unauthenticated.",
        },
      ],
    };
    const start = vi.fn();
    const executor: DirectExecutor = {
      preflight: vi.fn().mockResolvedValue(failedReport),
      start,
      status: vi.fn(),
      cancel: vi.fn(),
      collect: vi.fn(),
    };

    await expect(startDirectExecutionWithPreflight(executor, request)).rejects.toThrow(
      "Execution preflight failed: Azure CLI is unauthenticated.",
    );
    expect(start).not.toHaveBeenCalled();
  });
});
