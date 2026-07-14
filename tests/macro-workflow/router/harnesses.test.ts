import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RouterRoute as BamlRouterRoute } from "../../../src/generated/baml_client/index.js";
import { RouterRoute, type RouterDefaults } from "../../../src/config.js";
import {
  createRouterHarnessRegistry,
  isRouterHandoffCreateWorktreeEligible,
  validateRouterResult,
} from "../../../src/macro-workflow/router/harnesses.js";
import { runMacroWorkflow } from "../../../src/macro-workflow/runner.js";
import { materializeWorkflowPlan } from "../../../src/macro-workflow/templates.js";
import { WorkflowHarnessKind } from "../../../src/macro-workflow/types.js";

const config: RouterDefaults = {
  primaryModel: "gpt-5.5",
  catalog: [
    {
      id: "herdr-manual",
      route: RouterRoute.MANUAL_HERDR_WORKTREE,
      harness: "herdr",
      ability: "manual-create-worktree",
      model: "gpt-5.3-codex",
      taskFit: ["manual handoff"],
      strengths: ["human-controlled"],
      limitations: ["requires complete fields"],
    },
  ],
  preferences: [
    {
      id: "ambiguous-prompts",
      match: ["maybe"],
      prefer: { route: RouterRoute.GRILL_WITH_DOCS },
      force: true,
      rationale: "Ask before handoff.",
    },
  ],
};

describe("router harness", () => {
  it("runs advisory and report nodes with normalized route and artifacts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "router-"));
    try {
      const bamlCalls: string[] = [];
      const harnesses = createRouterHarnessRegistry({
        config,
        baml: {
          async RoutePrompt(userPrompt, routeTaxonomy, catalogJson, preferenceJson) {
            bamlCalls.push(userPrompt, routeTaxonomy, catalogJson, preferenceJson);
            return {
              primary: {
                route: BamlRouterRoute.ManualHerdrWorktree,
                harness: "herdr",
                ability: "manual-create-worktree",
                model: "gpt-5.3-codex",
                modelRationale: "Codex is best for implementation handoff.",
                confidence: 0.86,
                rationale: "The prompt asks for a separate implementation worktree.",
                scores: [
                  {
                    dimension: "handoff fit",
                    score: 5,
                    rationale: "All handoff fields are present.",
                  },
                ],
                promptRewrite: "Implement the bounded feature in the new worktree.",
                handoff: {
                  provider: "herdr",
                  targetProjectId: "weavekit",
                  branchOrWorktreeName: "router",
                  harnessOrAgent: "codex",
                  createWorktreeEligible: false,
                  missingRequirements: [],
                },
              },
              alternatives: [
                {
                  route: BamlRouterRoute.LocalCodeChange,
                  harness: "codex-cli",
                  ability: "local-code-change",
                  model: "gpt-5.3-codex",
                  modelRationale: "Local coding is plausible.",
                  confidence: 0.72,
                  rationale: "Could be done locally.",
                  scores: [],
                  promptRewrite: "Implement locally.",
                },
                {
                  route: BamlRouterRoute.Plan,
                  harness: "copilot-cli",
                  ability: "task-plan",
                  model: "claude-opus-4.8",
                  modelRationale: "Planning is a safe alternative.",
                  confidence: 0.65,
                  rationale: "Could plan the handoff before creating a worktree.",
                  scores: [],
                  promptRewrite: "Plan the implementation handoff.",
                },
              ],
              catalogEvidence: ["herdr-manual"],
              preferenceEvidence: ["ambiguous-prompts"],
              warnings: [],
            };
          },
        },
      });
      const state = await runMacroWorkflow(
        materializeWorkflowPlan("router", {
          objective: "Create a herdr worktree for weavekit on router using codex.",
        }),
        { harnesses, outputDir },
      );

      expect(state.status).toBe("passed");
      expect(bamlCalls[0]).toContain("Create a herdr worktree");
      expect(bamlCalls[1]).toContain("manual-herdr-worktree");
      expect(JSON.parse(bamlCalls[2] as string)[0].id).toBe("herdr-manual");
      expect(JSON.parse(bamlCalls[3] as string)[0].id).toBe("ambiguous-prompts");
      expect(state.nodeResults[0]?.payload?.routerResult as Record<string, unknown>).toMatchObject({
        primary: {
          route: "manual-herdr-worktree",
          promptRewrite: "Implement the bounded feature in the new worktree.",
          handoff: { createWorktreeEligible: true },
        },
      });
      const report = await readFile(join(outputDir, "RouterReport.md"), "utf8");
      const json = await readFile(join(outputDir, "RouterResult.json"), "utf8");
      expect(report).toContain("Router Report");
      expect(report).toContain("manual-herdr-worktree");
      expect(JSON.parse(json).primary.route).toBe("manual-herdr-worktree");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects missing primary prompt rewrites", () => {
    expect(() =>
      validateRouterResult({
        primary: {
          route: BamlRouterRoute.GrillWithDocs,
          harness: "copilot-cli",
          modelRationale: "Ambiguous.",
          confidence: 0.5,
          rationale: "Missing details.",
          scores: [],
          promptRewrite: "",
        },
        alternatives: [
          minimalRecommendation(BamlRouterRoute.DirectAnswer),
          minimalRecommendation(BamlRouterRoute.Plan),
        ],
        catalogEvidence: [],
        preferenceEvidence: [],
        warnings: [],
      }),
    ).toThrow("requires a prompt rewrite");
  });

  it("requires exactly two alternatives with routes distinct from the primary", () => {
    expect(() =>
      validateRouterResult({
        primary: {
          route: BamlRouterRoute.GrillWithDocs,
          harness: "copilot-cli",
          modelRationale: "Ambiguous.",
          confidence: 0.5,
          rationale: "Missing details.",
          scores: [],
          promptRewrite: "Ask clarifying questions.",
        },
        alternatives: [],
        catalogEvidence: [],
        preferenceEvidence: [],
        warnings: [],
      }),
    ).toThrow("exactly two alternatives");

    expect(() =>
      validateRouterResult({
        primary: minimalRecommendation(BamlRouterRoute.GrillWithDocs),
        alternatives: [
          minimalRecommendation(BamlRouterRoute.DirectAnswer),
          minimalRecommendation(BamlRouterRoute.DirectAnswer),
        ],
        catalogEvidence: [],
        preferenceEvidence: [],
        warnings: [],
      }),
    ).toThrow("distinct routes");

    expect(() =>
      validateRouterResult({
        primary: minimalRecommendation(BamlRouterRoute.GrillWithDocs),
        alternatives: [
          minimalRecommendation(BamlRouterRoute.GrillWithDocs),
          minimalRecommendation(BamlRouterRoute.DirectAnswer),
        ],
        catalogEvidence: [],
        preferenceEvidence: [],
        warnings: [],
      }),
    ).toThrow("distinct from the primary route");
  });

  it("computes manual Create Worktree eligibility from required fields", () => {
    expect(
      isRouterHandoffCreateWorktreeEligible({
        route: RouterRoute.MANUAL_HERDR_WORKTREE,
        targetProjectId: "weavekit",
        branchOrWorktreeName: "router",
        harnessOrAgent: "codex",
        promptRewrite: "Implement this.",
      }),
    ).toBe(true);
    expect(
      isRouterHandoffCreateWorktreeEligible({
        route: RouterRoute.MANUAL_HERDR_WORKTREE,
        targetProjectId: "weavekit",
        branchOrWorktreeName: "",
        harnessOrAgent: "codex",
        promptRewrite: "Implement this.",
      }),
    ).toBe(false);
    expect(
      isRouterHandoffCreateWorktreeEligible({
        route: RouterRoute.REMOTE_DELEGATE_PR,
        targetProjectId: "weavekit",
        branchOrWorktreeName: "router",
        harnessOrAgent: "codex",
        promptRewrite: "Implement this.",
      }),
    ).toBe(false);
  });

  it("rejects unsupported primary models instead of misreporting provenance", () => {
    expect(() =>
      createRouterHarnessRegistry({
        config: { ...config, primaryModel: "unknown-router-model" },
      }),
    ).toThrow("Unsupported router primary model");
  });

  it("registers research and reporter adapters", () => {
    const registry = createRouterHarnessRegistry({ config });

    expect(registry.get(WorkflowHarnessKind.RESEARCH)).toBeTypeOf("function");
    expect(registry.get(WorkflowHarnessKind.REPORTER)).toBeTypeOf("function");
  });
});

function minimalRecommendation(route = BamlRouterRoute.DirectAnswer) {
  return {
    route,
    harness: "copilot-cli",
    modelRationale: "Fast.",
    confidence: 0.4,
    rationale: "Simple answer possible.",
    scores: [],
    promptRewrite: "Answer directly.",
  };
}
