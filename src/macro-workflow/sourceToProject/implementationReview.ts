import { b, type ImplementationReviewVerdict } from "../../generated/baml_client/index.js";

type ReviewPromptInput = {
  implementationSummary: string;
  verificationSummary: string;
  priorVerdict?: ImplementationReviewVerdict;
};

type ResponsesRequestBody = {
  input: Array<{
    role: string;
    content: Array<{
      type: string;
      text: string;
    }>;
  }>;
};

export async function buildImplementationReviewPrompt(input: ReviewPromptInput): Promise<string> {
  const request = await b.request.ReviewImplementation(
    input.implementationSummary,
    input.verificationSummary,
    input.priorVerdict ?? null,
  );
  const body = request.body.json() as ResponsesRequestBody;
  const prompt = body.input
    .map(({ role, content }) => {
      const text = content
        .filter((item) => item.type === "input_text")
        .map((item) => item.text.trim())
        .filter(Boolean)
        .join("\n");

      return text ? `${role.toUpperCase()}:\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  if (!prompt) {
    throw new Error("BAML ReviewImplementation request did not render a prompt.");
  }

  return prompt;
}

export function parseImplementationReviewVerdict(raw: string): ImplementationReviewVerdict {
  const verdict = b.parse.ReviewImplementation(raw);

  if (verdict.status === "accepted" && verdict.blockingFindings.length > 0) {
    throw new Error("Implementation review accepted verdict cannot contain blocking findings.");
  }
  if (
    verdict.status === "needs_changes" &&
    (verdict.blockingFindings.length === 0 ||
      verdict.blockingFindings.some((finding) => finding.trim().length === 0))
  ) {
    throw new Error("Implementation review needs_changes verdict must contain blocking findings.");
  }

  return verdict;
}
