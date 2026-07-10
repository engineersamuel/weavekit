import { describe, expect, it } from "vitest";
import {
  extractUsageFromCopilotEventData,
  estimateCostUsdForUsage,
  mergeWorkflowUsageSummaries,
  projectWorkflowCostUsd,
  renderWorkflowUsageMarkdown,
  renderWorkflowUsageSummary,
  WorkflowUsageCollector,
} from "../../src/macro-workflow/usage.js";

describe("workflow usage", () => {
  it("merges cumulative records without double counting duplicates or losing ID collisions", () => {
    const persisted = {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      estimatedCostUsd: 0.0011,
      unpricedModels: [],
      records: [
        {
          id: "usage-1",
          executor: "copilot-sdk" as const,
          label: "Persisted call",
          model: "gpt-5.5",
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          estimatedCostUsd: 0.0011,
        },
      ],
    };
    const resumed = {
      inputTokens: 300,
      outputTokens: 50,
      totalTokens: 350,
      estimatedCostUsd: 0.004,
      unpricedModels: ["unknown-model"],
      records: [
        persisted.records[0]!,
        {
          id: "usage-1",
          executor: "copilot-sdk" as const,
          label: "Resumed call",
          model: "unknown-model",
          inputTokens: 300,
          outputTokens: 50,
          totalTokens: 350,
        },
        {
          id: "usage-1",
          executor: "copilot-sdk" as const,
          label: "Resumed call",
          model: "unknown-model",
          inputTokens: 300,
          outputTokens: 50,
          totalTokens: 350,
        },
      ],
    };

    const summary = mergeWorkflowUsageSummaries(persisted, resumed);

    expect(summary.records).toHaveLength(2);
    expect(summary.records.map((record) => record.id)).toEqual(["usage-1", "usage-2"]);
    expect(summary).toMatchObject({
      inputTokens: 400,
      outputTokens: 70,
      totalTokens: 470,
      estimatedCostUsd: 0.0011,
      unpricedModels: ["unknown-model"],
    });
  });

  it("summarizes total tokens without double-counting cached input", () => {
    const collector = new WorkflowUsageCollector();

    collector.record({
      executor: "copilot-sdk",
      label: "Copilot source reading",
      model: "gpt-5.5",
      inputTokens: 1000,
      cachedInputTokens: 100,
      outputTokens: 200,
    });
    collector.record({
      executor: "baml",
      operation: "CompileDeepResearchReport",
      model: "claude-opus-4.8",
      inputTokens: 300,
      outputTokens: 50,
    });

    const summary = collector.summarize();

    expect(summary).toMatchObject({
      inputTokens: 1300,
      cachedInputTokens: 100,
      outputTokens: 250,
      totalTokens: 1550,
      unpricedModels: [],
    });
    expect(summary.records[0]).toMatchObject({
      inputTokens: 1000,
      cachedInputTokens: 100,
      outputTokens: 200,
      totalTokens: 1200,
      estimatedCostUsd: 0.01055,
    });
  });

  it("renders terminal and markdown summaries with total tokens and total estimated cost", () => {
    const summary = {
      inputTokens: 1000,
      cachedInputTokens: 100,
      outputTokens: 200,
      totalTokens: 1200,
      estimatedCostUsd: 0.01045,
      unpricedModels: [],
      records: [
        {
          id: "usage-1",
          executor: "copilot-sdk" as const,
          label: "Copilot source reading",
          model: "gpt-5.5",
          inputTokens: 1000,
          cachedInputTokens: 100,
          outputTokens: 200,
          totalTokens: 1200,
          estimatedCostUsd: 0.01045,
        },
      ],
    };

    expect(renderWorkflowUsageSummary(summary)).toContain(
      "Token usage: total 1,200 tokens, input 1,000, cached 100, output 200, estimated cost $0.01",
    );
    expect(renderWorkflowUsageSummary(summary)).toContain(
      "Copilot source reading model=gpt-5.5: total 1,200 tokens, input 1,000, cached 100, output 200, est $0.01",
    );

    const markdown = renderWorkflowUsageMarkdown(summary).join("\n");
    expect(markdown).toContain("- Total tokens: 1,200");
    expect(markdown).toContain("- Total estimated cost: $0.01");
    expect(markdown).toContain(
      "| Call | Executor | Model | Total | Input | Cached | Output | Estimated cost |",
    );
    expect(markdown).toContain(
      "| Copilot source reading | copilot-sdk | gpt-5.5 | 1,200 | 1,000 | 100 | 200 | $0.01 |",
    );
  });

  it("reports tokens for unpriced models while leaving cost unavailable", () => {
    const collector = new WorkflowUsageCollector();

    collector.record({
      executor: "copilot-sdk",
      label: "Copilot unknown model",
      model: "unknown-model",
      inputTokens: 10,
      outputTokens: 5,
    });

    const summary = collector.summarize();

    expect(summary.totalTokens).toBe(15);
    expect(summary.estimatedCostUsd).toBeUndefined();
    expect(summary.unpricedModels).toEqual(["unknown-model"]);
    expect(renderWorkflowUsageMarkdown(summary).join("\n")).toContain(
      "- Total estimated cost: n/a",
    );
  });

  it("keeps usage records that only report total tokens", () => {
    const collector = new WorkflowUsageCollector();

    collector.record({
      executor: "copilot-sdk",
      label: "Copilot total only",
      model: "unknown-model",
      totalTokens: 42,
    });

    expect(collector.summarize()).toMatchObject({
      totalTokens: 42,
      records: [{ totalTokens: 42 }],
    });
  });

  it("extracts cached input usage from Copilot event payload variants", () => {
    expect(
      extractUsageFromCopilotEventData({
        usage_details: {
          prompt_tokens: "20",
          completion_tokens: "7",
          prompt_tokens_details: { cached_tokens: "4" },
        },
      }),
    ).toEqual({
      inputTokens: 20,
      cachedInputTokens: 4,
      outputTokens: 7,
    });
  });

  it("exports the per-call estimator used by usage summaries", () => {
    expect(
      estimateCostUsdForUsage("gpt-5.5", {
        inputTokens: 1000,
        cachedInputTokens: 100,
        outputTokens: 200,
      }),
    ).toBe(0.01055);
  });

  it("projects workflow cost from planned calls and reports unpriced models", () => {
    const projection = projectWorkflowCostUsd({
      calls: [
        {
          nodeId: "source-reading",
          model: "gpt-5.5",
          inputTokens: 1000,
          cachedInputTokens: 100,
          outputTokens: 200,
          callCount: 2,
        },
        {
          nodeId: "unknown",
          model: "not-priced",
          inputTokens: 50,
          outputTokens: 25,
        },
      ],
    });

    expect(projection).toMatchObject({
      projectedCostUsd: 0.0211,
      projectedTokens: 2475,
      unpricedModels: ["not-priced"],
    });
  });

  it("uses historical node averages as a conservative floor over static estimates", () => {
    const projection = projectWorkflowCostUsd({
      calls: [
        {
          nodeId: "plan-opportunity",
          harness: "copilot-sdk",
          model: "gpt-5.5",
          inputTokens: 1000,
          outputTokens: 200,
        },
      ],
      nodeCostHistory: {
        version: 1,
        updatedAt: "2026-07-09T00:00:00.000Z",
        nodes: {
          "copilot-sdk:gpt-5.5:plan-opportunity": {
            key: "copilot-sdk:gpt-5.5:plan-opportunity",
            nodeId: "plan-opportunity",
            harness: "copilot-sdk",
            model: "gpt-5.5",
            samples: 3,
            averageTokens: 5000,
            averageCostUsd: 0.25,
            updatedAt: "2026-07-09T00:00:00.000Z",
          },
        },
      },
    });

    expect(projection).toMatchObject({
      projectedCostUsd: 0.25,
      projectedTokens: 5000,
      unpricedModels: [],
    });
  });

  it("does not let cheap historical node averages reduce a larger static projection", () => {
    const projection = projectWorkflowCostUsd({
      calls: [
        {
          nodeId: "plan-opportunity",
          harness: "copilot-sdk",
          model: "gpt-5.5",
          inputTokens: 1000,
          outputTokens: 200,
        },
      ],
      nodeCostHistory: {
        version: 1,
        updatedAt: "2026-07-09T00:00:00.000Z",
        nodes: {
          "copilot-sdk:gpt-5.5:plan-opportunity": {
            key: "copilot-sdk:gpt-5.5:plan-opportunity",
            nodeId: "plan-opportunity",
            harness: "copilot-sdk",
            model: "gpt-5.5",
            samples: 3,
            averageTokens: 10,
            costSamples: 3,
            averageCostUsd: 0.00001,
            updatedAt: "2026-07-09T00:00:00.000Z",
          },
        },
      },
    });

    expect(projection).toMatchObject({
      projectedCostUsd: 0.011,
      projectedTokens: 1200,
      unpricedModels: [],
    });
  });
});
