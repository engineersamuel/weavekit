import { defineAgent, defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import type { CritiqueNormalizer, JudgeReducer } from "./bamlAdapters.js";
import { DecisionCouncilRunFailedError } from "./errors.js";
import { errorMessage, timestamp, type DecisionCouncilLogger } from "./logger.js";
import type { PersonaWorker } from "./personaWorker.js";
import {
  DecisionCouncilRunStateSchema,
  type DecisionCouncilRound,
  type DecisionCouncilRunState,
  type DecisionPersonaCritique,
  type DecisionPersonaFailure,
  type RawPersonaResult,
  type RoundBrief,
} from "./types.js";

export type DecisionCouncilWorkflowDeps = {
  personaWorker: PersonaWorker;
  normalizer: CritiqueNormalizer;
  judge: JudgeReducer;
  logger?: DecisionCouncilLogger;
  runId?: string;
};

function createRoundBrief(state: DecisionCouncilRunState): RoundBrief {
  const roundNumber = state.rounds.length + 1;
  const previous = state.rounds.at(-1);

  return {
    roundNumber,
    prompt: state.input.prompt,
    focus: previous?.assessment.nextRoundBrief ?? "Initial critique",
  };
}

function toFailure(personaId: string, error: unknown): DecisionPersonaFailure {
  return {
    personaId,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

export async function runDecisionCouncilRound(
  state: DecisionCouncilRunState,
  deps: DecisionCouncilWorkflowDeps,
): Promise<DecisionCouncilRunState> {
  // Guard maxRounds as a fail-safe: caller (runCouncilLoop or external) should not call
  // this function when rounds.length >= maxRounds. This check prevents a single round
  // from exceeding the limit if the contract is violated.
  if (state.stopReason || state.finalReport || state.rounds.length >= state.maxRounds) {
    return state;
  }

  const brief = createRoundBrief(state);
  const runId = deps.runId ?? "council";
  const roundStartedAt = performance.now();
  deps.logger?.event({
    type: "council.round.started",
    timestamp: timestamp(),
    runId,
    roundNumber: brief.roundNumber,
    focus: brief.focus,
    focusSource: state.rounds.length === 0 ? "initial" : "judge",
    previousRoundNumber: state.rounds.at(-1)?.brief.roundNumber,
  });
  const rawResults: RawPersonaResult[] = [];
  const failures: DecisionPersonaFailure[] = [];

  const personaResults = await Promise.allSettled(
    state.personas.map(async (persona) => {
      const startedAt = performance.now();
      deps.logger?.event({
        type: "council.persona.started",
        timestamp: timestamp(),
        runId,
        roundNumber: brief.roundNumber,
        personaId: persona.id,
      });

      try {
        const result = await deps.personaWorker.runPersona({ persona, brief });
        deps.logger?.event({
          type: "council.persona.completed",
          timestamp: timestamp(),
          runId,
          roundNumber: brief.roundNumber,
          personaId: persona.id,
          durationMs: performance.now() - startedAt,
        });
        return result;
      } catch (error) {
        deps.logger?.event({
          type: "council.persona.failed",
          timestamp: timestamp(),
          runId,
          roundNumber: brief.roundNumber,
          personaId: persona.id,
          durationMs: performance.now() - startedAt,
          error: errorMessage(error),
        });
        throw error;
      }
    }),
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
    throw new DecisionCouncilRunFailedError("Council requires at least two successful personas.");
  }

  const critiqueResults = await Promise.allSettled(
    rawResults.map(async (raw) => {
      const startedAt = performance.now();
      deps.logger?.event({
        type: "council.baml.started",
        timestamp: timestamp(),
        runId,
        roundNumber: brief.roundNumber,
        operation: "normalize",
        personaId: raw.personaId,
      });

      try {
        const critique = await deps.normalizer.normalizeCritique(raw);
        deps.logger?.event({
          type: "council.baml.completed",
          timestamp: timestamp(),
          runId,
          roundNumber: brief.roundNumber,
          operation: "normalize",
          personaId: raw.personaId,
          durationMs: performance.now() - startedAt,
          summary: critique.overallSummary,
        });
        return critique;
      } catch (error) {
        deps.logger?.event({
          type: "council.baml.failed",
          timestamp: timestamp(),
          runId,
          roundNumber: brief.roundNumber,
          operation: "normalize",
          personaId: raw.personaId,
          durationMs: performance.now() - startedAt,
          error: errorMessage(error),
        });
        throw error;
      }
    }),
  );

  const critiques: DecisionPersonaCritique[] = [];
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
    throw new DecisionCouncilRunFailedError("Council requires at least two normalized critiques.");
  }

  const assessStartedAt = performance.now();
  deps.logger?.event({
    type: "council.baml.started",
    timestamp: timestamp(),
    runId,
    roundNumber: brief.roundNumber,
    operation: "assess",
  });
  const assessment = await deps.judge
    .assessRound({
      roundNumber: brief.roundNumber,
      critiques,
      failures,
    })
    .then((result) => {
      deps.logger?.event({
        type: "council.baml.completed",
        timestamp: timestamp(),
        runId,
        roundNumber: brief.roundNumber,
        operation: "assess",
        durationMs: performance.now() - assessStartedAt,
      });
      return result;
    })
    .catch((error: unknown) => {
      deps.logger?.event({
        type: "council.baml.failed",
        timestamp: timestamp(),
        runId,
        roundNumber: brief.roundNumber,
        operation: "assess",
        durationMs: performance.now() - assessStartedAt,
        error: errorMessage(error),
      });
      throw error;
    });

  const round: DecisionCouncilRound = {
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

  deps.logger?.event({
    type: "council.round.completed",
    timestamp: timestamp(),
    runId,
    roundNumber: brief.roundNumber,
    successfulPersonas: rawResults.length,
    failedPersonas: failures.length,
    confidence: assessment.confidence,
    convergence: assessment.convergence,
    shouldContinue: !shouldStop,
    durationMs: performance.now() - roundStartedAt,
  });

  if (!shouldStop) {
    return { ...state, rounds };
  }

  const reportStartedAt = performance.now();
  deps.logger?.event({
    type: "council.baml.started",
    timestamp: timestamp(),
    runId,
    operation: "report",
  });
  const finalReport = await deps.judge
    .createFinalReport({
      critiques: allCritiques,
      assessments,
      failures: allFailures,
    })
    .then((result) => {
      deps.logger?.event({
        type: "council.baml.completed",
        timestamp: timestamp(),
        runId,
        operation: "report",
        durationMs: performance.now() - reportStartedAt,
      });
      return result;
    })
    .catch((error: unknown) => {
      deps.logger?.event({
        type: "council.baml.failed",
        timestamp: timestamp(),
        runId,
        operation: "report",
        durationMs: performance.now() - reportStartedAt,
        error: errorMessage(error),
      });
      throw error;
    });

  // Deterministic run-state is authoritative: overwrite failedPersonas so the LLM
  // cannot drop, reorder, or hallucinate failures that were tracked by the runner.
  const authoritative = { ...finalReport, failedPersonas: allFailures };

  const stopReason = reachedMaxRounds
    ? "max-rounds"
    : assessment.diminishingReturns
      ? "diminishing-returns"
      : "consensus";

  return { ...state, rounds, finalReport: authoritative, stopReason };
}

export async function runDecisionCouncilLoop(
  initialState: DecisionCouncilRunState,
  deps: DecisionCouncilWorkflowDeps,
): Promise<DecisionCouncilRunState> {
  let state = DecisionCouncilRunStateSchema.parse(initialState);

  // Guard maxRounds at loop level as a safety measure.
  // runDecisionCouncilRound also guards maxRounds to prevent a single round from exceeding the limit.
  // The loop check ensures the outer loop terminates; the round check ensures each round
  // respects the bound regardless of how runDecisionCouncilRound is called.
  while (!state.stopReason && state.rounds.length < state.maxRounds) {
    state = await runDecisionCouncilRound(state, deps);
  }

  return state;
}

// Exported for Flue server-registration seam: runDecisionCouncil (in runner.ts) uses the direct
// runDecisionCouncilLoop for the CLI/library path (v0), while createDecisionCouncilWorkflow enables
// running the council as a Flue workflow on remote services (future integration).
export function createDecisionCouncilWorkflow(deps: DecisionCouncilWorkflowDeps) {
  return defineWorkflow({
    agent: defineAgent(() => ({
      model: "anthropic/claude-haiku-4-5",
      instructions:
        "You host finite Design Council workflow runs. Application code controls the council loop and typed outputs.",
    })),
    input: v.looseObject({}),
    output: v.looseObject({}),
    async run({ input }) {
      return await runDecisionCouncilLoop(DecisionCouncilRunStateSchema.parse(input), deps);
    },
  });
}
