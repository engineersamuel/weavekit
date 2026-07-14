import type { ApiProvider, Assertion, EvaluateTestSuite, TestCase } from "promptfoo";
import { type CorpusItem, formatQuestion, formatReference } from "./schema.js";

export interface JudgeConfig {
  model: string;
  apiBaseUrl: string;
  apiKeyEnvar: string;
}

export interface BuildSuiteOptions {
  providers: ApiProvider[];
  judge?: JudgeConfig;
}

function defaultJudge(): JudgeConfig {
  return {
    model: process.env.EVAL_JUDGE_MODEL ?? "gpt-4o",
    apiBaseUrl: process.env.EVAL_JUDGE_BASE_URL ?? "http://127.0.0.1:8080/v1",
    apiKeyEnvar: "EVAL_JUDGE_API_KEY",
  };
}

function judgeProvider(judge: JudgeConfig) {
  return {
    id: `openai:chat:${judge.model}`,
    config: {
      apiBaseUrl: judge.apiBaseUrl,
      apiKeyEnvar: judge.apiKeyEnvar,
      apiKeyRequired: false,
      temperature: 0,
    },
  };
}

export function buildAssertions(
  item: CorpusItem,
  providerCount = 2,
  judge = defaultJudge(),
): Assertion[] {
  const rubric: Assertion[] = item.rubric.map((criterion) => ({
    type: "g-eval",
    value: `${criterion.criterion}: ${criterion.levels}\n\nReference answer for grading:\n{{reference}}`,
    weight: criterion.weight,
    metric: criterion.criterion,
    threshold: 0.7,
    provider: judgeProvider(judge),
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
      caseId: item.id,
      prompt: item.prompt,
      contextItems: item.context,
      constraints: item.constraints,
      question: formatQuestion(item),
      reference: formatReference(item.referenceAnswer),
    },
    assert: buildAssertions(item, options.providers.length, judge),
  }));

  return {
    writeLatestResults: true,
    providers: options.providers,
    prompts: [
      {
        id: "corpus-question",
        label: "Corpus question",
        raw: "{{question}}",
      },
    ],
    defaultTest: {
      options: {
        provider: {
          text: judgeProvider(judge),
        },
      },
    },
    tests,
  };
}
