import { describe, expect, it, vi } from "vitest";
import {
  attachMastermindExecution,
  type ExecutionAttachmentTarget,
} from "../../src/mastermind/index.js";
import { MastermindAction, MastermindState } from "../../src/mastermind/domain/events.js";
import { ExecutorKind } from "../../src/submind/index.js";

describe("Mastermind execution attachment", () => {
  it("focuses the deterministic agent when already inside Herdr", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0 });

    const result = await attachMastermindExecution({
      selector: "ENG-5",
      store: attachmentStore(),
      herdrEnv: "1",
      run,
    });

    expect(result.ticketIdentifier).toBe("ENG-5");
    expect(run).toHaveBeenCalledWith("herdr", ["agent", "focus", "mm-43806f78fe214f81b2-a4"]);
  });

  it("attaches directly when invoked outside Herdr", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0 });

    await attachMastermindExecution({
      selector: "43806f78-fe21-4f81-b273-a33edd3194c2",
      store: attachmentStore(),
      herdrEnv: undefined,
      run,
    });

    expect(run).toHaveBeenCalledWith("herdr", ["agent", "attach", "mm-43806f78fe214f81b2-a4"]);
  });

  it("fails clearly when no execution or agent handle exists", async () => {
    await expect(
      attachMastermindExecution({
        selector: "UNKNOWN-1",
        store: { findExecutionAttachment: vi.fn().mockResolvedValue(undefined) },
        herdrEnv: "1",
        run: vi.fn(),
      }),
    ).rejects.toThrow("No Mastermind execution found");
    await expect(
      attachMastermindExecution({
        selector: "ENG-5",
        store: attachmentStore({ executorHandle: undefined }),
        herdrEnv: "1",
        run: vi.fn(),
      }),
    ).rejects.toThrow("has no Herdr agent handle");
  });
});

function attachmentStore(attemptOverrides: Partial<ExecutionAttachmentTarget["attempt"]> = {}): {
  findExecutionAttachment: () => Promise<ExecutionAttachmentTarget>;
} {
  return {
    async findExecutionAttachment() {
      return {
        workId: "43806f78-fe21-4f81-b273-a33edd3194c2",
        issueId: "issue-one",
        ticketIdentifier: "ENG-5",
        attempt: {
          id: "attempt-four",
          workId: "43806f78-fe21-4f81-b273-a33edd3194c2",
          attemptNumber: 4,
          action: MastermindAction.IMPLEMENT_DIRECTLY,
          projectPolicyId: "prototypes",
          projectPolicyVersion: "version-one",
          executorKind: ExecutorKind.HERDR_COPILOT,
          state: MastermindState.SUCCEEDED,
          executorHandle: {
            executor: ExecutorKind.HERDR_COPILOT,
            agentName: "mm-43806f78fe214f81b2-a4",
            worktreePath: "/tmp/eng-5",
          },
          retryEligible: false,
          rowVersion: 1,
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
          ...attemptOverrides,
        },
      };
    },
  };
}
