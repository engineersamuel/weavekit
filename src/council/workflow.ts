import { defineAgent, defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import type { CritiqueNormalizer, JudgeReducer } from "./bamlAdapters.js";
import { CouncilRunFailedError } from "./errors.js";
import type { PersonaWorker } from "./personaWorker.js";
import {
  CouncilRunStateSchema,
  type CouncilRound,
  type CouncilRunState,
  type PersonaFailure,
  type RawPersonaResult,
  type RoundBrief,
} from "./types.js";

export type CouncilWorkflowDeps = {
  personaWorker: PersonaWorker;
  normalizer: CritiqueNormalizer;
  judge: JudgeReducer;
};

function createRoundBrief(state: CouncilRunState): RoundBrief {
  const roundNumber = state.rounds.length + 1;
  const previous = state.rounds.at(-1);

  return {
    roundNumber,
    prompt: state.input.prompt,
    focus: previous?.assessment.nextRoundBrief ?? "Initial critique",
  };
}

function toFailure(personaId: string, error: unknown): PersonaFailure {
  return {
    personaId,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

export async function runCouncilRound(
  state: CouncilRunState,
  deps: CouncilWorkflowDeps,
): Promise<CouncilRunState> {
  if (state.stopReason || state.finalReport) {
    return state;
  }

  const brief = createRoundBrief(state);
  const rawResults: RawPersonaResult[] = [];
  const failures: PersonaFailure[] = [];

  const personaResults = await Promise.allSettled(
    state.personas.map(async (persona) => deps.personaWorker.runPersona({ persona, brief })),
  );

  for (let index = 0; index < personaResults.length; index += 1) {
    const persona = state.personas[index]!;
    const result = personaResults[index]!;

    if (result.status === "fulfilled") {
      rawResults.push(result.value);
    } else {
      failures.push(toFailure(persona.id, result.reason));
    }
  }

  if (rawResults.length < 2) {
    throw new CouncilRunFailedError("Council requires at least two successful personas.");
  }

  const critiqueResults = await Promise.allSettled(
    rawResults.map(async (raw) => deps.normalizer.normalizeCritique(raw)),
  );

  const critiques = [];
  for (let index = 0; index < critiqueResults.length; index += 1) {
    const raw = rawResults[index]!;
    const result = critiqueResults[index]!;

    if (result.status === "fulfilled") {
      critiques.push(result.value);
    } else {
      failures.push(toFailure(raw.personaId, result.reason));
    }
  }

  if (critiques.length < 2) {
    throw new CouncilRunFailedError("Council requires at least two normalized critiques.");
  }

  const assessment = await deps.judge.assessRound({
    roundNumber: brief.roundNumber,
    critiques,
    failures,
  });

  const round: CouncilRound = {
    brief,
    rawResults,
    critiques,
    failures,
    assessment,
  };

  const rounds = [...state.rounds, round];
  const allCritiques = rounds.flatMap((item) => item.critiques);
  const allFailures = rounds.flatMap((item) => item.failures);
  const assessments = rounds.map((item) => item.assessment);

  const reachedMaxRounds = rounds.length >= state.maxRounds;
  const shouldStop = reachedMaxRounds || !assessment.shouldContinue || assessment.diminishingReturns;

  if (!shouldStop) {
    return { ...state, rounds };
  }

  const finalReport = await deps.judge.createFinalReport({
    critiques: allCritiques,
    assessments,
    failures: allFailures,
  });

  const stopReason = reachedMaxRounds
    ? "max-rounds"
    : assessment.diminishingReturns
      ? "diminishing-returns"
      : "consensus";

  return { ...state, rounds, finalReport, stopReason };
}

export async function runCouncilLoop(
  initialState: CouncilRunState,
  deps: CouncilWorkflowDeps,
): Promise<CouncilRunState> {
  let state = CouncilRunStateSchema.parse(initialState);

  while (!state.stopReason && state.rounds.length < state.maxRounds) {
    state = await runCouncilRound(state, deps);
  }

  return state;
}

export function createCouncilWorkflow(deps: CouncilWorkflowDeps) {
  return defineWorkflow({
    agent: defineAgent(() => ({
      model: "anthropic/claude-haiku-4-5",
      instructions:
        "You host finite Design Council workflow runs. Application code controls the council loop and typed outputs.",
    })),
    input: v.any(),
    output: v.any(),
    async run({ input }) {
      return await runCouncilLoop(CouncilRunStateSchema.parse(input), deps);
    },
  });
}
