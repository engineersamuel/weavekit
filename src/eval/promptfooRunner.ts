import { evaluate } from "promptfoo";
import type { EvaluateOptions, EvaluateSummaryV3, EvaluateTestSuite } from "promptfoo";

export interface PromptfooEvaluationTags {
  workflow: "decision" | "router" | "source-to-project";
  phase: "generation" | "judge" | "calibration";
  runId: string;
  caseId?: string;
  trial?: string;
  matrixRunId?: string;
  replayId?: string;
  parentEvaluationId?: string;
  sourceManifestPath?: string;
}

export interface PersistedPromptfooEvaluation {
  evaluationId: string;
  summary: EvaluateSummaryV3;
}

interface RunPersistedPromptfooEvaluationArgs {
  suite: EvaluateTestSuite;
  description: string;
  tags: PromptfooEvaluationTags;
  cache?: boolean;
  maxConcurrency?: number;
  outputPath?: string;
}

interface RunPersistedPromptfooEvaluationDeps {
  evaluateFn?: typeof evaluate;
  findById?: FindPromptfooEvaluationById;
}

type PromptfooEvaluationRecord = Awaited<ReturnType<typeof evaluate>>;
type FindPromptfooEvaluationById = (id: string) => Promise<PromptfooEvaluationRecord | undefined>;

interface PromptfooEvaluationRecordConstructor {
  findById: FindPromptfooEvaluationById;
}

function normalizeTags(tags: PromptfooEvaluationTags): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(tags).map(([key, value]) => [key, String(value)])),
    schemaVersion: "1",
  };
}

function findByIdFrom(record: PromptfooEvaluationRecord): FindPromptfooEvaluationById {
  const constructor = record.constructor as unknown as PromptfooEvaluationRecordConstructor;
  return constructor.findById.bind(constructor);
}

export async function runPersistedPromptfooEvaluation(
  args: RunPersistedPromptfooEvaluationArgs,
  deps: RunPersistedPromptfooEvaluationDeps = {},
): Promise<PersistedPromptfooEvaluation> {
  const evaluateFn = deps.evaluateFn ?? evaluate;
  const options: EvaluateOptions & { outputPath?: string } = {
    cache: args.cache ?? false,
    maxConcurrency: args.maxConcurrency,
    outputPath: args.outputPath,
  };
  const result = await evaluateFn(
    {
      ...args.suite,
      writeLatestResults: true,
      description: args.description,
      tags: normalizeTags(args.tags),
    },
    options,
  );

  if (result.resultPersistenceFailed) {
    throw new Error("Promptfoo evaluation results were not persisted.");
  }
  if (result.id.trim().length === 0) {
    throw new Error("Promptfoo evaluation returned a blank evaluation ID.");
  }
  const findById = deps.findById ?? findByIdFrom(result);
  if (!(await findById(result.id))) {
    throw new Error(`Promptfoo evaluation ${result.id} could not be retrieved after persistence.`);
  }

  const summary = (await result.toEvaluateSummary()) as EvaluateSummaryV3;
  return { evaluationId: result.id, summary };
}
