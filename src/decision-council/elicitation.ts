/**
 * Elicitation seam: how a Run obtains answers to the clarifying questions a BAML
 * reasoning step emits. The orchestrator asks; the source answers. See ADR 0003/0004.
 *
 * `SkipSource` is the deny-by-default source: it answers nothing, so a Run with
 * elicitation disabled behaves exactly as it does today (every question recorded as
 * unanswered, control flow unchanged).
 */

export type ElicitationQuestion = {
  id: string;
  text: string;
  choices?: string[];
  importance?: "blocking" | "optional";
};

export type ElicitationRequest = {
  runId: string;
  roundNumber: number;
  questions: ElicitationQuestion[];
};

export type ElicitationAnsweredBy = "context" | "human" | "unanswered";

export type ElicitationAnswer = {
  questionId: string;
  answeredBy: ElicitationAnsweredBy;
  answer?: string;
  confidence?: number;
  rationale?: string;
};

export interface ElicitationSource {
  resolve(request: ElicitationRequest): Promise<ElicitationAnswer[]>;
}

export class SkipSource implements ElicitationSource {
  async resolve(request: ElicitationRequest): Promise<ElicitationAnswer[]> {
    return request.questions.map((question) => ({
      questionId: question.id,
      answeredBy: "unanswered",
    }));
  }
}
