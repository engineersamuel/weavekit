import { describe, expect, it, vi } from "vitest";
import type { ApiProvider, EvaluateSummaryV3, EvaluateTestSuite } from "promptfoo";
import { runPersistedPromptfooEvaluation } from "../../src/eval/promptfooRunner.js";

const provider: ApiProvider = {
  id: () => "test-provider",
  callApi: async () => ({ output: "test output" }),
};

const suite: EvaluateTestSuite = {
  providers: [provider],
  prompts: ["{{prompt}}"],
  tests: [],
};

const description = "source-to-project todo trial 1 generation";
const tags = {
  workflow: "source-to-project" as const,
  phase: "generation" as const,
  runId: "run-1",
  caseId: "todo-safe-write-path",
  trial: "1",
};

const summary = {
  version: 3,
  timestamp: "2026-07-11T12:00:00.000Z",
  results: [],
  prompts: [],
  stats: {
    successes: 1,
    failures: 0,
    errors: 0,
    tokenUsage: {
      prompt: 0,
      completion: 0,
      cached: 0,
      total: 0,
      numRequests: 0,
      completionDetails: {},
      assertions: {},
    },
  },
} satisfies EvaluateSummaryV3;

describe("runPersistedPromptfooEvaluation", () => {
  it("uses the returned evaluation record constructor to verify persistence by default", async () => {
    class FakeEvaluationRecord {
      static findById = vi.fn(async () => ({ id: "eval-generation-1" }));
      id = "eval-generation-1";
      resultPersistenceFailed = false;

      async toEvaluateSummary() {
        return summary;
      }
    }
    const evaluateFn = vi.fn(async () => new FakeEvaluationRecord());

    const result = await runPersistedPromptfooEvaluation(
      { suite, description, tags },
      { evaluateFn: evaluateFn as never },
    );

    expect(FakeEvaluationRecord.findById).toHaveBeenCalledWith("eval-generation-1");
    expect(result).toEqual({ evaluationId: "eval-generation-1", summary });
  });

  it("persists the evaluation, verifies retrieval, and returns its V3 summary", async () => {
    const evaluateFn = vi.fn(async () => ({
      id: "eval-generation-1",
      resultPersistenceFailed: false,
      toEvaluateSummary: async () => summary,
    }));
    const findById = vi.fn(async () => ({ id: "eval-generation-1" }));

    const result = await runPersistedPromptfooEvaluation(
      {
        suite,
        description,
        tags,
        cache: false,
        maxConcurrency: 1,
      },
      { evaluateFn: evaluateFn as never, findById: findById as never },
    );

    expect(evaluateFn).toHaveBeenCalledWith(
      {
        ...suite,
        writeLatestResults: true,
        description,
        tags: { ...tags, schemaVersion: "1" },
      },
      expect.objectContaining({ cache: false, maxConcurrency: 1 }),
    );
    expect(findById).toHaveBeenCalledWith("eval-generation-1");
    expect(result).toEqual({ evaluationId: "eval-generation-1", summary });
  });

  it("centrally injects schema version 1 and disables cache when callers omit both", async () => {
    const evaluateFn = vi.fn(async () => ({
      id: "eval-generation-1",
      resultPersistenceFailed: false,
      toEvaluateSummary: async () => summary,
    }));

    await runPersistedPromptfooEvaluation(
      { suite, description, tags },
      {
        evaluateFn: evaluateFn as never,
        findById: vi.fn(async () => ({ id: "eval-generation-1" })) as never,
      },
    );

    expect(evaluateFn).toHaveBeenCalledWith(
      expect.objectContaining({ tags: { ...tags, schemaVersion: "1" } }),
      expect.objectContaining({ cache: false }),
    );
  });

  it("does not allow an untyped caller to override the central schema version", async () => {
    const evaluateFn = vi.fn(async () => ({
      id: "eval-generation-1",
      resultPersistenceFailed: false,
      toEvaluateSummary: async () => summary,
    }));

    await runPersistedPromptfooEvaluation(
      {
        suite,
        description,
        tags: { ...tags, schemaVersion: "999" } as typeof tags,
      },
      {
        evaluateFn: evaluateFn as never,
        findById: vi.fn(async () => ({ id: "eval-generation-1" })) as never,
      },
    );

    expect(evaluateFn).toHaveBeenCalledWith(
      expect.objectContaining({ tags: { ...tags, schemaVersion: "1" } }),
      expect.anything(),
    );
  });

  it("rejects evaluations whose results were not persisted", async () => {
    const evaluateFn = vi.fn(async () => ({
      id: "eval-generation-1",
      resultPersistenceFailed: true,
      toEvaluateSummary: async () => summary,
    }));

    await expect(
      runPersistedPromptfooEvaluation(
        { suite, description, tags },
        { evaluateFn: evaluateFn as never, findById: vi.fn() as never },
      ),
    ).rejects.toThrow(/persist/i);
  });

  it("rejects evaluations with a blank persisted ID", async () => {
    const evaluateFn = vi.fn(async () => ({
      id: "   ",
      resultPersistenceFailed: false,
      toEvaluateSummary: async () => summary,
    }));

    await expect(
      runPersistedPromptfooEvaluation(
        { suite, description, tags },
        { evaluateFn: evaluateFn as never, findById: vi.fn() as never },
      ),
    ).rejects.toThrow(/id/i);
  });

  it("rejects evaluations that cannot be retrieved after persistence", async () => {
    const evaluateFn = vi.fn(async () => ({
      id: "eval-generation-1",
      resultPersistenceFailed: false,
      toEvaluateSummary: async () => summary,
    }));
    const findById = vi.fn(async () => undefined);

    await expect(
      runPersistedPromptfooEvaluation(
        { suite, description, tags },
        { evaluateFn: evaluateFn as never, findById: findById as never },
      ),
    ).rejects.toThrow(/retriev/i);
    expect(findById).toHaveBeenCalledWith("eval-generation-1");
  });
});
