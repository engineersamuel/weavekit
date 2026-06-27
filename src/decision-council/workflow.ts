import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { CritiqueNormalizer, JudgeReducer } from "./bamlAdapters.js";
import { setSerializedAttribute } from "./bamlTelemetry.js";
import { DecisionCouncilRunFailedError } from "./errors.js";
import { errorMessage, timestamp, type DecisionCouncilLogger } from "./logger.js";
import type { PersonaWorker } from "./personaWorker.js";
import type { PersonaSelector } from "../personas/selector.js";
import {
  DecisionCouncilRunStateSchema,
  type DecisionCouncilRound,
  type DecisionCouncilRunState,
  type DecisionPersonaCritique,
  type DecisionPersonaFailure,
  type RawPersonaResult,
  type RoundBrief,
} from "./types.js";

const tracer = trace.getTracer("weavekit.decision-council");

export type DecisionCouncilWorkflowDeps = {
  personaSelector: PersonaSelector;
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

function previousRoundSignals(state: DecisionCouncilRunState): string[] {
  return state.rounds.flatMap((round) => [
    `Round ${round.brief.roundNumber} consensus: ${round.assessment.consensus}`,
    `Round ${round.brief.roundNumber} disagreements: ${round.assessment.disagreements.join("; ") || "none"}`,
    `Round ${round.brief.roundNumber} selected personas: ${round.personaSelection.personaIds.join(", ")}`,
  ]);
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
  const critiques: DecisionPersonaCritique[] = [];
  const personasStartedAt = performance.now();
  deps.logger?.event({
    type: "council.personas.started",
    timestamp: timestamp(),
    runId,
    roundNumber: brief.roundNumber,
    candidatePersonaCount: state.personas.length,
  });

  let selection: Awaited<ReturnType<PersonaSelector["choosePersonas"]>>;
  const selectionInput = {
    workflowName: "decision-council",
    workflowPurpose: "Produce a balanced recommendation across multiple persona viewpoints.",
    taskPrompt: state.input.prompt,
    context: state.input.context,
    constraints: state.input.constraints,
    roundNumber: brief.roundNumber,
    roundFocus: brief.focus,
    previousSelectionIds: state.rounds.at(-1)?.personaSelection.personaIds ?? [],
    previousRoundSignals: previousRoundSignals(state),
    candidatePersonas: state.personas,
    candidatePersonaIds: state.personas.map((persona) => persona.id),
    minPersonas: 2,
    maxPersonas: 6,
  };
  const selectionTelemetryInput = {
    workflowName: selectionInput.workflowName,
    workflowPurpose: selectionInput.workflowPurpose,
    taskPrompt: selectionInput.taskPrompt,
    context: selectionInput.context,
    constraints: selectionInput.constraints,
    roundNumber: selectionInput.roundNumber,
    roundFocus: selectionInput.roundFocus,
    previousSelectionIds: selectionInput.previousSelectionIds,
    previousRoundSignals: selectionInput.previousRoundSignals,
    candidatePersonaIds: selectionInput.candidatePersonaIds,
    minPersonas: selectionInput.minPersonas,
    maxPersonas: selectionInput.maxPersonas,
  };
  try {
    selection = await tracer.startActiveSpan("run.council.persona-selector", async (span) => {
      span.setAttribute("weavekit.decision_council.operation", "select-personas");
      span.setAttribute("weavekit.decision_council.run_id", runId);
      span.setAttribute("weavekit.decision_council.round_number", brief.roundNumber);
      setSerializedAttribute(span, "weavekit.decision_council.args", selectionTelemetryInput);
      setSerializedAttribute(span, "langfuse.observation.input", selectionTelemetryInput);

      try {
        const result = await deps.personaSelector.choosePersonas(selectionInput);
        const output = {
          personaIds: result.personaSet.personas.map((persona) => persona.id),
          rationale: result.rationale,
        };
        span.setAttribute("weavekit.decision_council.selected_persona_count", output.personaIds.length);
        setSerializedAttribute(span, "weavekit.decision_council.result", output);
        setSerializedAttribute(span, "langfuse.observation.output", output);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage(error),
        });
        throw error;
      } finally {
        span.end();
      }
    });
    deps.logger?.event({
      type: "council.personas.completed",
      timestamp: timestamp(),
      runId,
      roundNumber: brief.roundNumber,
      personaIds: selection.personaSet.personas.map((persona) => persona.id),
      rationale: selection.rationale,
      durationMs: performance.now() - personasStartedAt,
    });
  } catch (error) {
    deps.logger?.event({
      type: "council.personas.failed",
      timestamp: timestamp(),
      runId,
      roundNumber: brief.roundNumber,
      durationMs: performance.now() - personasStartedAt,
      error: errorMessage(error),
    });
    throw error;
  }

  type Outcome =
    | { stage: "ok"; raw: RawPersonaResult; critique: DecisionPersonaCritique }
    | { stage: "persona-failed"; failure: DecisionPersonaFailure }
    | { stage: "normalize-failed"; raw: RawPersonaResult; failure: DecisionPersonaFailure };

  async function processPersona(persona: (typeof selection.personaSet.personas)[number]): Promise<Outcome> {
    const personaStartedAt = performance.now();
    deps.logger?.event({
      type: "council.persona.started",
      timestamp: timestamp(),
      runId,
      roundNumber: brief.roundNumber,
      personaId: persona.id,
    });

    let raw: RawPersonaResult;
    try {
      raw = await deps.personaWorker.runPersona({ persona, brief });
      deps.logger?.event({
        type: "council.persona.completed",
        timestamp: timestamp(),
        runId,
        roundNumber: brief.roundNumber,
        personaId: persona.id,
        model: raw.metadata.model,
        durationMs: performance.now() - personaStartedAt,
      });
    } catch (error) {
      deps.logger?.event({
        type: "council.persona.failed",
        timestamp: timestamp(),
        runId,
        roundNumber: brief.roundNumber,
        personaId: persona.id,
        durationMs: performance.now() - personaStartedAt,
        error: errorMessage(error),
      });
      return { stage: "persona-failed", failure: toFailure(persona.id, error) };
    }

    const normalizeStartedAt = performance.now();
    let model: string | undefined;
    deps.logger?.event({
      type: "council.baml.started",
      timestamp: timestamp(),
      runId,
      roundNumber: brief.roundNumber,
      operation: "normalize",
      personaId: raw.personaId,
    });

    try {
      const critique = await deps.normalizer.normalizeCritique(raw, (resolved) => {
        model = resolved;
      });
      deps.logger?.event({
        type: "council.baml.completed",
        timestamp: timestamp(),
        runId,
        roundNumber: brief.roundNumber,
        operation: "normalize",
        personaId: raw.personaId,
        model,
        durationMs: performance.now() - normalizeStartedAt,
        summary: critique.overallSummary,
      });
      return { stage: "ok", raw, critique };
    } catch (error) {
      deps.logger?.event({
        type: "council.baml.failed",
        timestamp: timestamp(),
        runId,
        roundNumber: brief.roundNumber,
        operation: "normalize",
        personaId: raw.personaId,
        model,
        durationMs: performance.now() - normalizeStartedAt,
        error: errorMessage(error),
      });
      return { stage: "normalize-failed", raw, failure: toFailure(raw.personaId, error) };
    }
  }

  const outcomes = await Promise.all(selection.personaSet.personas.map((persona) => processPersona(persona)));

  for (const outcome of outcomes) {
    if (outcome.stage === "ok") {
      rawResults.push(outcome.raw);
      critiques.push(outcome.critique);
    } else if (outcome.stage === "normalize-failed") {
      rawResults.push(outcome.raw);
      failures.push(outcome.failure);
    } else {
      failures.push(outcome.failure);
    }
  }

  // Fusing the stages means degraded runs may normalize successful personas even if
  // the raw-success guard later throws; this is failure-path only, bounded by persona count.
  if (rawResults.length < 2) {
    throw new DecisionCouncilRunFailedError("Council requires at least two successful personas.");
  }

  if (critiques.length < 2) {
    throw new DecisionCouncilRunFailedError("Council requires at least two normalized critiques.");
  }

  const assessStartedAt = performance.now();
  let assessModel: string | undefined;
  deps.logger?.event({
    type: "council.baml.started",
    timestamp: timestamp(),
    runId,
    roundNumber: brief.roundNumber,
    operation: "assess",
  });
  const assessment = await deps.judge
    .assessRound(
      {
        roundNumber: brief.roundNumber,
        critiques,
        failures,
      },
      (resolved) => {
        assessModel = resolved;
      },
    )
    .then((result) => {
      deps.logger?.event({
        type: "council.baml.completed",
        timestamp: timestamp(),
        runId,
        roundNumber: brief.roundNumber,
        operation: "assess",
        model: assessModel,
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
        model: assessModel,
        durationMs: performance.now() - assessStartedAt,
        error: errorMessage(error),
      });
      throw error;
    });

  const round: DecisionCouncilRound = {
    brief,
    personaSelection: {
      personaIds: selection.personaSet.personas.map((persona) => persona.id),
      rationale: selection.rationale,
    },
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
  let reportModel: string | undefined;
  deps.logger?.event({
    type: "council.baml.started",
    timestamp: timestamp(),
    runId,
    operation: "report",
  });
  const finalReport = await deps.judge
    .createFinalReport(
      {
        critiques: allCritiques,
        assessments,
        failures: allFailures,
      },
      (resolved) => {
        reportModel = resolved;
      },
    )
    .then((result) => {
      deps.logger?.event({
        type: "council.baml.completed",
        timestamp: timestamp(),
        runId,
        operation: "report",
        model: reportModel,
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
        model: reportModel,
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
