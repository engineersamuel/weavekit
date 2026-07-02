import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeMacroWorkflowArtifacts } from "../../src/macro-workflow/artifacts.js";

describe("macro workflow artifacts", () => {
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
      expect(stateFile).toContain("\"status\": \"passed\"");
      expect(eventLog).toContain("\"kind\":\"planning-started\"");
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
                estimatedCostUsd: 0.01045,
              },
            ],
          },
        },
      });

      const report = await readFile(artifacts.reportPath, "utf8");

      expect(report).toContain("## Token Usage and Cost");
      expect(report).toContain("| Copilot source reading | copilot-sdk | gpt-5.5 | 1,000 | 100 | 200 | $0.01 |");
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
                  summary: "A repository with a chunk, extract, standardize, infer, visualize pipeline.",
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
                      projectChange: "Route agent entrypoints through an opt-in adapter with local-only mode.",
                      changeSurface: "agent entrypoints",
                      score: {
                        applicability: 0.9,
                        impact: 0.8,
                        confidence: 0.85,
                        implementationCost: 0.5,
                        risk: 0.3,
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
                    sourceLessonApplied: "Keep LLM steps optional and log raw outputs for debugging.",
                    targetChange: "Introduce one adapter boundary used by agent entrypoints.",
                    expectedUserValue: "Users can inspect and control model calls before implementation.",
                    implementationOutline: ["Define adapter interface", "Update entrypoints", "Add local-only tests"],
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
      expect(report).toContain("Route agent entrypoints through an opt-in adapter with local-only mode.");
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
