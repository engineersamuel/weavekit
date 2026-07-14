import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateReliabilityGate,
  runProjectVerificationMatrix,
  type ReliabilityGateInput,
} from "../../../src/eval/sourceToProjectVerification/matrix.js";
import type { SourceToProjectVerificationRunResult } from "../../../src/eval/sourceToProjectVerification/run.js";
import { ProjectVerificationProviderId } from "../../../src/eval/sourceToProjectVerification/scorecard.js";

describe("source-to-project reliability matrix", () => {
  it("passes only when both baselines meet every approved quality and validity threshold", () => {
    const result = evaluateReliabilityGate(
      matrixFixture({
        codex: {
          wins: 7,
          losses: 3,
          meanQualityMargin: 0.03,
          worstCaseMeanMargin: -0.01,
          reliableWins: 6,
          reliableLosses: 2,
        },
        copilot: {
          wins: 8,
          losses: 2,
          meanQualityMargin: 0.04,
          worstCaseMeanMargin: -0.02,
          reliableWins: 7,
          reliableLosses: 1,
        },
      }),
    );

    expect(result.passed).toBe(true);
    expect(
      evaluateReliabilityGate(matrixFixture({ codex: { worstCaseMeanMargin: -0.021 } })).passed,
    ).toBe(false);
    expect(evaluateReliabilityGate(matrixFixture({ invalidProviderRuns: 1 })).passed).toBe(false);
    expect(evaluateReliabilityGate(matrixFixture({ unauditedWeavekitPlans: 1 })).passed).toBe(
      false,
    );
  });

  it("links every trial to one matrix run and its persisted Promptfoo evaluations", async () => {
    const root = mkdtempSync(join(tmpdir(), "weavekit-project-verification-matrix-"));
    const matrixPath = writeMatrix(root, 2);
    const createMatrixRunId = vi.fn(() => "matrix-run-1");
    const runTrial = vi
      .fn()
      .mockResolvedValueOnce(trialResult(root, 1))
      .mockResolvedValueOnce(trialResult(root, 2));

    const result = await runProjectVerificationMatrix(
      { matrixPath },
      {
        createMatrixRunId,
        now: () => new Date("2026-07-12T18:00:00.000Z"),
        runTrial,
      },
    );

    expect(createMatrixRunId).toHaveBeenCalledOnce();
    expect(result.matrixRunId).toBe("matrix-run-1");
    expect(result.outputDir).toContain("matrix-run-1");
    expect(runTrial).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ matrixRunId: "matrix-run-1", trial: 1 }),
    );
    expect(runTrial).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ matrixRunId: "matrix-run-1", trial: 2 }),
    );
    expect(result.scorecard).toMatchObject({
      matrixRunId: "matrix-run-1",
      trials: [
        {
          caseId: "safe-write",
          trial: 1,
          promptfoo: {
            generationEvaluationId: "eval-generation-1",
            judgeEvaluationId: "eval-judge-1",
          },
        },
        {
          caseId: "safe-write",
          trial: 2,
          promptfoo: {
            generationEvaluationId: "eval-generation-2",
            judgeEvaluationId: "eval-judge-2",
          },
        },
      ],
    });
    expect(
      JSON.parse(readFileSync(join(result.outputDir, "matrix-scorecard.json"), "utf8")),
    ).toMatchObject({
      matrixRunId: "matrix-run-1",
      trials: [
        { promptfoo: { generationEvaluationId: "eval-generation-1" } },
        { promptfoo: { judgeEvaluationId: "eval-judge-2" } },
      ],
    });
    const markdown = readFileSync(join(result.outputDir, "matrix-summary.md"), "utf8");
    expect(markdown).toContain("Matrix run ID: `matrix-run-1`");
    expect(markdown).toContain("| safe-write | 1 | `eval-generation-1` | `eval-judge-1` |");
    expect(markdown).toContain("View persisted evaluations: `nubx promptfoo view`");
  });

  it("prefers reported total tokens when component and cached counts coexist", async () => {
    const root = mkdtempSync(join(tmpdir(), "weavekit-project-verification-matrix-tokens-"));
    const matrixPath = writeMatrix(root);
    const trial = trialResult(root, 1);
    trial.scorecard.providers[0]!.tokenUsage = {
      prompt: 100,
      completion: 50,
      cached: 40,
      total: 150,
    };

    const result = await runProjectVerificationMatrix(
      { matrixPath },
      {
        createMatrixRunId: () => "matrix-token-totals",
        now: () => new Date("2026-07-12T18:15:00.000Z"),
        runTrial: vi.fn().mockResolvedValue(trial),
      },
    );

    expect(result.scorecard.efficiency[ProjectVerificationProviderId.WEAVEKIT]?.tokens).toEqual({
      median: 150,
      p95: 150,
    });
  });

  it("does not add cached tokens to component totals when no total is reported", async () => {
    const root = mkdtempSync(join(tmpdir(), "weavekit-project-verification-matrix-components-"));
    const matrixPath = writeMatrix(root);
    const trial = trialResult(root, 1);
    trial.scorecard.providers[0]!.tokenUsage = {
      prompt: 100,
      completion: 50,
      cached: 40,
    };

    const result = await runProjectVerificationMatrix(
      { matrixPath },
      {
        createMatrixRunId: () => "matrix-component-totals",
        now: () => new Date("2026-07-12T18:16:00.000Z"),
        runTrial: vi.fn().mockResolvedValue(trial),
      },
    );

    expect(result.scorecard.efficiency[ProjectVerificationProviderId.WEAVEKIT]?.tokens).toEqual({
      median: 150,
      p95: 150,
    });
  });

  it("keeps same-time matrix launches distinct by generated identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "weavekit-project-verification-matrix-identity-"));
    const matrixPath = writeMatrix(root);
    const runTrial = vi.fn().mockResolvedValue(trialResult(root, 1));
    const now = () => new Date("2026-07-12T18:30:00.000Z");

    const first = await runProjectVerificationMatrix(
      { matrixPath },
      { createMatrixRunId: () => "matrix-alpha", now, runTrial },
    );
    const second = await runProjectVerificationMatrix(
      { matrixPath },
      { createMatrixRunId: () => "matrix-beta", now, runTrial },
    );

    expect(first.outputDir).not.toBe(second.outputDir);
    expect(first.outputDir).toContain("matrix-alpha");
    expect(second.outputDir).toContain("matrix-beta");
  });

  it("fails before trials when a matrix identity leaf already exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "weavekit-project-verification-matrix-collision-"));
    const matrixPath = writeMatrix(root);
    const now = () => new Date("2026-07-12T19:00:00.000Z");
    const identity = () => "matrix-collision";
    const firstTrial = vi.fn().mockResolvedValue(trialResult(root, 1));
    const first = await runProjectVerificationMatrix(
      { matrixPath },
      { createMatrixRunId: identity, now, runTrial: firstTrial },
    );
    const scorecardPath = join(first.outputDir, "matrix-scorecard.json");
    const existingBytes = readFileSync(scorecardPath);
    const secondTrial = vi.fn().mockResolvedValue(trialResult(root, 2));

    await expect(
      runProjectVerificationMatrix(
        { matrixPath },
        { createMatrixRunId: identity, now, runTrial: secondTrial },
      ),
    ).rejects.toThrow(/exist|collision/i);

    expect(secondTrial).not.toHaveBeenCalled();
    expect(readFileSync(scorecardPath)).toEqual(existingBytes);
  });

  it("rejects an injected matrix identity that could escape the results directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "weavekit-project-verification-matrix-traversal-"));
    const matrixPath = writeMatrix(root);
    const runTrial = vi.fn().mockResolvedValue(trialResult(root, 1));

    await expect(
      runProjectVerificationMatrix(
        { matrixPath },
        {
          createMatrixRunId: () => "../escaped-matrix",
          now: () => new Date("2026-07-12T19:30:00.000Z"),
          runTrial,
        },
      ),
    ).rejects.toThrow(/matrixRunId/i);
    await expect(
      runProjectVerificationMatrix(
        { matrixPath },
        {
          createMatrixRunId: (() => undefined) as never,
          now: () => new Date("2026-07-12T19:30:00.000Z"),
          runTrial,
        },
      ),
    ).rejects.toThrow(/matrixRunId/i);

    expect(runTrial).not.toHaveBeenCalled();
    expect(existsSync(join(root, "escaped-matrix"))).toBe(false);
  });
});

function writeMatrix(root: string, trials = 1): string {
  const matrixPath = join(root, "matrix.yaml");
  writeFileSync(
    matrixPath,
    `version: 1
trials: ${trials}
resultsDir: results
cases:
  - id: safe-write
    path: case.yaml
`,
  );
  return matrixPath;
}

function trialResult(root: string, trial: number): SourceToProjectVerificationRunResult {
  const promptfoo = {
    generationEvaluationId: `eval-generation-${trial}`,
    judgeEvaluationId: `eval-judge-${trial}`,
  };
  return {
    outputDir: join(root, `trial-${trial}`),
    generationEvaluationId: promptfoo.generationEvaluationId,
    promptfoo,
    scorecard: {
      providers: [
        providerScore(ProjectVerificationProviderId.WEAVEKIT, 0.9, true),
        providerScore(ProjectVerificationProviderId.CODEX, 0.5),
        providerScore(ProjectVerificationProviderId.COPILOT, 0.6),
      ],
      comparisons: {
        pairs: [
          comparison(ProjectVerificationProviderId.CODEX),
          comparison(ProjectVerificationProviderId.COPILOT),
        ],
      },
    } as SourceToProjectVerificationRunResult["scorecard"],
    passed: true,
  };
}

function providerScore(id: string, score: number, audited = false) {
  return {
    id,
    generationSucceeded: true,
    workspaceMutationVerified: true,
    qualityValid: true,
    score,
    ...(audited ? { artifactPath: "providers/weavekit/plan-portfolio-full.md" } : {}),
  };
}

function comparison(baselineId: string) {
  return {
    providerIds: [ProjectVerificationProviderId.WEAVEKIT, baselineId],
    status: "agreed",
    winner: ProjectVerificationProviderId.WEAVEKIT,
  };
}

function matrixFixture(
  overrides: Omit<Partial<ReliabilityGateInput>, "codex" | "copilot"> & {
    codex?: Partial<ReliabilityGateInput["codex"]>;
    copilot?: Partial<ReliabilityGateInput["copilot"]>;
  } = {},
): ReliabilityGateInput {
  const baseline = {
    wins: 7,
    losses: 3,
    disputed: 2,
    meanQualityMargin: 0.03,
    worstCaseMeanMargin: -0.01,
    reliableWins: 6,
    reliableLosses: 2,
  };
  return {
    codex: { ...baseline, ...overrides.codex },
    copilot: { ...baseline, ...overrides.copilot },
    invalidProviderRuns: overrides.invalidProviderRuns ?? 0,
    invalidJudgePanels: overrides.invalidJudgePanels ?? 0,
    unauditedWeavekitPlans: overrides.unauditedWeavekitPlans ?? 0,
  };
}
