import { describe, expect, it } from "vitest";
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
      runEval({ corpusDir, resultsDir, filterIds: ["does-not-exist"] }, { providers: [], evaluateFn: (async () => ({ toEvaluateSummary: async () => ({}) })) as never }),
    ).rejects.toThrow(/No corpus items/);
  });
});
