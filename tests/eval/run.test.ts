import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval } from "../../src/eval/run.js";
import type { ApiProvider } from "promptfoo";

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
  it("builds a suite, evaluates, and writes a report", async () => {
    const { corpusDir, resultsDir } = tempCorpus();
    let evaluatedItems = 0;
    const fakeProvider: ApiProvider = { id: () => "fake", callApi: async () => ({ output: "x" }) };
    const dir = await runEval(
      { corpusDir, resultsDir },
      {
        providers: [fakeProvider],
        evaluateFn: (async (suite: { tests?: unknown[] }) => {
          evaluatedItems = suite.tests?.length ?? 0;
          return { toEvaluateSummary: async () => ({ stats: { successes: 1, failures: 0 } }) };
        }) as never,
      },
    );
    expect(evaluatedItems).toBe(1);
    expect(existsSync(join(dir, "report.json"))).toBe(true);
    expect(existsSync(join(dir, "summary.md"))).toBe(true);
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain("Items: 1");
  });

  it("filters by id and throws when nothing matches", async () => {
    const { corpusDir, resultsDir } = tempCorpus();
    await expect(
      runEval(
        { corpusDir, resultsDir, filterIds: ["does-not-exist"] },
        {
          providers: [],
          evaluateFn: (async () => ({ toEvaluateSummary: async () => ({}) })) as never,
        },
      ),
    ).rejects.toThrow(/No corpus items/);
  });

  it("forwards maxConcurrency to promptfoo and defaults to sequential", async () => {
    const explicit = tempCorpus();
    const omitted = tempCorpus();
    const fakeProvider: ApiProvider = { id: () => "fake", callApi: async () => ({ output: "x" }) };
    const capturedMaxConcurrency: unknown[] = [];
    const evaluateFn = (async (_suite: unknown, options: { maxConcurrency?: number }) => {
      capturedMaxConcurrency.push(options.maxConcurrency);
      return { toEvaluateSummary: async () => ({ stats: { successes: 1, failures: 0 } }) };
    }) as never;

    await runEval({ ...explicit, maxConcurrency: 3 }, { providers: [fakeProvider], evaluateFn });
    await runEval(omitted, { providers: [fakeProvider], evaluateFn });

    expect(capturedMaxConcurrency).toEqual([3, 1]);
  });

  it("rejects invalid maxConcurrency before evaluating", async () => {
    const { corpusDir, resultsDir } = tempCorpus();
    const evaluateFn = vi.fn(async () => ({ toEvaluateSummary: async () => ({}) }));

    await expect(
      runEval(
        { corpusDir, resultsDir, maxConcurrency: 0 },
        { providers: [], evaluateFn: evaluateFn as never },
      ),
    ).rejects.toThrow(/maxConcurrency.*integer >= 1/);
    expect(evaluateFn).not.toHaveBeenCalled();
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
