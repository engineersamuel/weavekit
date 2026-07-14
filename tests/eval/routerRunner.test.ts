import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvaluateSummaryV3 } from "promptfoo";
import { describe, expect, it, vi } from "vitest";
import { RouterRoute } from "../../src/config.js";
import { formatRouterEvalCliOutput } from "../../src/eval-router-cli.js";
import { extractRouterEvalResults, runRouterEval } from "../../src/eval/routerRunner.js";
import { loadCorpusItem } from "../../src/eval/schema.js";

const ITEM = loadCorpusItem(`
id: router-001
domain: router
difficulty: intro
title: Router
prompt: Plan this change.
referenceAnswer:
  recommendation: plan
  rationale: [planning requested]
  strongestObjections: [direct execution may be faster]
rubric:
  - criterion: route-match
    weight: 1.0
    levels: route matches
`);

const SUMMARY = {
  version: 3,
  results: [
    {
      vars: { caseId: "router-001" },
      response: {
        metadata: {
          route: RouterRoute.PLAN,
          promptRewrite: "Create a bounded implementation plan.",
          createWorktreeEligible: false,
        },
      },
    },
  ],
  stats: { successes: 1, failures: 0 },
} as unknown as EvaluateSummaryV3;

describe("router evaluation", () => {
  it("derives router artifacts from Promptfoo result metadata", () => {
    expect(extractRouterEvalResults([ITEM], SUMMARY)).toEqual([
      {
        id: "router-001",
        title: "Router",
        prompt: "Plan this change.",
        expectedRoute: "plan",
        actualRoute: "plan",
        promptRewrite: "Create a bounded implementation plan.",
        createWorktreeEligible: false,
      },
    ]);
  });

  it("records missing Promptfoo provider metadata as an error result", () => {
    expect(extractRouterEvalResults([ITEM], { results: [] })[0]).toMatchObject({
      actualRoute: "error",
      promptRewrite: "",
      createWorktreeEligible: false,
    });
  });

  it("persists through the shared runner and exposes the evaluation ID", async () => {
    const base = mkdtempSync(join(tmpdir(), "weavekit-router-runner-"));
    const corpusDir = join(base, "corpus");
    const resultsDir = join(base, "results");
    const outputDir = join(resultsDir, "run");
    mkdirSync(corpusDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(corpusDir, "router-001.yaml"),
      `
id: router-001
domain: router
difficulty: intro
title: Router
prompt: Plan this change.
referenceAnswer:
  recommendation: plan
  rationale: [planning requested]
  strongestObjections: [direct execution may be faster]
rubric:
  - criterion: route-match
    weight: 1.0
    levels: route matches
`,
    );
    const runEval = vi.fn().mockResolvedValue({
      outputDir,
      evaluationId: "eval-router-1",
      summary: SUMMARY,
    });

    const result = await runRouterEval({ corpusDir, resultsDir }, { runEval });

    expect(result).toMatchObject({ outputDir, evaluationId: "eval-router-1" });
    expect(runEval).toHaveBeenCalledWith(
      expect.objectContaining({
        corpusDir,
        resultsDir,
        evaluation: { description: "Router evaluation", workflow: "router" },
      }),
      expect.objectContaining({ providers: [expect.anything()] }),
    );
    expect(existsSync(join(outputDir, "router-results.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(outputDir, "router-results.json"), "utf8"))).toHaveLength(
      1,
    );
    expect(formatRouterEvalCliOutput(result)).toContain("Evaluation ID: eval-router-1");
  });
});
