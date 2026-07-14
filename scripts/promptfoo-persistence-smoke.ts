import { pathToFileURL } from "node:url";
import type { ApiProvider, EvaluateResult, EvaluateTestSuite } from "promptfoo";
import { runPersistedPromptfooEvaluation } from "../src/eval/promptfooRunner.js";

export const PROMPTFOO_PERSISTENCE_SMOKE_OUTPUT = "promptfoo persistence ok";

const providerId = "weavekit:promptfoo-persistence-smoke";
const description = "Promptfoo persistence smoke check";
const runId = "promptfoo-persistence-smoke";
const viewerGuidance = "View persisted evaluations: nubx promptfoo view";

type PersistedEvaluationRunner = typeof runPersistedPromptfooEvaluation;

export interface PromptfooPersistenceSmokeDeps {
  runPersistedEvaluation?: PersistedEvaluationRunner;
  console?: Pick<Console, "log">;
}

const provider: ApiProvider = {
  id: () => providerId,
  callApi: async () => ({ output: PROMPTFOO_PERSISTENCE_SMOKE_OUTPUT }),
};

const suite: EvaluateTestSuite = {
  providers: [provider],
  prompts: ["{{promptfooPersistenceSmokeInput}}"],
  tests: [
    {
      description,
      vars: { promptfooPersistenceSmokeInput: "Run the deterministic persistence smoke check." },
      assert: [{ type: "equals", value: PROMPTFOO_PERSISTENCE_SMOKE_OUTPUT }],
    },
  ],
};

export async function runPromptfooPersistenceSmoke(
  deps: PromptfooPersistenceSmokeDeps = {},
): Promise<void> {
  const runPersistedEvaluation = deps.runPersistedEvaluation ?? runPersistedPromptfooEvaluation;
  const output = deps.console ?? console;
  const evaluation = await runPersistedEvaluation({
    suite,
    description,
    tags: { workflow: "decision", phase: "generation", runId },
    cache: false,
    maxConcurrency: 1,
  });

  verifySuccessfulSmokeRow(evaluation.summary.version, evaluation.summary.results);
  output.log(`Promptfoo persistence smoke evaluation ID: ${evaluation.evaluationId}`);
  output.log(viewerGuidance);
}

function verifySuccessfulSmokeRow(version: number, results: EvaluateResult[]): void {
  if (version !== 3) {
    throw new Error(`Promptfoo persistence smoke expected a V3 summary, received V${version}.`);
  }
  if (results.length !== 1) {
    throw new Error(
      `Promptfoo persistence smoke expected exactly one persisted row, received ${results.length}.`,
    );
  }

  const row = results[0]!;
  if (row.provider.id !== providerId) {
    throw new Error(`Promptfoo persistence smoke received unexpected provider ${row.provider.id}.`);
  }
  if (row.success !== true) {
    throw new Error("Promptfoo persistence smoke row did not pass.");
  }
  if (row.response?.output !== PROMPTFOO_PERSISTENCE_SMOKE_OUTPUT) {
    throw new Error("Promptfoo persistence smoke row returned unexpected output.");
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  runPromptfooPersistenceSmoke().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Promptfoo persistence smoke failed: ${message}`);
    process.exitCode = 1;
  });
}
