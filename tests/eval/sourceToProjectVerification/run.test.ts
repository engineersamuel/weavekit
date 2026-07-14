import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ApiProvider } from "promptfoo";
import { describe, expect, it } from "vitest";
import {
  shouldSwapPairwiseOrder,
  type SourceToProjectPlanJudge,
} from "../../../src/eval/sourceToProjectVerification/judge.js";
import type { PromptfooJudgeTask } from "../../../src/eval/sourceToProjectVerification/promptfooJudgeProvider.js";
import { loadProjectVerificationRejudgeSource } from "../../../src/eval/sourceToProjectVerification/rejudge.js";
import { runSourceToProjectVerification } from "../../../src/eval/sourceToProjectVerification/run.js";
import { ProjectVerificationProviderId } from "../../../src/eval/sourceToProjectVerification/scorecard.js";

const provider: ApiProvider = {
  id: () => ProjectVerificationProviderId.WEAVEKIT,
  callApi: async () => ({ output: "# plan" }),
};

describe("source-to-project verification run", () => {
  it("freezes generation before running and projecting a second Promptfoo judge evaluation", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-promptfoo-two-stage-"));
    const outputDir = join(root, "2026-07-12T12-00-00-000Z");
    const plans = [
      [ProjectVerificationProviderId.WEAVEKIT, "# Weavekit plan\nExact weavekit bytes.\n"],
      [ProjectVerificationProviderId.COPILOT, "# Copilot plan\nExact copilot bytes.\n"],
      [ProjectVerificationProviderId.CODEX, "# Codex plan\nExact codex bytes.\n"],
    ] as const;
    const planPaths = new Map(
      plans.map(([providerId]) => [
        providerId,
        join(outputDir, "providers", encodeURIComponent(providerId), "plan.md"),
      ]),
    );
    let directJudgeCalls = 0;
    const judges = [
      nonInvokedJudge("gpt", () => directJudgeCalls++),
      nonInvokedJudge("claude", () => directJudgeCalls++),
    ];
    const runnerCalls: Record<string, unknown>[] = [];

    const result = await runSourceToProjectVerification(
      { resultsDir: root, matrixRunId: "matrix-run-1", trial: 2 },
      {
        providers: plans.map(([providerId]) => providerFor(providerId)),
        judges,
        now: () => new Date("2026-07-12T12:00:00.000Z"),
        runPromptfoo: (async (args: Record<string, unknown>) => {
          runnerCalls.push(args);
          if (runnerCalls.length === 1) {
            const rows = plans.map(([providerId, markdown]) =>
              successfulRow(providerId, markdown, planPaths.get(providerId)!),
            );
            await materializeGenerationArtifacts(rows);
            return {
              evaluationId: "eval-generation-1",
              summary: promptfooGenerationSummary(rows),
            };
          }

          expect(existsSync(join(outputDir, "manifest.json"))).toBe(true);
          expect(existsSync(join(outputDir, "promptfoo-report.json"))).toBe(true);
          const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")) as {
            artifacts: Array<{ providerId: string; sha256: string }>;
          };
          for (const [providerId, markdown] of plans) {
            const artifact = manifest.artifacts.find(
              (candidate) => candidate.providerId === providerId,
            );
            expect(artifact?.sha256).toBe(sha256(markdown));
            await expect(readFile(planPaths.get(providerId)!, "utf8")).resolves.toBe(markdown);
          }

          const tasks = promptfooJudgeTasks(args.suite);
          expect(tasks).toHaveLength(6);
          const judgeTests = (
            args.suite as { tests: Array<{ metadata?: Record<string, unknown> }> }
          ).tests;
          for (const test of judgeTests) {
            const hashes = test.metadata?.artifactHashes as Record<string, string>;
            for (const [providerId, hash] of Object.entries(hashes)) {
              expect(hash).toBe(
                manifest.artifacts.find((artifact) => artifact.providerId === providerId)?.sha256,
              );
            }
          }
          for (const task of tasks) {
            const taskPlans =
              task.kind === "absolute"
                ? [[task.providerId, task.planMarkdown] as const]
                : Object.entries(task.plans);
            for (const [providerId, markdown] of taskPlans) {
              expect(markdown).toBe(plans.find(([id]) => id === providerId)?.[1]);
            }
          }
          return {
            evaluationId: "eval-judge-1",
            summary: promptfooJudgeSummary(
              args.suite,
              tasks,
              judges.map(({ id }) => id),
            ),
          };
        }) as never,
      },
    );

    expect(runnerCalls).toHaveLength(2);
    expect(runnerCalls[0]).toMatchObject({
      tags: { phase: "generation", matrixRunId: "matrix-run-1", trial: "2" },
    });
    expect(runnerCalls[1]).toMatchObject({
      description:
        "Source-to-project verification judging for todo-safe-write-path trial 2026-07-12T12:00:00.000Z",
      tags: {
        workflow: "source-to-project",
        phase: "judge",
        runId: "2026-07-12T12:00:00.000Z",
        caseId: "todo-safe-write-path",
        matrixRunId: "matrix-run-1",
        trial: "2",
        parentEvaluationId: "eval-generation-1",
        sourceManifestPath: join(outputDir, "manifest.json"),
      },
      cache: false,
      maxConcurrency: 1,
    });
    expect(directJudgeCalls).toBe(0);
    expect(result.promptfoo).toEqual({
      generationEvaluationId: "eval-generation-1",
      judgeEvaluationId: "eval-judge-1",
    });
    expect(result.scorecard.promptfoo).toEqual(result.promptfoo);
    expect(result.scorecard.providers.every(({ score }) => score === 1)).toBe(true);
    expect(JSON.parse(await readFile(join(outputDir, "scores.json"), "utf8"))).toMatchObject({
      promptfoo: result.promptfoo,
    });
    const summary = await readFile(join(outputDir, "summary.md"), "utf8");
    expect(summary).toContain(
      "generation `eval-generation-1`; judge `eval-judge-1` (open with `nubx promptfoo view`)",
    );
    expect(
      JSON.parse(await readFile(join(outputDir, "promptfoo-evaluations.json"), "utf8")),
    ).toEqual(result.promptfoo);
  });

  it("fails closed before generation when a fresh run resolves to an existing output path", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-run-path-collision-"));
    const outputDir = join(root, "2026-07-12T13-00-00-000Z");
    const planRows = [
      successfulRow(
        ProjectVerificationProviderId.WEAVEKIT,
        "# Weavekit collision plan\n",
        join(outputDir, "providers", "weavekit", "plan.md"),
      ),
      successfulRow(
        ProjectVerificationProviderId.COPILOT,
        "# Copilot collision plan\n",
        join(outputDir, "providers", "copilot", "plan.md"),
      ),
      successfulRow(
        ProjectVerificationProviderId.CODEX,
        "# Codex collision plan\n",
        join(outputDir, "providers", "codex", "plan.md"),
      ),
    ];
    const runOptions = { resultsDir: root };
    const providers = [
      providerFor(ProjectVerificationProviderId.WEAVEKIT),
      providerFor(ProjectVerificationProviderId.COPILOT),
      providerFor(ProjectVerificationProviderId.CODEX),
    ];
    const judges = [judge("gpt"), judge("claude")];
    const now = () => new Date("2026-07-12T13:00:00.000Z");

    await runSourceToProjectVerification(runOptions, {
      providers,
      judges,
      now,
      runPromptfoo: promptfooEvaluation(planRows),
    });
    const sentinelPath = join(outputDir, "collision-sentinel.txt");
    await writeFile(sentinelPath, "preserve exact bytes\n", "utf8");
    const before = await snapshotOutputTree(outputDir);
    let generationCalls = 0;

    await expect(
      runSourceToProjectVerification(runOptions, {
        providers,
        judges,
        now,
        runPromptfoo: (async () => {
          generationCalls += 1;
          throw new Error("generation must not run after an output collision");
        }) as never,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(generationCalls).toBe(0);
    const after = await snapshotOutputTree(outputDir);
    expect(after).toEqual(before);
  });

  it("rejects out-of-domain improvement deltas before provider execution", async () => {
    let providerExecutionStarted = false;

    await expect(
      runSourceToProjectVerification(
        { baselinePath: "missing.json", minimumWeavekitDelta: 2 },
        {
          runPromptfoo: (async () => {
            providerExecutionStarted = true;
            throw new Error("provider execution should not start");
          }) as never,
        },
      ),
    ).rejects.toThrow(/between -1 and 1/i);
    expect(providerExecutionStarted).toBe(false);
  });

  it("rejects an incompatible baseline fingerprint before provider execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-incompatible-baseline-"));
    const baselinePath = join(root, "scores.json");
    await writeFile(
      baselinePath,
      JSON.stringify({
        version: 2,
        caseId: "todo-safe-write-path",
        caseSha256: "f".repeat(64),
        title: "Stale case",
        createdAt: "2026-07-09T12:00:00.000Z",
        judgeModels: ["gpt"],
        promptfoo: {
          generationEvaluationId: "eval-generation-baseline",
          judgeEvaluationId: "eval-judge-baseline",
        },
        providers: [
          {
            id: ProjectVerificationProviderId.WEAVEKIT,
            generationSucceeded: true,
            workspaceMutationVerified: true,
            qualityValid: true,
            score: 0.5,
            criteria: { "source-practice-coverage": 0.5 },
            practiceScores: { validation: 0.5 },
            requirementScores: { "validation/action-1": 0.5 },
            errors: [],
            contradictions: [],
            unsupportedRecommendations: [],
          },
        ],
        comparisons: { pairs: [] },
      }),
      "utf8",
    );
    let providerExecutionStarted = false;

    await expect(
      runSourceToProjectVerification(
        { baselinePath, resultsDir: root },
        {
          providers: [provider],
          judges: [judge("gpt")],
          runPromptfoo: (async () => {
            providerExecutionStarted = true;
            throw new Error("provider execution should not start");
          }) as never,
        },
      ),
    ).rejects.toThrow(/fingerprint/i);
    expect(providerExecutionStarted).toBe(false);
  });

  it("writes frozen provider, structured judgment, scorecard, and summary artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-project-verification-run-"));
    const outputDir = join(root, "2026-07-10T12-00-00-000Z");
    const planPath = join(outputDir, "providers", "weavekit", "plan.md");
    const copilotPlanPath = join(outputDir, "providers", "copilot", "plan.md");
    const codexPlanPath = join(outputDir, "providers", "codex", "plan.md");
    let promptfooArgs: Record<string, unknown> | undefined;
    const result = await runSourceToProjectVerification(
      { resultsDir: root },
      {
        providers: [
          provider,
          providerFor(ProjectVerificationProviderId.COPILOT),
          providerFor(ProjectVerificationProviderId.CODEX),
        ],
        judges: [judge("gpt"), judge("claude")],
        now: () => new Date("2026-07-10T12:00:00.000Z"),
        runPromptfoo: promptfooEvaluation(
          [
            {
              provider: { id: ProjectVerificationProviderId.WEAVEKIT },
              success: true,
              latencyMs: 42,
              response: {
                output: "# plan\n",
                metadata: { artifactPaths: [planPath], workspaceMutationVerified: true },
              },
            },
            successfulRow(ProjectVerificationProviderId.COPILOT, "# plan\n", copilotPlanPath),
            successfulRow(ProjectVerificationProviderId.CODEX, "# plan\n", codexPlanPath),
          ],
          (args) => {
            promptfooArgs = args;
          },
        ),
      },
    );

    expect(result.scorecard.version).toBe(2);
    expect(result.scorecard.providers[0]?.score).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.promptfoo).toEqual({
      generationEvaluationId: "eval-generation-1",
      judgeEvaluationId: "eval-judge-1",
    });
    expect(promptfooArgs).toMatchObject({
      description:
        "Source-to-project verification generation for todo-safe-write-path trial 2026-07-10T12:00:00.000Z",
      tags: {
        workflow: "source-to-project",
        phase: "generation",
        runId: "2026-07-10T12:00:00.000Z",
        caseId: "todo-safe-write-path",
      },
      cache: false,
      maxConcurrency: 1,
    });
    for (const file of [
      "promptfoo-report.json",
      "promptfoo-evaluation.json",
      "manifest.json",
      "scores.json",
      "summary.md",
    ]) {
      expect(existsSync(join(result.outputDir, file))).toBe(true);
    }
    await expect(
      readFile(join(result.outputDir, "promptfoo-evaluation.json"), "utf8"),
    ).resolves.toContain('"evaluationId": "eval-generation-1"');
    const manifest = JSON.parse(await readFile(join(result.outputDir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      version: 2,
      promptfooGenerationEvaluationId: "eval-generation-1",
    });
    expect(await readFile(join(result.outputDir, "summary.md"), "utf8")).toContain(
      "## Pairwise preference",
    );
    expect(existsSync(join(result.outputDir, "judgments", "absolute"))).toBe(true);
    const judgment = JSON.parse(
      await readFile(
        join(
          result.outputDir,
          "judgments",
          "absolute",
          encodeURIComponent(ProjectVerificationProviderId.WEAVEKIT),
          "gpt.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(judgment).toMatchObject({
      repairAttempted: false,
      retryCount: 0,
      evidenceDefectCount: 0,
      evidenceDefectCodes: [],
      evidenceDefectOmittedCount: 0,
    });
  });

  it("persists generation artifacts before a Promptfoo judge failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-generation-before-judge-failure-"));
    const outputDir = join(root, "2026-07-10T12-00-00-000Z");
    const planPath = join(outputDir, "providers", "weavekit", "plan.md");
    const copilotPlanPath = join(outputDir, "providers", "copilot", "plan.md");
    const codexPlanPath = join(outputDir, "providers", "codex", "plan.md");
    const generationRows = [
      successfulRow(ProjectVerificationProviderId.WEAVEKIT, "# durable generation\n", planPath),
      successfulRow(
        ProjectVerificationProviderId.COPILOT,
        "# durable generation\n",
        copilotPlanPath,
      ),
      successfulRow(ProjectVerificationProviderId.CODEX, "# durable generation\n", codexPlanPath),
    ];
    let evaluationCalls = 0;

    await expect(
      runSourceToProjectVerification(
        { resultsDir: root },
        {
          providers: [
            provider,
            providerFor(ProjectVerificationProviderId.COPILOT),
            providerFor(ProjectVerificationProviderId.CODEX),
          ],
          judges: [judge("gpt"), judge("claude")],
          now: () => new Date("2026-07-10T12:00:00.000Z"),
          runPromptfoo: (async (_args: Record<string, unknown>) => {
            evaluationCalls += 1;
            if (evaluationCalls === 2) throw new Error("Judge unavailable after generation");
            await materializeGenerationArtifacts(generationRows);
            return {
              evaluationId: "eval-generation-1",
              summary: promptfooGenerationSummary(generationRows),
            };
          }) as never,
        },
      ),
    ).rejects.toThrow(/Judge unavailable after generation/);

    const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")) as {
      caseId: string;
      caseSha256: string;
      promptfooGenerationEvaluationId: string;
    };
    expect(manifest.promptfooGenerationEvaluationId).toBe("eval-generation-1");
    await expect(readFile(join(outputDir, "promptfoo-report.json"), "utf8")).resolves.toContain(
      '"version": 3',
    );
    await expect(readFile(join(outputDir, "promptfoo-evaluation.json"), "utf8")).resolves.toContain(
      '"evaluationId": "eval-generation-1"',
    );
    expect(existsSync(join(outputDir, "scores.json"))).toBe(false);
    expect(existsSync(join(outputDir, "summary.md"))).toBe(false);
    await expect(
      loadProjectVerificationRejudgeSource({
        sourceDir: outputDir,
        expectedCaseId: manifest.caseId,
        expectedCaseSha256: manifest.caseSha256,
        timestamp: "replay",
      }),
    ).resolves.toMatchObject({
      manifest: { promptfooGenerationEvaluationId: "eval-generation-1" },
    });
  });

  it("rejects incomplete generation without asking judges to manufacture quality", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-project-verification-failure-"));
    let judgeCalls = 0;
    const countingJudge = judge("gpt", () => {
      judgeCalls += 1;
    });
    await expect(
      runSourceToProjectVerification(
        { resultsDir: root, providerIds: [ProjectVerificationProviderId.WEAVEKIT] },
        {
          providers: [provider],
          judges: [countingJudge, judge("claude")],
          now: () => new Date("2026-07-10T12:00:00.000Z"),
          runPromptfoo: promptfooEvaluation([
            {
              provider: { id: ProjectVerificationProviderId.WEAVEKIT },
              success: false,
              error: "provider timed out",
            },
          ]),
        },
      ),
    ).rejects.toThrow(/at least one valid plan/i);
    expect(judgeCalls).toBe(0);
  });

  it("rejects a Promptfoo generation summary missing a requested provider before freezing", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-generation-missing-provider-"));
    let evaluationCalls = 0;

    await expect(
      runSourceToProjectVerification(
        {
          resultsDir: root,
          providerIds: [
            ProjectVerificationProviderId.WEAVEKIT,
            ProjectVerificationProviderId.COPILOT,
          ],
        },
        {
          providers: [
            providerFor(ProjectVerificationProviderId.WEAVEKIT),
            providerFor(ProjectVerificationProviderId.COPILOT),
          ],
          judges: [judge("gpt"), judge("claude")],
          now: () => new Date("2026-07-10T12:01:00.000Z"),
          runPromptfoo: (async () => {
            evaluationCalls += 1;
            return {
              evaluationId: "eval-generation-missing-provider",
              summary: promptfooGenerationSummary([
                successfulRow(
                  ProjectVerificationProviderId.WEAVEKIT,
                  "# plan\n",
                  join(root, "not-materialized", "weavekit.md"),
                ),
              ]),
            };
          }) as never,
        },
      ),
    ).rejects.toThrow(/missing.*copilot-cli:plan/i);

    expect(evaluationCalls).toBe(1);
  });

  it("rejects an unknown Promptfoo generation provider before freezing", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-generation-unknown-provider-"));
    let evaluationCalls = 0;

    await expect(
      runSourceToProjectVerification(
        { resultsDir: root, providerIds: [ProjectVerificationProviderId.WEAVEKIT] },
        {
          providers: [providerFor(ProjectVerificationProviderId.WEAVEKIT)],
          judges: [judge("gpt"), judge("claude")],
          now: () => new Date("2026-07-10T12:02:00.000Z"),
          runPromptfoo: (async () => {
            evaluationCalls += 1;
            return {
              evaluationId: "eval-generation-unknown-provider",
              summary: promptfooGenerationSummary([
                successfulRow(
                  ProjectVerificationProviderId.WEAVEKIT,
                  "# plan\n",
                  join(root, "not-materialized", "weavekit.md"),
                ),
                successfulRow(
                  "unknown-provider",
                  "# unknown\n",
                  join(root, "not-materialized", "unknown.md"),
                ),
              ]),
            };
          }) as never,
        },
      ),
    ).rejects.toThrow(/unknown.*unknown-provider/i);

    expect(evaluationCalls).toBe(1);
  });

  it("persists only bounded redacted generation errors in reports and manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-project-verification-redaction-"));
    const outputDir = join(root, "2026-07-10T12-00-00-000Z");
    const secrets = [
      "bearer-report-secret",
      "api-key-report-secret",
      "token-report-secret",
      "named-report-secret",
      "password-report-secret",
      "sk-project-report-secret-123456",
      "environment-api-key-report-secret",
      "environment-bot-token-report-secret",
      "environment-private-key-report-secret",
      "environment-access-token-report-secret",
    ];
    const rawError = `Copilot plan provider failed: Authorization: Bearer ${secrets[0]} api_key=${secrets[1]} token=${secrets[2]} secret=${secrets[3]} password=${secrets[4]} ${secrets[5]} PROJECT_VERIFICATION_JUDGE_API_KEY=${secrets[6]} TELEGRAM_BOT_TOKEN : "${secrets[7]}" SIGNING_PRIVATE_KEY='${secrets[8]}' GitHub_Access_Token=${secrets[9]} stdout=${"o".repeat(2_000)} stderr=${"e".repeat(2_000)}`;

    await expect(
      runSourceToProjectVerification(
        { resultsDir: root, providerIds: [ProjectVerificationProviderId.COPILOT] },
        {
          providers: [providerFor(ProjectVerificationProviderId.COPILOT)],
          judges: [judge("gpt"), judge("claude")],
          now: () => new Date("2026-07-10T12:00:00.000Z"),
          runPromptfoo: promptfooEvaluation([
            {
              provider: { id: ProjectVerificationProviderId.COPILOT },
              success: false,
              error: rawError,
              response: {
                error: rawError,
                metadata: {
                  workspaceMutationVerified: false,
                  workspaceMutationError: rawError,
                },
              },
            },
          ]),
        },
      ),
    ).rejects.toThrow(/at least one valid plan/i);

    const report = await readFile(join(outputDir, "promptfoo-report.json"), "utf8");
    const manifest = await readFile(join(outputDir, "manifest.json"), "utf8");
    for (const persisted of [report, manifest]) {
      for (const secret of secrets) expect(persisted).not.toContain(secret);
      expect(persisted).not.toContain("o".repeat(1_025));
      expect(persisted).not.toContain("e".repeat(1_025));
    }
  });

  it("validates each provider judgment against only that provider's exact plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-project-verification-two-provider-"));
    const outputDir = join(root, "2026-07-10T12-00-00-000Z");
    const weavekitPlanPath = join(outputDir, "providers", "weavekit", "plan.md");
    const copilotPlanPath = join(outputDir, "providers", "copilot", "plan.md");
    const codexPlanPath = join(outputDir, "providers", "codex", "plan.md");
    const result = await runSourceToProjectVerification(
      {
        resultsDir: root,
        providerIds: [
          ProjectVerificationProviderId.WEAVEKIT,
          ProjectVerificationProviderId.COPILOT,
          ProjectVerificationProviderId.CODEX,
        ],
      },
      {
        providers: [
          providerFor(ProjectVerificationProviderId.WEAVEKIT),
          providerFor(ProjectVerificationProviderId.COPILOT),
          providerFor(ProjectVerificationProviderId.CODEX),
        ],
        judges: [providerEvidenceJudge("gpt"), providerEvidenceJudge("claude")],
        now: () => new Date("2026-07-10T12:00:00.000Z"),
        runPromptfoo: promptfooEvaluation([
          successfulRow(
            ProjectVerificationProviderId.WEAVEKIT,
            "# Weavekit plan\nWEAVEKIT-ONLY-EVIDENCE\n",
            weavekitPlanPath,
          ),
          successfulRow(
            ProjectVerificationProviderId.COPILOT,
            "# Copilot plan\nCOPILOT-ONLY-EVIDENCE\n",
            copilotPlanPath,
          ),
          successfulRow(
            ProjectVerificationProviderId.CODEX,
            "# Codex plan\nCODEX-ONLY-EVIDENCE\n",
            codexPlanPath,
          ),
        ]),
      },
    );

    expect(result.passed).toBe(true);
    expect(result.scorecard.providers).toHaveLength(3);
    expect(
      result.scorecard.providers.map(({ id, qualityValid, errors }) => ({
        id,
        qualityValid,
        errors,
      })),
    ).toEqual(
      expect.arrayContaining([
        { id: ProjectVerificationProviderId.WEAVEKIT, qualityValid: true, errors: [] },
        { id: ProjectVerificationProviderId.COPILOT, qualityValid: true, errors: [] },
      ]),
    );
  });
});

function promptfooEvaluation(rows: unknown[], onCall?: (args: Record<string, unknown>) => void) {
  let callCount = 0;
  return (async (args: Record<string, unknown>) => {
    callCount += 1;
    if (callCount === 1) {
      onCall?.(args);
      await materializeGenerationArtifacts(rows);
    }
    if (callCount === 2) {
      const tasks = promptfooJudgeTasks(args.suite);
      const providers = (args.suite as { providers?: ApiProvider[] }).providers ?? [];
      const judgeIds = providers.map((judgeProvider) =>
        judgeProvider.id().replace(/^source-to-project-judge:/, ""),
      );
      return {
        evaluationId: "eval-judge-1",
        summary: promptfooJudgeSummary(args.suite, tasks, judgeIds),
      };
    }
    return {
      evaluationId: "eval-generation-1",
      summary: {
        version: 3,
        timestamp: "2026-07-10T12:00:00.000Z",
        results: rows,
        prompts: [],
        stats: { successes: 1, failures: 0 },
      },
    };
  }) as never;
}

async function materializeGenerationArtifacts(rows: unknown[]): Promise<void> {
  for (const row of rows) {
    const value = row as {
      success?: boolean;
      response?: { output?: unknown; metadata?: { artifactPaths?: unknown } };
    };
    const output = value.response?.output;
    const artifactPaths = value.response?.metadata?.artifactPaths;
    if (value.success === false || typeof output !== "string" || !Array.isArray(artifactPaths)) {
      continue;
    }
    for (const artifactPath of artifactPaths) {
      if (typeof artifactPath !== "string") continue;
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, output, "utf8");
    }
  }
}

async function snapshotOutputTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = join(relativeDirectory, entry.name);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, relativePath);
      } else if (entry.isFile()) {
        snapshot[relativePath] = (await readFile(path)).toString("base64");
      }
    }
  };
  await visit(root, "");
  return snapshot;
}

function promptfooGenerationSummary(rows: unknown[]) {
  return {
    version: 3,
    timestamp: "2026-07-12T12:00:00.000Z",
    results: rows,
    prompts: [],
    stats: { successes: rows.length, failures: 0, errors: 0 },
  };
}

function promptfooJudgeTasks(suite: unknown): PromptfooJudgeTask[] {
  const value = suite as { tests?: Array<{ vars?: Record<string, unknown> }> };
  return (value.tests ?? []).map((test) =>
    JSON.parse(String(test.vars?.task)),
  ) as PromptfooJudgeTask[];
}

function promptfooJudgeSummary(suite: unknown, tasks: PromptfooJudgeTask[], judgeIds: string[]) {
  const value = suite as {
    tests?: Array<{
      description?: string;
      vars?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }>;
  };
  const tests = value.tests ?? [];
  const rows = tasks.flatMap((task, taskIndex) =>
    judgeIds.map((judgeId) => {
      const testCase = tests[taskIndex]!;
      const output =
        task.kind === "absolute"
          ? absoluteJudgeResult(task)
          : {
              winner: "tie" as const,
              confidence: 1,
              decidingFactors: [],
              planAStrengths: [],
              planAGaps: [],
              planBStrengths: [],
              planBGaps: [],
              rationale: "Equivalent plans.",
            };
      const metadata = judgeResponseMetadata(task, judgeId, judgeIds);
      return {
        success: true,
        failureReason: 0,
        score: 1,
        latencyMs: 10,
        cost: 0.01,
        tokenUsage: { prompt: 5, completion: 5, total: 10 },
        namedScores: {},
        promptIdx: 0,
        testIdx: taskIndex,
        promptId: "prompt-judge",
        provider: { id: `source-to-project-judge:${judgeId}` },
        prompt: { raw: JSON.stringify(task), label: "judge task" },
        vars: { task: JSON.stringify(task) },
        response: { output: JSON.stringify(output), metadata },
        gradingResult: { pass: true, score: 1, reason: "Promptfoo judge output is valid." },
        metadata,
        testCase: {
          description: testCase.description,
          vars: testCase.vars,
          metadata: testCase.metadata,
        },
      };
    }),
  );
  return {
    version: 3,
    timestamp: "2026-07-12T12:00:00.000Z",
    results: rows,
    prompts: [],
    stats: { successes: rows.length, failures: 0, errors: 0 },
  };
}

function absoluteJudgeResult(task: Extract<PromptfooJudgeTask, { kind: "absolute" }>) {
  const caseContract = JSON.parse(task.caseJson) as {
    requirements: Array<{ id: string }>;
    criteria: Array<{ criterion: string }>;
  };
  const evidence = task.planMarkdown.trim();
  return {
    requirementAssessments: caseContract.requirements.map(({ id: requirementId }) => ({
      requirementId,
      status: "complete" as const,
      evidenceQuotes: [evidence],
      gaps: [],
      rationale: "Complete.",
    })),
    criterionAssessments: caseContract.criteria.map(({ criterion }) => ({
      criterion,
      score: 4,
      evidenceQuotes: [evidence],
      gaps: [],
      rationale: "Complete.",
    })),
    contradictions: [],
    unsupportedRecommendations: [],
    summary: "Complete.",
  };
}

function judgeResponseMetadata(
  task: PromptfooJudgeTask,
  judgeId: string,
  judgeIds: string[],
): Record<string, unknown> {
  const base = {
    kind: task.kind,
    judgeId,
    bamlClientName: `${judgeId}-client`,
  };
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

function nonInvokedJudge(id: string, onCall: () => void): SourceToProjectPlanJudge {
  const fail = async (): Promise<never> => {
    onCall();
    throw new Error("Judge methods must run only inside Promptfoo providers.");
  };
  return {
    id,
    bamlClientName: `${id}-client`,
    judgePlan: fail,
    judgePlanWithMetadata: fail,
    comparePlans: fail,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerFor(id: ProjectVerificationProviderId): ApiProvider {
  return { id: () => id, callApi: async () => ({ output: "unused" }) };
}

function successfulRow(providerId: string, output: string, planPath: string) {
  return {
    provider: { id: providerId },
    success: true,
    latencyMs: 1,
    response: {
      output,
      metadata: { artifactPaths: [planPath], workspaceMutationVerified: true },
    },
  };
}

function providerEvidenceJudge(id: string): SourceToProjectPlanJudge {
  return {
    ...judge(id),
    judgePlan: async ({ caseJson, planMarkdown }) => {
      const input = JSON.parse(caseJson) as {
        requirements: Array<{ id: string }>;
        criteria: Array<{ criterion: string }>;
      };
      const evidenceQuote = planMarkdown.includes("WEAVEKIT-ONLY-EVIDENCE")
        ? "WEAVEKIT-ONLY-EVIDENCE"
        : "COPILOT-ONLY-EVIDENCE";
      return {
        requirementAssessments: input.requirements.map(({ id: requirementId }) => ({
          requirementId,
          status: "complete",
          evidenceQuotes: [evidenceQuote],
          gaps: [],
          rationale: "complete",
        })),
        criterionAssessments: input.criteria.map(({ criterion }) => ({
          criterion,
          score: 4,
          evidenceQuotes: [evidenceQuote],
          gaps: [],
          rationale: "complete",
        })),
        contradictions: [],
        unsupportedRecommendations: [],
        summary: "complete",
      };
    },
  };
}

function judge(id: string, onCall?: () => void): SourceToProjectPlanJudge {
  return {
    id,
    judgePlan: async ({ caseJson }) => {
      onCall?.();
      const input = JSON.parse(caseJson) as {
        requirements: Array<{ id: string }>;
        criteria: Array<{ criterion: string }>;
      };
      return {
        requirementAssessments: input.requirements.map((requirement) => ({
          requirementId: requirement.id,
          status: "complete",
          evidenceQuotes: ["plan"],
          gaps: [],
          rationale: "complete",
        })),
        criterionAssessments: input.criteria.map((criterion) => ({
          criterion: criterion.criterion,
          score: 4,
          evidenceQuotes: ["plan"],
          gaps: [],
          rationale: "complete",
        })),
        contradictions: [],
        unsupportedRecommendations: [],
        summary: "complete",
      };
    },
    comparePlans: async () => {
      onCall?.();
      return {
        winner: "tie",
        confidence: 1,
        decidingFactors: [],
        planAStrengths: [],
        planAGaps: [],
        planBStrengths: [],
        planBGaps: [],
        rationale: "tie",
      };
    },
  };
}
