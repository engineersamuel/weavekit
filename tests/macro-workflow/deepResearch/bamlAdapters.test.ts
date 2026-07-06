import { describe, expect, it } from "vitest";
import { GeneratedDeepResearchBamlAdapter } from "../../../src/macro-workflow/deepResearch/bamlAdapters.js";

describe("deep-research BAML adapter", () => {
  it("calls generated BAML functions with typed config and prior state", async () => {
    const calls: unknown[][] = [];
    const adapter = new GeneratedDeepResearchBamlAdapter({
      client: {
        async GenerateResearchQuestions(...args: unknown[]) {
          calls.push(args);
          return { iteration: 1, questions: [] };
        },
        async AssessResearchIteration(...args: unknown[]) {
          calls.push(args);
          return {
            iteration: 1,
            questionCoverage: [],
            contradictions: [],
            newFollowUpQuestions: [],
            answerSufficient: true,
            stopReason: "done",
          };
        },
        async CompileDeepResearchReport(...args: unknown[]) {
          calls.push(args);
          return {
            markdown: "# Deep Research Report",
          };
        },
      },
    });
    const config = {
      providers: ["exa", "grok"],
      maxIterations: 3,
      questionsPerIteration: 5,
      maxResultsPerQuestion: 5,
      providerRetryAttempts: 1,
      visualize: false,
    };
    const priorState = {
      iteration: 0,
      completedQuestionIds: [],
      evidence: [],
      assessments: [],
    };

    await adapter.GenerateResearchQuestions("Research", priorState, config);
    await adapter.AssessResearchIteration({ iteration: 1, questions: [] }, [], priorState);
    await adapter.CompileDeepResearchReport("Research", priorState);

    expect(calls).toEqual([
      ["Research", priorState, config, { client: "CopilotProxyGpt55" }],
      [{ iteration: 1, questions: [] }, [], priorState, { client: "CopilotProxyGpt55" }],
      ["Research", priorState, { client: "CopilotProxyClaudeOpus48" }],
    ]);
  });
});
