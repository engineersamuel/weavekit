import type { ApiProvider, Assertion, EvaluateTestSuite, TestCase } from "promptfoo";
import { type CorpusItem, formatQuestion, formatReference } from "./schema.js";

export interface JudgeConfig {
  model: string;
  apiBaseUrl: string;
  apiKey: string;
}

export interface BuildSuiteOptions {
  providers: ApiProvider[];
  judge?: JudgeConfig;
}

function defaultJudge(): JudgeConfig {
  return {
    model: process.env.EVAL_JUDGE_MODEL ?? "gpt-4o",
    apiBaseUrl: process.env.EVAL_JUDGE_BASE_URL ?? "http://127.0.0.1:8080/v1",
    apiKey: process.env.EVAL_JUDGE_API_KEY ?? "sk-local",
  };
}

export function buildAssertions(item: CorpusItem, providerCount = 2): Assertion[] {
  const rubric: Assertion[] = item.rubric.map((criterion) => ({
    type: "g-eval",
    value: `${criterion.criterion}: ${criterion.levels}\n\nReference answer for grading:\n{{reference}}`,
    weight: criterion.weight,
    metric: criterion.criterion,
    threshold: 0.7,
  }));
  if (providerCount <= 1) {
    return rubric;
  }
  const pairwise: Assertion = {
    type: "select-best",
    value:
      "Which answer is the more useful and defensible engineering decision, judged against this reference:\n{{reference}}",
  };
  return [...rubric, pairwise];
}

export function buildSuite(items: CorpusItem[], options: BuildSuiteOptions): EvaluateTestSuite {
  const judge = options.judge ?? defaultJudge();
  const tests: TestCase[] = items.map((item) => ({
    description: `${item.id} — ${item.title}`,
    vars: {
      prompt: item.prompt,
      contextItems: item.context,
      constraints: item.constraints,
      question: formatQuestion(item),
      reference: formatReference(item.referenceAnswer),
    },
    assert: buildAssertions(item, options.providers.length),
  }));

  return {
    providers: options.providers,
    prompts: ["{{question}}"],
    defaultTest: {
      options: {
        provider: {
          id: `openai:chat:${judge.model}`,
          config: {
            apiBaseUrl: judge.apiBaseUrl,
            apiKey: judge.apiKey,
            temperature: 0,
          },
        },
      },
    },
    tests,
  };
}
