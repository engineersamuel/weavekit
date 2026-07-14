import { type CorpusItem, formatQuestion, formatReference } from "./schema.js";

export type RouterComparisonJudgeConfig = {
  model: string;
  apiBaseUrl: string;
  apiKey?: string;
  apiKeyEnvar?: string;
};

export function buildRouterComparisonConfig(
  items: CorpusItem[],
  providerPath: string,
  judge: RouterComparisonJudgeConfig,
) {
  if (!judge.apiKey && !judge.apiKeyEnvar) {
    throw new Error("Router comparison judge requires apiKey or apiKeyEnvar.");
  }

  const judgeProvider = {
    id: `openai:chat:${judge.model}`,
    config: {
      apiBaseUrl: judge.apiBaseUrl,
      ...(judge.apiKey ? { apiKey: judge.apiKey } : { apiKeyEnvar: judge.apiKeyEnvar }),
      temperature: 0,
    },
  };

  return {
    description: "Router deterministic vs gpt-5-mini comparison",
    tags: {
      workflow: "router",
      comparison: "deterministic-vs-gpt-5-mini",
    },
    providers: [
      {
        id: `file://${providerPath}`,
        label: "router-deterministic",
        config: { mode: "deterministic" },
      },
      {
        id: `file://${providerPath}`,
        label: "router-gpt-5-mini",
        config: { mode: "gpt-5-mini" },
      },
    ],
    prompts: [
      {
        id: "router-eval-prompt",
        label: "Router eval prompt",
        raw: "{{routePrompt}}",
      },
    ],
    defaultTest: {
      options: {
        provider: judgeProvider,
      },
    },
    tests: items.map((item) => ({
      description: `${item.id} — ${item.title}`,
      metadata: {
        domain: "router",
        expectedRoute: item.referenceAnswer.recommendation,
        difficulty: item.difficulty,
      },
      vars: {
        routeCase: item.id,
        routePrompt: formatQuestion(item),
        expectedRoute: item.referenceAnswer.recommendation,
        reference: formatReference(item.referenceAnswer),
      },
      assert: [
        {
          type: "g-eval",
          metric: "overall-router-quality",
          threshold: 0.7,
          provider: judgeProvider,
          value: [
            "Score the Router answer against this reference answer.",
            "Prioritize exact route fit, safe treatment of missing context, useful prompt rewrite, defensible rationale, and correct handoff eligibility.",
            "",
            "Reference answer:",
            "{{reference}}",
          ].join("\n"),
        },
      ],
    })),
  };
}
