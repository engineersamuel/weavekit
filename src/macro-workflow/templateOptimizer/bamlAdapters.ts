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

export type TemplateOptimizerBamlAdapterOptions = {
  maxAttempts?: number;
  retryDelayMs?: number;
};

export function createTemplateOptimizerBamlAdapters(
  client: TemplateOptimizerBamlClient = b,
  options: TemplateOptimizerBamlAdapterOptions = {},
): TemplateOptimizerDeps {
  const retryOptions = {
    maxAttempts: options.maxAttempts ?? 3,
    retryDelayMs: options.retryDelayMs ?? 1_000,
  };
  return {
    generateChallenger(args) {
      return retryTransientBamlCall(
        () => generateTemplateChallenger(client, args),
        retryOptions,
      );
    },
    judgeFixture(args) {
      return retryTransientBamlCall(() => judgeTemplateFixture(client, args), retryOptions);
    },
    aggregateJudgments(args) {
      return retryTransientBamlCall(
        () => aggregateTemplateJudgments(client, args),
        retryOptions,
      );
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

async function retryTransientBamlCall<T>(
  call: () => Promise<T>,
  options: Required<TemplateOptimizerBamlAdapterOptions>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      if (attempt === options.maxAttempts || !isTransientBamlError(error)) {
        throw error;
      }
      await delay(options.retryDelayMs);
    }
  }
  throw lastError;
}

function isTransientBamlError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "502",
    "Bad Gateway",
    "408",
    "Request timed out",
    "connection_error",
    "Expected exactly one choices block, got 0",
  ].some((marker) => message.includes(marker));
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
