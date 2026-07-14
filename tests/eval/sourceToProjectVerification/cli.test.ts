import { describe, expect, it } from "vitest";
import {
  formatSourceToProjectMatrixCliOutput,
  formatSourceToProjectVerificationCliOutput,
  parseSourceToProjectVerificationArgs,
} from "../../../src/eval-source-to-project-cli.js";
import { ProjectVerificationProviderId } from "../../../src/eval/sourceToProjectVerification/scorecard.js";

describe("source-to-project verification CLI", () => {
  it.each([
    ["fresh", "eval-generation-fresh", "eval-judge-fresh"],
    ["rejudge", "eval-generation-source", "eval-judge-replay"],
  ])("prints distinct generation and judge IDs for a %s run", (_kind, generation, judge) => {
    expect(
      formatSourceToProjectVerificationCliOutput({
        outputDir: "/tmp/source-run",
        promptfoo: { generationEvaluationId: generation, judgeEvaluationId: judge },
      }),
    ).toBe(
      "Source-to-project verification complete: /tmp/source-run\n" +
        `Generation evaluation ID: ${generation}\n` +
        `Judge evaluation ID: ${judge}\n` +
        "View persisted evaluations: nubx promptfoo view\n",
    );
  });

  it("prints Promptfoo viewer guidance for a reliability matrix", () => {
    expect(formatSourceToProjectMatrixCliOutput({ outputDir: "/tmp/matrix-run" })).toBe(
      "Source-to-project reliability matrix complete: /tmp/matrix-run\n" +
        "View persisted evaluations: nubx promptfoo view\n",
    );
  });

  it("parses a reliability matrix and rejects single-case options", () => {
    expect(
      parseSourceToProjectVerificationArgs([
        "--matrix",
        "evals/source-to-project/matrix.yaml",
        "--trials",
        "3",
      ]),
    ).toEqual({
      matrixPath: "evals/source-to-project/matrix.yaml",
      trials: 3,
    });
    expect(() =>
      parseSourceToProjectVerificationArgs(["--matrix", "matrix.yaml", "--case", "case.yaml"]),
    ).toThrow(/--matrix cannot be combined with --case/i);
    expect(() =>
      parseSourceToProjectVerificationArgs(["--matrix", "matrix.yaml", "--trials", "0"]),
    ).toThrow(/--trials must be an integer >= 1/i);
  });

  it("parses provider selection and a prior-run improvement gate", () => {
    expect(
      parseSourceToProjectVerificationArgs([
        "--case",
        "case.yaml",
        "--output",
        "artifacts",
        "--providers",
        "weavekit,codex",
        "--baseline",
        "previous/scores.json",
        "--minimum-weavekit-delta",
        "0.05",
        "--max-concurrency",
        "2",
      ]),
    ).toEqual({
      casePath: "case.yaml",
      resultsDir: "artifacts",
      providerIds: [ProjectVerificationProviderId.WEAVEKIT, ProjectVerificationProviderId.CODEX],
      baselinePath: "previous/scores.json",
      minimumWeavekitDelta: 0.05,
      maxConcurrency: 2,
    });
  });

  it("rejects an improvement gate without a baseline scorecard", () => {
    expect(() =>
      parseSourceToProjectVerificationArgs(["--minimum-weavekit-delta", "0.01"]),
    ).toThrow(/requires --baseline/i);
  });

  it("rejects improvement deltas outside the normalized score domain", () => {
    for (const delta of ["-1.01", "1.01", "2"]) {
      expect(() =>
        parseSourceToProjectVerificationArgs([
          "--baseline",
          "previous/scores.json",
          "--minimum-weavekit-delta",
          delta,
        ]),
      ).toThrow(/between -1 and 1/i);
    }
  });

  it("parses stored-plan rejudging and rejects provider selection", () => {
    expect(parseSourceToProjectVerificationArgs(["--rejudge-from", "prior/run"])).toEqual({
      rejudgeFrom: "prior/run",
    });
    expect(() =>
      parseSourceToProjectVerificationArgs([
        "--rejudge-from",
        "prior/run",
        "--providers",
        "weavekit",
      ]),
    ).toThrow(/cannot be combined/i);
    expect(() =>
      parseSourceToProjectVerificationArgs([
        "--rejudge-from",
        "prior/run",
        "--max-concurrency",
        "2",
      ]),
    ).toThrow(/cannot be combined/i);
    expect(() =>
      parseSourceToProjectVerificationArgs([
        "--rejudge-from",
        "prior/run",
        "--output",
        "other-results",
      ]),
    ).toThrow(/cannot be combined/i);
  });
});
