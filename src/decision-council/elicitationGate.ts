import type { ElicitationAnswer, ElicitationSource } from "./elicitation.js";
import type { DecisionCouncilRunState, DecisionRoundAssessment } from "./types.js";

export type ElicitationGateResult = {
  state: DecisionCouncilRunState;
  answers: ElicitationAnswer[];
};

/**
 * The in-loop elicitation gate (ADR 0003/0004). When a round assessment requests human input,
 * resolve its clarifying questions through the configured source and fold any *answered* ones
 * into the run's input context so later rounds see them. Unanswered questions (e.g. SkipSource,
 * or a human skip/timeout) leave the state untouched, so a Run with elicitation off behaves
 * exactly as before.
 */
export async function applyElicitation(
  state: DecisionCouncilRunState,
  assessment: DecisionRoundAssessment,
  source: ElicitationSource,
  ctx: { runId: string; roundNumber: number },
): Promise<ElicitationGateResult> {
  const questions = assessment.clarifyingQuestions ?? [];
  if (!assessment.needsHumanInput || questions.length === 0) {
    return { state, answers: [] };
  }

  const answers = await source.resolve({
    runId: ctx.runId,
    roundNumber: ctx.roundNumber,
    questions,
  });

  const answeredContext = answers
    .filter(
      (answer) =>
        answer.answeredBy !== "unanswered" &&
        typeof answer.answer === "string" &&
        answer.answer.length > 0,
    )
    .map((answer) => `Clarification (${answer.questionId}): ${answer.answer}`);

  if (answeredContext.length === 0) {
    return { state, answers };
  }

  return {
    state: {
      ...state,
      input: { ...state.input, context: [...state.input.context, ...answeredContext] },
    },
    answers,
  };
}
