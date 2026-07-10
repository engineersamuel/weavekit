import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendWorkflowReplayEvent,
  readWorkflowReplayEvents,
  writeMacroWorkflowArtifacts,
} from "../../src/macro-workflow/artifacts.js";

describe("macro workflow artifacts", () => {
  it("reads validated replay JSONL and reports a corrupt line", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "macro-artifacts-"));
    const eventLogPath = join(outputDir, "workflow-events.jsonl");
    try {
      await writeFile(
        eventLogPath,
        [
          JSON.stringify({
            seq: 4,
            ts: "2026-07-10T10:00:00.000Z",
            kind: "planning-started",
          }),
          JSON.stringify({
            seq: 5,
            ts: "2026-07-10T10:00:01.000Z",
            kind: "planning-complete",
          }),
          "",
        ].join("\n"),
        "utf8",
      );

      await expect(readWorkflowReplayEvents(outputDir)).resolves.toMatchObject([
        { seq: 4, kind: "planning-started" },
        { seq: 5, kind: "planning-complete" },
      ]);

      await writeFile(eventLogPath, '{"seq":5,"kind":"not-real"}\n', "utf8");
      await expect(readWorkflowReplayEvents(outputDir)).rejects.toThrow(
        "Invalid workflow replay event at line 1",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("refuses a sensitive replan replay event before appending JSONL", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "macro-artifacts-"));
    try {
      await expect(
        appendWorkflowReplayEvent(outputDir, {
          seq: 1,
          ts: "2026-07-10T10:00:00.000Z",
          kind: "replan-applied",
          patch: {
            reason: "contract-failure",
            replaceRemainingNodeIds: [],
            newNodes: [
              {
                id: "replacement",
                kind: "research",
                harness: "research",
                title: "Replacement",
                prompt: "Retry",
                input: { nested: { apiKey: "do-not-write" } },
                dependsOn: [],
                gates: ["output-contract"],
                writeMode: "read-only",
                replanPolicy: "never",
              },
            ],
          },
        }),
      ).rejects.toThrow("Refusing to persist sensitive workflow state key");
      await expect(readFile(join(outputDir, "workflow-events.jsonl"), "utf8")).rejects.toThrow(
        "ENOENT",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects sensitive replay history before writing any final artifacts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "macro-artifacts-"));
    try {
      await expect(
        writeMacroWorkflowArtifacts({
          outputDir,
          state: {
            planId: "test-plan",
            objective: "Protect replay secrets",
            templateId: "implementation-review",
            status: "running",
            startedAt: new Date("2026-07-10T10:00:00.000Z"),
            currentPlan: {
              id: "test-plan",
              objective: "Protect replay secrets",
              templateId: "implementation-review",
              maxReplans: 0,
              nodes: [],
            },
            nodeResults: [],
            replans: [],
          },
          replayEvents: [
            {
              seq: 1,
              ts: "2026-07-10T10:00:00.000Z",
              kind: "node-added",
              node: {
                id: "dynamic-node",
                kind: "research",
                harness: "research",
                title: "Dynamic node",
                input: { access_token: "do-not-write" },
                dependsOn: [],
              },
            },
          ],
        }),
      ).rejects.toThrow("Refusing to persist sensitive workflow state key");

      await expect(readdir(outputDir)).resolves.toEqual([]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("refuses sensitive state before writing derived payload artifacts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "macro-artifacts-"));
    try {
      await expect(
        writeMacroWorkflowArtifacts({
          outputDir,
          state: {
            planId: "test-plan",
            objective: "Protect secrets",
            templateId: "implementation-review",
            status: "passed",
            startedAt: new Date("2026-06-29T00:00:00Z"),
            currentPlan: {
              id: "test-plan",
              objective: "Protect secrets",
              templateId: "implementation-review",
              maxReplans: 0,
              nodes: [],
            },
            nodeResults: [
              {
                nodeId: "research",
                status: "passed",
                output: "complete",
                payload: { access_token: "do-not-write" },
              },
            ],
            replans: [],
          },
        }),
      ).rejects.toThrow("Refusing to persist sensitive workflow state key");

      await expect(readFile(join(outputDir, "research.payload.json"), "utf8")).rejects.toThrow(
        "ENOENT",
      );
      await expect(readFile(join(outputDir, "workflow-report.md"), "utf8")).rejects.toThrow(
        "ENOENT",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("writes report and state artifacts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "macro-artifacts-"));
    try {
      const artifacts = await writeMacroWorkflowArtifacts({
        outputDir,
        state: {
          planId: "test-plan",
          objective: "Implement logging",
          templateId: "implementation-review",
          status: "passed",
          startedAt: new Date("2026-06-29T00:00:00Z"),
          completedAt: new Date("2026-06-29T00:01:00Z"),
          currentPlan: {
            id: "test-plan",
            objective: "Implement logging",
            templateId: "implementation-review",
            maxReplans: 1,
            nodes: [],
          },
          nodeResults: [],
          replans: [],
        },
        replayEvents: [
          {
            seq: 1,
            ts: "2026-06-29T00:00:00.000Z",
            kind: "planning-started",
            phase: "planning",
            nodeId: "workflow-planning",
          },
        ],
      });

      const report = await readFile(artifacts.reportPath, "utf8");
      const stateFile = await readFile(artifacts.statePath, "utf8");
      const eventLog = await readFile(artifacts.eventLogPath, "utf8");

      expect(report).toContain("Macro Workflow Run Report");
      expect(report).toContain("## Token Usage and Cost");
      expect(stateFile).toContain('"status": "passed"');
      expect(JSON.parse(stateFile)).toMatchObject({
        schemaVersion: 1,
        runId: expect.any(String),
        lastUpdatedAt: expect.any(String),
      });
      expect(eventLog).toContain('"kind":"planning-started"');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("renders model token usage and estimated cost in the workflow report", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "macro-artifacts-"));
    try {
      const artifacts = await writeMacroWorkflowArtifacts({
        outputDir,
        state: {
          planId: "test-plan",
          objective: "Implement logging",
          templateId: "implementation-review",
          status: "passed",
          startedAt: new Date("2026-06-29T00:00:00Z"),
          completedAt: new Date("2026-06-29T00:01:00Z"),
          currentPlan: {
            id: "test-plan",
            objective: "Implement logging",
            templateId: "implementation-review",
            maxReplans: 1,
            nodes: [],
          },
          nodeResults: [],
          replans: [],
          usage: {
            inputTokens: 1000,
            cachedInputTokens: 100,
            outputTokens: 200,
            totalTokens: 1200,
            estimatedCostUsd: 0.01045,
            unpricedModels: [],
            records: [
              {
                id: "usage-1",
                executor: "copilot-sdk",
                mode: "research",
                model: "gpt-5.5",
                label: "Copilot source reading",
                inputTokens: 1000,
                cachedInputTokens: 100,
                outputTokens: 200,
                totalTokens: 1200,
                estimatedCostUsd: 0.01045,
              },
            ],
          },
        },
      });

      const report = await readFile(artifacts.reportPath, "utf8");

      expect(report).toContain("## Token Usage and Cost");
      expect(report).toContain("- Total tokens: 1,200");
      expect(report).toContain("- Total estimated cost: $0.01");
      expect(report).toContain(
        "| Call | Executor | Model | Total | Input | Cached | Output | Estimated cost |",
      );
      expect(report).toContain(
        "| Copilot source reading | copilot-sdk | gpt-5.5 | 1,200 | 1,000 | 100 | 200 | $0.01 |",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("renders source-to-project advisory content in the workflow report", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "macro-artifacts-"));
    try {
      const artifacts = await writeMacroWorkflowArtifacts({
        outputDir,
        state: {
          planId: "source-plan",
          objective: "Read source and advise project",
          templateId: "source-to-project",
          status: "passed",
          startedAt: new Date("2026-06-29T00:00:00Z"),
          completedAt: new Date("2026-06-29T00:01:00Z"),
          currentPlan: {
            id: "source-plan",
            objective: "Read source and advise project",
            templateId: "source-to-project",
            maxReplans: 1,
            nodes: [],
          },
          nodeResults: [
            {
              nodeId: "source-reading",
              status: "passed",
              output: "Source analysis complete.",
              payload: {
                sourceAnalysis: {
                  sourceId: "source-1",
                  title: "Example KG repo",
                  accessLevel: "public",
                  summary:
                    "A repository with a chunk, extract, standardize, infer, visualize pipeline.",
                  claims: [],
                  transferableLessons: [],
                  evidence: [],
                },
              },
            },
            {
              nodeId: "project-research",
              status: "passed",
              output: "Project brief complete.",
              payload: {
                projectBrief: {
                  projectId: "secondbrain",
                  displayName: "Second Brain",
                  architecture: "Markdown vault with ingestion and output folders.",
                  constraints: [],
                  goals: [],
                  changeSurfaces: [],
                  validationCommands: [],
                  risks: [],
                  evidence: [],
                },
              },
            },
            {
              nodeId: "council-review",
              status: "passed",
              output: "Council ranked opportunities.",
              payload: {
                councilReview: {
                  rankingRationale: "Prioritize safe LLM plumbing before visualization.",
                  nonApplicableLessons: [],
                  bundles: [],
                  opportunities: [
                    {
                      id: "opp-1",
                      title: "Add LLM adapter controls",
                      lesson: "Keep LLM calls optional and auditable.",
                      projectChange:
                        "Route agent entrypoints through an opt-in adapter with local-only mode.",
                      changeSurface: "agent entrypoints",
                      score: {
                        applicability: 0.9,
                        applicabilityReasoning:
                          "Test fixture reasoning for applicability score 0.9.",
                        impact: 0.8,
                        impactReasoning: "Test fixture reasoning for impact score 0.8.",
                        confidence: 0.85,
                        confidenceReasoning: "Test fixture reasoning for confidence score 0.85.",
                        implementationCost: 0.5,
                        implementationCostReasoning:
                          "Test fixture reasoning for implementation cost score 0.5.",
                        risk: 0.3,
                        riskReasoning: "Test fixture reasoning for risk score 0.3.",
                      },
                      evidence: [],
                      speculative: false,
                    },
                  ],
                },
              },
            },
            {
              nodeId: "plan-selected-opportunities",
              status: "passed",
              output: "Plan artifact complete.",
              payload: {
                plans: [
                  {
                    opportunityIds: ["opp-1"],
                    title: "LLM adapter layer",
                    recommendation: "Add an opt-in LLM adapter with local-only fail-fast behavior.",
                    problemSolved: "Direct provider calls are hard to audit and disable.",
                    sourceLessonApplied:
                      "Keep LLM steps optional and log raw outputs for debugging.",
                    targetChange: "Introduce one adapter boundary used by agent entrypoints.",
                    expectedUserValue:
                      "Users can inspect and control model calls before implementation.",
                    implementationOutline: [
                      "Define adapter interface",
                      "Update entrypoints",
                      "Add local-only tests",
                    ],
                    scope: "Adapter, config, logging, and tests.",
                    filesLikelyTouched: ["src/llm"],
                    validationCommands: ["nub run typecheck"],
                    risks: ["Logging sensitive model output."],
                    rawPlanArtifactPath: "00-system/plans/llm-adapter.md",
                  },
                ],
              },
            },
          ],
          replans: [],
        },
      });

      const report = await readFile(artifacts.reportPath, "utf8");

      expect(report).toContain("## Advisory Summary");
      expect(report).toContain("Add an opt-in LLM adapter with local-only fail-fast behavior.");
      expect(report).toContain("## Ranked Opportunities");
      expect(report).toContain(
        "Route agent entrypoints through an opt-in adapter with local-only mode.",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("renders rejected final source-to-project reviews instead of active recommendations", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "macro-artifacts-"));
    try {
      const artifacts = await writeMacroWorkflowArtifacts({
        outputDir,
        state: {
          planId: "source-plan",
          objective: "Read source and advise project",
          templateId: "source-to-project",
          status: "passed",
          startedAt: new Date("2026-06-29T00:00:00Z"),
          completedAt: new Date("2026-06-29T00:01:00Z"),
          currentPlan: {
            id: "source-plan",
            objective: "Read source and advise project",
            templateId: "source-to-project",
            maxReplans: 1,
            nodes: [],
          },
          nodeResults: [
            {
              nodeId: "source-reading",
              status: "passed",
              output: "Source analysis complete.",
              payload: {
                sourceAnalysis: {
                  sourceId: "source-1",
                  title: "Example source",
                  accessLevel: "public",
                  summary: "Source summary.",
                  claims: [],
                  transferableLessons: [],
                  evidence: [],
                },
              },
            },
            {
              nodeId: "project-research",
              status: "passed",
              output: "Project brief complete.",
              payload: {
                projectBrief: {
                  projectId: "secondbrain",
                  displayName: "Second Brain",
                  architecture: "Markdown vault.",
                  constraints: [],
                  goals: [],
                  changeSurfaces: [],
                  validationCommands: [],
                  risks: [],
                  evidence: [],
                },
              },
            },
            {
              nodeId: "final-recommendation-review",
              status: "passed",
              output: "Final recommendation review rejected the plan.",
              payload: {
                finalRecommendationReview: {
                  status: "rejected",
                  actionable: false,
                  improvesProject: false,
                  unnecessaryComplexity: true,
                  benefitOutweighsCost: false,
                  complexityAssessment: "Too much complexity for the value.",
                  rationale: "Mostly plumbing.",
                  rejectionReason: "Benefit does not outweigh complexity.",
                  telegramSummary: "Rejected.",
                },
                notification: {
                  channel: "telegram",
                  status: "sent",
                  message: "Rejected.",
                },
              },
            },
          ],
          replans: [],
        },
      });

      const report = await readFile(artifacts.reportPath, "utf8");

      expect(report).toContain("Final Recommendation Review: Rejected");
      expect(report).toContain("Benefit does not outweigh complexity.");
      expect(report).toContain("telegram sent");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
