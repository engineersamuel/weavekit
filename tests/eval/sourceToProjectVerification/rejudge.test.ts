import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ApiProvider, EvaluateSummaryV3 } from "promptfoo";
import { describe, expect, it } from "vitest";
import {
  shouldSwapPairwiseOrder,
  type SourceToProjectPlanJudge,
} from "../../../src/eval/sourceToProjectVerification/judge.js";
import type { PromptfooJudgeTask } from "../../../src/eval/sourceToProjectVerification/promptfooJudgeProvider.js";
import {
  fingerprintProjectVerificationCase,
  loadProjectVerificationCase,
} from "../../../src/eval/sourceToProjectVerification/case.js";
import { loadProjectVerificationRejudgeSource } from "../../../src/eval/sourceToProjectVerification/rejudge.js";
import { runSourceToProjectVerification } from "../../../src/eval/sourceToProjectVerification/run.js";

describe("source-to-project stored-plan rejudge", () => {
  it("verifies frozen plans before exactly one persisted Promptfoo judge evaluation", async () => {
    const sourceDir = await frozenRun();
    const sourceManifestBefore = await readFile(join(sourceDir, "manifest.json"), "utf8");
    let generationCalls = 0;
    let directJudgeCalls = 0;
    const judges = [
      nonInvokedJudge("gpt", () => directJudgeCalls++),
      nonInvokedJudge("claude", () => directJudgeCalls++),
    ];
    const runnerCalls: Record<string, unknown>[] = [];
    const result = await runSourceToProjectVerification(
      { rejudgeFrom: sourceDir, matrixRunId: "matrix-rejudge-1", trial: 3 },
      {
        providers: [countingProvider(() => generationCalls++)],
        judges,
        runPromptfoo: (async (args: Record<string, unknown>) => {
          runnerCalls.push(args);
          const tasks = promptfooJudgeTasks(args.suite);
          return {
            evaluationId: "eval-judge-replay-1",
            summary: promptfooJudgeSummary(
              args.suite,
              tasks,
              judges.map(({ id }) => id),
            ),
          };
        }) as never,
        now: () => new Date("2026-07-10T14:00:00.000Z"),
      },
    );

    expect(generationCalls).toBe(0);
    expect(directJudgeCalls).toBe(0);
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]).toMatchObject({
      tags: {
        workflow: "source-to-project",
        phase: "judge",
        runId: "2026-07-10T14:00:00.000Z",
        matrixRunId: "matrix-rejudge-1",
        trial: "3",
        replayId: "2026-07-10T14:00:00.000Z",
        parentEvaluationId: "eval-generation-source",
        sourceManifestPath: resolve(sourceDir, "manifest.json"),
      },
    });
    expect(result.outputDir).toContain("judge-replays/2026-07-10T14-00-00-000Z");
    expect(result.scorecard.providers.every(({ qualityValid }) => qualityValid)).toBe(true);
    expect(result.generationEvaluationId).toBe("eval-generation-source");
    expect(result.promptfoo).toEqual({
      generationEvaluationId: "eval-generation-source",
      judgeEvaluationId: "eval-judge-replay-1",
    });
    expect(result.scorecard.promptfoo).toEqual(result.promptfoo);
    await expect(
      readFile(join(result.outputDir, "promptfoo-evaluations.json"), "utf8"),
    ).resolves.toContain('"judgeEvaluationId": "eval-judge-replay-1"');
    await expect(
      readFile(join(result.outputDir, "promptfoo-judge-evaluation.json"), "utf8"),
    ).resolves.toContain('"evaluationId": "eval-judge-replay-1"');
    expect(await readFile(join(sourceDir, "manifest.json"), "utf8")).toBe(sourceManifestBefore);
  });

  it("rejects changed plan bytes before calling the judge", async () => {
    const sourceDir = await frozenRun();
    const manifest = JSON.parse(await readFile(join(sourceDir, "manifest.json"), "utf8")) as {
      artifacts: Array<{ planPath: string }>;
    };
    await writeFile(manifest.artifacts[0]!.planPath, "# changed\n", "utf8");
    let evaluationCalls = 0;

    await expect(
      runSourceToProjectVerification(
        { rejudgeFrom: sourceDir },
        {
          judges: [nonInvokedJudge("gpt"), nonInvokedJudge("claude")],
          runPromptfoo: (async () => {
            evaluationCalls += 1;
            throw new Error("evaluation must not run");
          }) as never,
          now: () => new Date("2026-07-10T14:00:00.000Z"),
        },
      ),
    ).rejects.toThrow(/digest mismatch/i);
    expect(evaluationCalls).toBe(0);
    expect(existsSync(join(sourceDir, "judge-replays", "2026-07-10T14-00-00-000Z"))).toBe(false);
  });

  it("leaves the frozen source untouched and fabricates no score when the replay runner fails", async () => {
    const sourceDir = await frozenRun();
    const manifestBefore = await readFile(join(sourceDir, "manifest.json"), "utf8");
    const reportBefore = await readFile(join(sourceDir, "promptfoo-report.json"), "utf8");
    const outputDir = join(sourceDir, "judge-replays", "2026-07-10T15-00-00-000Z");

    await expect(
      runSourceToProjectVerification(
        { rejudgeFrom: sourceDir },
        {
          judges: [nonInvokedJudge("gpt"), nonInvokedJudge("claude")],
          runPromptfoo: (async () => {
            throw new Error("persisted replay failed");
          }) as never,
          now: () => new Date("2026-07-10T15:00:00.000Z"),
        },
      ),
    ).rejects.toThrow(/persisted replay failed/i);

    expect(await readFile(join(sourceDir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(join(sourceDir, "promptfoo-report.json"), "utf8")).toBe(reportBefore);
    expect(existsSync(join(sourceDir, "scores.json"))).toBe(false);
    expect(existsSync(join(outputDir, "scores.json"))).toBe(false);
  });

  it("loads the legacy report filename for a newly frozen historical run", async () => {
    const sourceDir = await frozenRun();
    await writeFile(join(sourceDir, "report.json"), JSON.stringify({ legacy: true }), "utf8");
    await rm(join(sourceDir, "promptfoo-report.json"));

    const source = await loadProjectVerificationRejudgeSource({
      sourceDir,
      expectedCaseId: "todo-safe-write-path",
      expectedCaseSha256: await currentCaseSha256(),
      timestamp: "replay",
    });

    expect(source.promptfooSummary).toEqual({ legacy: true });
  });

  it("rejects a changed case fingerprint even when the case id is unchanged", async () => {
    const sourceDir = await frozenRun();

    await expect(
      loadProjectVerificationRejudgeSource({
        sourceDir,
        expectedCaseId: "todo-safe-write-path",
        expectedCaseSha256: "e".repeat(64),
        timestamp: "replay",
      }),
    ).rejects.toThrow(/case fingerprint/i);
  });

  it("rejects a legacy manifest without its source generation evaluation link", async () => {
    const sourceDir = await frozenRun();
    const manifestPath = join(sourceDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.promptfooGenerationEvaluationId;
    manifest.version = 1;
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(
      loadProjectVerificationRejudgeSource({
        sourceDir,
        expectedCaseId: "todo-safe-write-path",
        expectedCaseSha256: await currentCaseSha256(),
        timestamp: "replay",
      }),
    ).rejects.toThrow(/manifest version 2/i);
  });

  it("rejects an absolute plan path outside the source result root even when its digest matches", async () => {
    const sourceDir = await frozenRun();
    const outsideDir = await mkdtemp(join(tmpdir(), "weavekit-rejudge-outside-"));
    const outsidePlanPath = join(outsideDir, "plan.md");
    await writeFile(outsidePlanPath, "# frozen\n", "utf8");
    await replaceManifestPlanPath(sourceDir, outsidePlanPath);

    await expect(loadFrozenSource(sourceDir)).rejects.toThrow(/outside.*source/i);
  });

  it("rejects a relative plan path that traverses outside the source result root", async () => {
    const sourceDir = await frozenRun();
    const outsidePlanPath = join(dirname(sourceDir), "escaped-plan.md");
    await writeFile(outsidePlanPath, "# frozen\n", "utf8");
    await replaceManifestPlanPath(sourceDir, "../escaped-plan.md");

    await expect(loadFrozenSource(sourceDir)).rejects.toThrow(/outside.*source/i);
  });
});

async function loadFrozenSource(sourceDir: string) {
  return await loadProjectVerificationRejudgeSource({
    sourceDir,
    expectedCaseId: "todo-safe-write-path",
    expectedCaseSha256: await currentCaseSha256(),
    timestamp: "replay",
  });
}

async function replaceManifestPlanPath(sourceDir: string, planPath: string): Promise<void> {
  const manifestPath = join(sourceDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    artifacts: Array<{ planPath: string }>;
  };
  manifest.artifacts[0]!.planPath = planPath;
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
}

async function frozenRun(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "weavekit-rejudge-"));
  const plans = [
    ["weavekit:source-to-project", "# Weavekit frozen\n"],
    ["copilot-cli:plan", "# Copilot frozen\n"],
    ["codex-cli:plan", "# Codex frozen\n"],
  ] as const;
  const artifacts = [];
  for (const [providerId, markdown] of plans) {
    const planPath = join(root, "providers", encodeURIComponent(providerId), "plan.md");
    await mkdir(dirname(planPath), { recursive: true });
    await writeFile(planPath, markdown, "utf8");
    artifacts.push({
      providerId,
      generationSucceeded: true,
      workspaceMutationVerified: true,
      planPath,
      sha256: createHash("sha256").update(markdown).digest("hex"),
      errors: [],
    });
  }
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      version: 2,
      caseId: "todo-safe-write-path",
      caseSha256: await currentCaseSha256(),
      createdAt: "2026-07-10T12:00:00.000Z",
      promptfooGenerationEvaluationId: "eval-generation-source",
      artifacts,
    }),
    "utf8",
  );
  await writeFile(join(root, "promptfoo-report.json"), JSON.stringify({ results: [] }), "utf8");
  return root;
}

async function currentCaseSha256(): Promise<string> {
  return await fingerprintProjectVerificationCase(loadProjectVerificationCase());
}

function nonInvokedJudge(
  id: string,
  onCall: () => void = () => undefined,
): SourceToProjectPlanJudge {
  const fail = async (): Promise<never> => {
    onCall();
    throw new Error("judge methods must run only inside Promptfoo providers");
  };
  return {
    id,
    bamlClientName: `${id}-client`,
    judgePlan: fail,
    judgePlanWithMetadata: fail,
    comparePlans: fail,
  };
}

function countingProvider(onCall: () => void): ApiProvider {
  return {
    id: () => "generation-provider-must-not-run",
    callApi: async () => {
      onCall();
      return { output: "unexpected" };
    },
  };
}

function promptfooJudgeTasks(suite: unknown): PromptfooJudgeTask[] {
  const value = suite as { tests?: Array<{ vars?: Record<string, unknown> }> };
  return (value.tests ?? []).map((test) =>
    JSON.parse(String(test.vars?.task)),
  ) as PromptfooJudgeTask[];
}

function promptfooJudgeSummary(
  suite: unknown,
  tasks: PromptfooJudgeTask[],
  judgeIds: string[],
): EvaluateSummaryV3 {
  const tests = (suite as { tests?: Array<Record<string, unknown>> }).tests ?? [];
  const results = tasks.flatMap((task, taskIndex) =>
    judgeIds.map((judgeId) => judgeRow(task, judgeId, judgeIds, tests[taskIndex]!)),
  );
  return {
    version: 3,
    timestamp: "2026-07-10T14:00:00.000Z",
    results,
    prompts: [],
    stats: { successes: results.length, failures: 0, errors: 0, tokenUsage: TOKEN_USAGE },
  } as EvaluateSummaryV3;
}

function judgeRow(
  task: PromptfooJudgeTask,
  judgeId: string,
  judgeIds: string[],
  testCase: Record<string, unknown>,
) {
  const metadata = judgeMetadata(task, judgeId, judgeIds);
  const output =
    task.kind === "absolute"
      ? absoluteResult(task)
      : {
          winner: "tie",
          confidence: 1,
          decidingFactors: [],
          planAStrengths: [],
          planAGaps: [],
          planBStrengths: [],
          planBGaps: [],
          rationale: "Equivalent.",
        };
  return {
    success: true,
    failureReason: 0,
    score: 1,
    latencyMs: 1,
    cost: 0,
    tokenUsage: TOKEN_USAGE,
    namedScores: {},
    promptIdx: 0,
    testIdx: 0,
    promptId: "judge",
    provider: { id: `source-to-project-judge:${judgeId}` },
    prompt: { raw: JSON.stringify(task), label: "judge" },
    vars: { task: JSON.stringify(task) },
    response: { output: JSON.stringify(output), metadata },
    gradingResult: { pass: true, score: 1, reason: "valid" },
    metadata,
    testCase,
  };
}

const TOKEN_USAGE = {
  prompt: 1,
  completion: 1,
  cached: 0,
  total: 2,
  numRequests: 1,
  completionDetails: {},
  assertions: {},
};

function absoluteResult(task: Extract<PromptfooJudgeTask, { kind: "absolute" }>) {
  const contract = JSON.parse(task.caseJson) as {
    requirements: Array<{ id: string }>;
    criteria: Array<{ criterion: string }>;
  };
  return {
    requirementAssessments: contract.requirements.map(({ id: requirementId }) => ({
      requirementId,
      status: "complete",
      evidenceQuotes: [task.planMarkdown.trim()],
      gaps: [],
      rationale: "Complete.",
    })),
    criterionAssessments: contract.criteria.map(({ criterion }) => ({
      criterion,
      score: 4,
      evidenceQuotes: [task.planMarkdown.trim()],
      gaps: [],
      rationale: "Complete.",
    })),
    contradictions: [],
    unsupportedRecommendations: [],
    summary: "Complete.",
  };
}

function judgeMetadata(task: PromptfooJudgeTask, judgeId: string, judgeIds: string[]) {
  const base = { kind: task.kind, judgeId, bamlClientName: `${judgeId}-client` };
  if (task.kind === "absolute") {
    return {
      ...base,
      providerId: task.providerId,
      repairMetadata: {
        repairAttempted: false,
        retryCount: 0,
        evidenceDefectCount: 0,
        evidenceDefectCodes: [],
        evidenceDefectOmittedCount: 0,
      },
    };
  }
  const swap = shouldSwapPairwiseOrder({
    caseId: task.caseId,
    trialId: task.trialId,
    leftProviderId: task.providerIds[0],
    rightProviderId: task.providerIds[1],
    judgeId,
    judgeIds,
  });
  const [planAProviderId, planBProviderId] = swap
    ? [task.providerIds[1], task.providerIds[0]]
    : [task.providerIds[0], task.providerIds[1]];
  return {
    ...base,
    providerIds: task.providerIds,
    planAProviderId,
    planBProviderId,
    anonymousOrder: { planAProviderId, planBProviderId },
    anonymousWinner: "tie",
    mappedWinner: "tie",
  };
}
