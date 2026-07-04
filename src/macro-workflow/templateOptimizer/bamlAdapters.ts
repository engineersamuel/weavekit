import { b } from "../../generated/baml_client/index.js";
import type {
  AggregateTemplateJudgment,
  TemplateCandidate,
  TemplateFixtureJudgment,
} from "../../generated/baml_client/index.js";
import type {
  AggregateJudgmentsArgs,
  GenerateChallengerArgs,
  JudgeFixtureArgs,
  TemplateOptimizerDeps,
} from "./engine.js";

export type TemplateOptimizerBamlClient = {
  GenerateTemplateChallenger: (
    ...args: Parameters<typeof b.GenerateTemplateChallenger>
  ) => ReturnType<typeof b.GenerateTemplateChallenger>;
  JudgeTemplateFixture: (
    ...args: Parameters<typeof b.JudgeTemplateFixture>
  ) => ReturnType<typeof b.JudgeTemplateFixture>;
  AggregateTemplateJudgments: (
    ...args: Parameters<typeof b.AggregateTemplateJudgments>
  ) => ReturnType<typeof b.AggregateTemplateJudgments>;
};

type GenerateTemplateChallengerOptions = NonNullable<
  Parameters<typeof b.GenerateTemplateChallenger>[6]
>;

const STREAMING_GENERATION_OPTIONS: GenerateTemplateChallengerOptions = {
  client: "CopilotProxyGpt55",
  onTick() {
    // Supplying onTick routes generated BAML through its streaming request path.
  },
};

export function createTemplateOptimizerBamlAdapters(
  client: TemplateOptimizerBamlClient = b,
): TemplateOptimizerDeps {
  return {
    generateChallenger(args) {
      return generateTemplateChallenger(client, args);
    },
    judgeFixture(args) {
      return judgeTemplateFixture(client, args);
    },
    aggregateJudgments(args) {
      return aggregateTemplateJudgments(client, args);
    },
  };
}

async function generateTemplateChallenger(
  client: TemplateOptimizerBamlClient,
  args: GenerateChallengerArgs,
): Promise<TemplateCandidate> {
  return client.GenerateTemplateChallenger(
    args.objective,
    args.constraintsSummary,
    args.incumbent,
    args.compactTraceSummary,
    args.strategy,
    args.fixtures,
    STREAMING_GENERATION_OPTIONS,
  );
}

async function judgeTemplateFixture(
  client: TemplateOptimizerBamlClient,
  args: JudgeFixtureArgs,
): Promise<TemplateFixtureJudgment> {
  return client.JudgeTemplateFixture(
    args.objective,
    args.constraintsSummary,
    args.fixture,
    args.incumbent,
    args.challenger,
  );
}

async function aggregateTemplateJudgments(
  client: TemplateOptimizerBamlClient,
  args: AggregateJudgmentsArgs,
): Promise<AggregateTemplateJudgment> {
  return client.AggregateTemplateJudgments(
    args.incumbent,
    args.challenger,
    args.fixtureJudgments,
    args.minimumDelta,
    args.minimumDecisionConfidence,
  );
}
