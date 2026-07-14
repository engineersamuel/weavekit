import { describe, expect, it } from "vitest";
import { buildRouterComparisonConfig } from "../../src/eval/routerComparisonConfig.js";
import { loadCorpusItem } from "../../src/eval/schema.js";

const ITEM = loadCorpusItem(`
id: direct-answer
domain: router
difficulty: intro
title: Direct answer
prompt: Explain this error.
context: []
constraints: []
referenceAnswer:
  recommendation: direct-answer
  rationale: [The request is narrow.]
  strongestObjections: [Ask for the exact error when needed.]
rubric:
  - criterion: route-match
    weight: 1
    levels: Primary route must be direct-answer.
`);

describe("buildRouterComparisonConfig", () => {
  it("embeds the judge connection for MCP reruns", () => {
    const config = buildRouterComparisonConfig([ITEM], "/repo/provider.ts", {
      model: "judge-x",
      apiBaseUrl: "http://127.0.0.1:9000/v1",
      apiKey: "sk-local",
    });

    const judge = config.defaultTest.options.provider;
    expect(judge).toEqual({
      id: "openai:chat:judge-x",
      config: {
        apiBaseUrl: "http://127.0.0.1:9000/v1",
        apiKey: "sk-local",
        temperature: 0,
      },
    });
    expect(config.tests[0]?.assert[0]?.provider).toEqual(judge);
  });
});
