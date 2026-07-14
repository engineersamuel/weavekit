import type { ApiProvider, EvaluateTestSuite, TestCase } from "promptfoo";
import { formatProjectVerificationPrompt, type ProjectVerificationCase } from "./case.js";

export function buildProjectVerificationSuite(
  definition: ProjectVerificationCase,
  options: { providers: ApiProvider[] },
): EvaluateTestSuite {
  const test: TestCase = {
    description: `${definition.id} - ${definition.title}`,
    vars: { benchmarkPrompt: formatProjectVerificationPrompt(definition) },
    assert: [],
  };
  return {
    providers: options.providers,
    prompts: ["{{benchmarkPrompt}}"],
    tests: [test],
  };
}
