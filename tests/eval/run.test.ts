import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval } from "../../src/eval/run.js";
import { formatEvalCliOutput } from "../../src/eval-cli.js";
import type { ApiProvider, EvaluateSummaryV3 } from "promptfoo";

function tempCorpus(): { corpusDir: string; resultsDir: string } {
  const base = mkdtempSync(join(tmpdir(), "weavekit-eval-run-"));
  const corpusDir = join(base, "corpus");
  const resultsDir = join(base, "results");
  mkdirSync(corpusDir, { recursive: true });
  writeFileSync(
    join(corpusDir, "x-001.yaml"),
    `id: x-001
domain: sample
difficulty: intro
title: X
prompt: A or B?
referenceAnswer:
  recommendation: Use A.
  rationale: [simple]
  strongestObjections: [B scales]
rubric:
  - criterion: defensible-recommendation
    weight: 1.0
    levels: clear pick
`,
  );
  return { corpusDir, resultsDir };
}

describe("runEval", () => {
  it("formats its persisted evaluation ID for CLI inspection", () => {
    expect(
      formatEvalCliOutput({ outputDir: "/tmp/eval-run", evaluationId: "eval-decision-1" }),
    ).toBe(
      "Eval complete. Results written to /tmp/eval-run\n" +
        "Evaluation ID: eval-decision-1\n" +
        "View persisted evaluations: nubx promptfoo view\n",
    );
  });

  it("returns the persisted evaluation and writes its reports", async () => {
    const { corpusDir, resultsDir } = tempCorpus();
    const fakeProvider: ApiProvider = { id: () => "fake", callApi: async () => ({ output: "x" }) };
    const summary = { stats: { successes: 1, failures: 0 } } as EvaluateSummaryV3;
    const runPromptfoo = vi.fn(async (_args: { suite: { tests?: unknown[] } }) => ({
      evaluationId: "eval-decision-1",
      summary,
    }));

    const result = await runEval(
      { corpusDir, resultsDir },
      {
        providers: [fakeProvider],
        runPromptfoo: runPromptfoo as never,
      },
    );

    expect(result).toEqual({
      outputDir: expect.any(String),
      evaluationId: "eval-decision-1",
      summary,
    });
    expect(runPromptfoo).toHaveBeenCalledWith({
      suite: expect.objectContaining({ tests: expect.any(Array) }),
      description: "Decision council evaluation",
      tags: {
        workflow: "decision",
        phase: "judge",
        runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
      cache: false,
      maxConcurrency: 1,
    });
    expect(runPromptfoo.mock.calls[0]?.[0].suite.tests).toHaveLength(1);
    expect(existsSync(join(result.outputDir, "report.json"))).toBe(true);
    expect(existsSync(join(result.outputDir, "summary.md"))).toBe(true);
    expect(readFileSync(join(result.outputDir, "summary.md"), "utf8")).toContain("Items: 1");
    expect(
      JSON.parse(readFileSync(join(result.outputDir, "promptfoo-evaluation.json"), "utf8")),
    ).toEqual({ evaluationId: "eval-decision-1" });
  });

  it("filters by id and throws when nothing matches", async () => {
    const { corpusDir, resultsDir } = tempCorpus();
    await expect(
      runEval(
        { corpusDir, resultsDir, filterIds: ["does-not-exist"] },
        {
          providers: [],
          runPromptfoo: vi.fn() as never,
        },
      ),
    ).rejects.toThrow(/No corpus items/);
  });

  it("forwards maxConcurrency to promptfoo and defaults to sequential", async () => {
    const explicit = tempCorpus();
    const omitted = tempCorpus();
    const fakeProvider: ApiProvider = { id: () => "fake", callApi: async () => ({ output: "x" }) };
    const summary = { stats: { successes: 1, failures: 0 } } as EvaluateSummaryV3;
    const capturedMaxConcurrency: unknown[] = [];
    const runPromptfoo = vi.fn(async (args: { maxConcurrency?: number }) => {
      capturedMaxConcurrency.push(args.maxConcurrency);
      return { evaluationId: "eval-decision-1", summary };
    });

    await runEval(
      { ...explicit, maxConcurrency: 3 },
      { providers: [fakeProvider], runPromptfoo: runPromptfoo as never },
    );
    await runEval(omitted, { providers: [fakeProvider], runPromptfoo: runPromptfoo as never });

    expect(capturedMaxConcurrency).toEqual([3, 1]);
  });

  it("rejects invalid maxConcurrency before evaluating", async () => {
    const { corpusDir, resultsDir } = tempCorpus();
    const runPromptfoo = vi.fn();

    await expect(
      runEval(
        { corpusDir, resultsDir, maxConcurrency: 0 },
        { providers: [], runPromptfoo: runPromptfoo as never },
      ),
    ).rejects.toThrow(/maxConcurrency.*integer >= 1/);
    expect(runPromptfoo).not.toHaveBeenCalled();
  });
});

describe("parseEvalArgs", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function loadParser(): Promise<
    (argv: string[]) => { filterIds?: string[]; maxConcurrency?: number }
  > {
    vi.doMock("../../src/eval/run.js", () => ({ runEval: vi.fn(async () => "mock-results") }));
    const module = await import("../../src/eval-cli.js");
    const parser = (
      module as {
        parseEvalArgs?: (argv: string[]) => { filterIds?: string[]; maxConcurrency?: number };
      }
    ).parseEvalArgs;
    expect(parser).toBeTypeOf("function");
    return parser!;
  }

  it("parses concurrency flags without treating values as filter ids", async () => {
    const parseEvalArgs = await loadParser();

    expect(parseEvalArgs(["--max-concurrency", "4", "orchestration-framework-001"])).toEqual({
      filterIds: ["orchestration-framework-001"],
      maxConcurrency: 4,
    });
    expect(parseEvalArgs(["--concurrency=2", "data-store-001"])).toEqual({
      filterIds: ["data-store-001"],
      maxConcurrency: 2,
    });
  });

  it("uses EVAL_MAX_CONCURRENCY when no flag is provided", async () => {
    vi.stubEnv("EVAL_MAX_CONCURRENCY", "5");
    const parseEvalArgs = await loadParser();

    expect(parseEvalArgs(["data-store-001"])).toEqual({
      filterIds: ["data-store-001"],
      maxConcurrency: 5,
    });
  });

  it("rejects invalid concurrency values", async () => {
    const parseEvalArgs = await loadParser();

    expect(() => parseEvalArgs(["--max-concurrency", "0"])).toThrow(/max-concurrency/i);
    expect(() => parseEvalArgs(["--concurrency=1.5"])).toThrow(/concurrency/i);
  });
});
