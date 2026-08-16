import { z } from "zod";

const QUESTION_ENVELOPE_OPEN = '<trellage_questions version="1">';
const QUESTION_ENVELOPE_CLOSE = "</trellage_questions>";
const ANSWER_ENVELOPE_OPEN = '<trellage_answers version="1">';
const ANSWER_ENVELOPE_CLOSE = "</trellage_answers>";

const TrellageQuestionSchema = z.object({
  id: z.string().trim().min(1),
  text: z.string().trim().min(1),
  choices: z.array(z.string().trim().min(1)).min(1).optional(),
  reason: z.string().trim().min(1).optional(),
});

const TrellageQuestionsSchema = z.object({
  questions: z.array(TrellageQuestionSchema).min(1),
});

export type TrellageQuestion = z.infer<typeof TrellageQuestionSchema>;

export type TrellageQuestionParseResult =
  | { kind: "none" }
  | { kind: "questions"; questions: TrellageQuestion[]; source: "envelope" | "legacy" }
  | { kind: "malformed"; error: string };

export type TrellageAnswer = {
  id: string;
  answer: string;
};

/**
 * Parses only the versioned clarification protocol before semantic diagnosis starts.
 *
 * One valid envelope takes priority over surrounding prose. Live harnesses can add completion
 * text around a requested exact response; treating the explicit question as authoritative is
 * safer than losing the clarification and is still deterministic.
 */
export function parseTrellageQuestions(text: string): TrellageQuestionParseResult {
  const envelopes = [
    ...text.matchAll(
      /<trellage_questions\s+version=(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/trellage_questions>/gu,
    ),
  ];
  if (envelopes.length > 1) {
    return { kind: "malformed", error: "Multiple trellage question envelopes were returned." };
  }
  if (envelopes.length === 1) {
    const envelope = envelopes[0]!;
    const version = envelope[1] ?? envelope[2];
    if (version !== "1") {
      return {
        kind: "malformed",
        error: `Unsupported trellage question envelope version "${version}".`,
      };
    }
    try {
      const parsed = TrellageQuestionsSchema.safeParse(JSON.parse(envelope[3] ?? ""));
      if (!parsed.success) {
        return {
          kind: "malformed",
          error: `Invalid trellage question payload: ${parsed.error.issues
            .map((issue) => issue.message)
            .join("; ")}`,
        };
      }
      const ids = new Set<string>();
      for (const question of parsed.data.questions) {
        if (ids.has(question.id)) {
          return { kind: "malformed", error: `Duplicate trellage question id "${question.id}".` };
        }
        ids.add(question.id);
      }
      return { kind: "questions", questions: parsed.data.questions, source: "envelope" };
    } catch {
      return { kind: "malformed", error: "Invalid JSON in trellage question envelope." };
    }
  }

  const legacy = /^NEEDS:\s*(.+)$/u.exec(text.trim());
  if (legacy) {
    return {
      kind: "questions",
      questions: [{ id: "legacy-1", text: legacy[1]!.trim() }],
      source: "legacy",
    };
  }
  return { kind: "none" };
}

export function formatTrellageAnswers(answers: readonly TrellageAnswer[]): string {
  return [
    ANSWER_ENVELOPE_OPEN,
    JSON.stringify({ answers }),
    ANSWER_ENVELOPE_CLOSE,
    "Continue the delegated task. Do not ask the same question again. If more information is required, end the turn with only a valid trellage_questions envelope.",
  ].join("\n");
}

export function buildTrellageHeadlessPrompt(prompt: string): string {
  return `${prompt.trim()}

<trellage_headless_protocol>
This is a non-interactive RLM delegation. Do not invoke AskUserQuestion, ask_user, or any equivalent question tool.
If required information is missing, do not guess and do not claim completion. End the turn with only this exact versioned envelope:
${QUESTION_ENVELOPE_OPEN}
{"questions":[{"id":"q1","text":"Question text","choices":["optional choice"],"reason":"Why this is required"}]}
${QUESTION_ENVELOPE_CLOSE}
If no clarification is required, complete the task and return the normal final result without this envelope.
</trellage_headless_protocol>`;
}
