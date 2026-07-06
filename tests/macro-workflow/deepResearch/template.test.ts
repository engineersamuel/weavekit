import { describe, expect, it } from "vitest";
import { materializeWorkflowPlan } from "../../../src/macro-workflow/templates.js";
import { verifyWorkflowPlan } from "../../../src/macro-workflow/verifier.js";

describe("deep-research template", () => {
  it("materializes the bounded seed DAG with default research settings", () => {
    const plan = materializeWorkflowPlan("deep-research", {
      objective: "Research durable agent workflows",
    });

    expect(plan.templateId).toBe("deep-research");
    expect(plan.maxReplans).toBe(0);
    expect(plan.nodes.map((node) => node.id)).toEqual(["deep-research-questions-1"]);
    expect(plan.nodes[0]).toMatchObject({
      kind: "research",
      harness: "research",
      title: "Generate research questions",
      dependsOn: [],
      writeMode: "read-only",
      input: {
        deepResearchStep: "generate-questions",
        iteration: 1,
        config: {
          providers: ["grok", "exa", "copilot-last30days"],
          maxIterations: 3,
          questionsPerIteration: 5,
          maxResultsPerQuestion: 5,
          providerRetryAttempts: 1,
          visualize: false,
        },
      },
    });
    expect(verifyWorkflowPlan(plan).valid).toBe(true);
  });

  it("threads explicit provider and visualization config into the seed node", () => {
    const plan = materializeWorkflowPlan("deep-research", {
      objective: "Research current CLI research tools",
      providers: ["grok", "tavily"],
      maxIterations: 2,
      questionsPerIteration: 3,
      maxResultsPerQuestion: 4,
      providerRetryAttempts: 2,
      visualize: true,
    });

    expect(plan.nodes[0]?.input?.config).toEqual({
      providers: ["grok", "tavily"],
      maxIterations: 2,
      questionsPerIteration: 3,
      maxResultsPerQuestion: 4,
      providerRetryAttempts: 2,
      visualize: true,
    });
  });
});
