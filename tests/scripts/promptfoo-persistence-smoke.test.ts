import type { EvaluateSummaryV3 } from "promptfoo";
import { describe, expect, it, vi } from "vitest";
import {
  PROMPTFOO_PERSISTENCE_SMOKE_OUTPUT,
  runPromptfooPersistenceSmoke,
} from "../../scripts/promptfoo-persistence-smoke.js";

const evaluationId = "eval-promptfoo-persistence-smoke-1";

describe("runPromptfooPersistenceSmoke", () => {
  it("runs one deterministic persisted row and prints its ID with viewer guidance", async () => {
    const log = vi.fn();
    const runPersistedEvaluation = vi.fn(async (args) => {
      const suite = args.suite;
      const provider = suite.providers?.[0];
      if (!provider || typeof provider === "string" || typeof provider === "function") {
        throw new Error("Expected an in-process Promptfoo smoke provider.");
      }
      const response = await provider.callApi("ignored", {
        prompt: { raw: "ignored", label: "ignored" },
        vars: {},
      });

      return {
        evaluationId,
        summary: successfulSummary(response.output),
      };
    });

    await runPromptfooPersistenceSmoke({ runPersistedEvaluation, console: { log } });

    expect(runPersistedEvaluation).toHaveBeenCalledOnce();
    expect(runPersistedEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringMatching(/promptfoo persistence smoke/i),
        tags: expect.objectContaining({
          workflow: "decision",
          runId: expect.stringMatching(/promptfoo-persistence-smoke/i),
        }),
        cache: false,
        maxConcurrency: 1,
      }),
    );
    const args = runPersistedEvaluation.mock.calls[0]![0];
    expect(args.suite.tests).toHaveLength(1);
    expect(args.suite.tests?.[0]).toMatchObject({
      description: expect.stringMatching(/promptfoo persistence smoke/i),
      assert: [{ type: "equals", value: PROMPTFOO_PERSISTENCE_SMOKE_OUTPUT }],
    });
    expect(log.mock.calls).toEqual([
      [`Promptfoo persistence smoke evaluation ID: ${evaluationId}`],
      ["View persisted evaluations: nubx promptfoo view"],
    ]);
  });

  it("surfaces persisted runner failures", async () => {
    await expect(
      runPromptfooPersistenceSmoke({
        runPersistedEvaluation: vi.fn(async () => {
          throw new Error("Promptfoo evaluation could not be retrieved after persistence.");
        }),
        console: { log: vi.fn() },
      }),
    ).rejects.toThrow(/could not be retrieved after persistence/i);
  });

  it.each([
    ["missing", [], /exactly one.*row/i],
    ["duplicated", [successfulRow(), successfulRow()], /exactly one.*row/i],
    ["non-passing", [{ ...successfulRow(), success: false }], /did not pass/i],
    [
      "wrong provider",
      [{ ...successfulRow(), provider: { id: "unexpected-provider" } }],
      /unexpected provider/i,
    ],
    ["wrong output", [successfulRow("unexpected output")], /unexpected output/i],
  ])("rejects a %s persisted result", async (_case, results, errorPattern) => {
    const log = vi.fn();

    await expect(
      runPromptfooPersistenceSmoke({
        runPersistedEvaluation: vi.fn(async () => ({
          evaluationId,
          summary: successfulSummary(PROMPTFOO_PERSISTENCE_SMOKE_OUTPUT, results),
        })),
        console: { log },
      }),
    ).rejects.toThrow(errorPattern);
    expect(log).not.toHaveBeenCalled();
  });
});

function successfulSummary(
  output: unknown,
  results: unknown[] = [successfulRow(output)],
): EvaluateSummaryV3 {
  return {
    version: 3,
    timestamp: "2026-07-12T12:00:00.000Z",
    results,
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
  } as EvaluateSummaryV3;
}

function successfulRow(output: unknown = PROMPTFOO_PERSISTENCE_SMOKE_OUTPUT) {
  return {
    provider: { id: "weavekit:promptfoo-persistence-smoke" },
    success: true,
    response: { output },
  };
}
