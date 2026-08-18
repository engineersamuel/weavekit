import {
  b,
  type RlmDependencyReport,
  type RlmRunBrief,
  type RlmWorkerReport,
} from "../generated/baml_client/index.js";

const RLM_WORKER_RENDER_ENV = {
  COPILOT_PROXY_API_KEY: process.env.COPILOT_PROXY_API_KEY ?? "rlm-worker-contract-render-only",
} as const;

const RLM_BRIEF_DERIVATION_ENV = {
  COPILOT_PROXY_API_KEY: process.env.COPILOT_PROXY_API_KEY ?? "rlm-brief-derivation-local-proxy",
} as const;

type JsonObject = Record<string, unknown>;

export interface RlmWorkerContractInput {
  brief: RlmRunBrief;
  delegatedTask: string;
  dependencies: RlmDependencyReport[];
}

export interface RlmWorkerContract {
  renderPrompt(input: RlmWorkerContractInput): Promise<string>;
  parseResponse(raw: string): RlmWorkerReport;
  /**
   * Turns the raw root prompt into the enumerated acceptance contract shared by every worker in
   * the run. Optional so a caller supplying only the render/parse halves keeps the previous
   * objective-only brief.
   */
  deriveBrief?(rawObjective: string): Promise<RlmRunBrief>;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function readJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }

  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${label} to be a string.`);
  }

  return value;
}

function readMessages(body: unknown): JsonObject[] {
  const requestBody = readJsonObject(body, "BAML request body");
  const { messages } = requestBody;

  if (!Array.isArray(messages)) {
    throw new Error("Expected BAML request body to contain an OpenAI-compatible messages array.");
  }

  return messages.map((message, index) =>
    readJsonObject(message, `BAML message at index ${index}`),
  );
}

function extractUserPrompt(messages: JsonObject[]): string {
  const userMessages: string[] = [];

  for (const [index, message] of messages.entries()) {
    const role = readString(message.role, `BAML message role at index ${index}`);
    const { content } = message;

    if (Array.isArray(content)) {
      throw new Error(
        `Expected BAML message content at index ${index} to be a string, but received multimodal content.`,
      );
    }

    const text = readString(content, `BAML message content at index ${index}`);

    if (role === "user") {
      userMessages.push(text);
    }
  }

  if (userMessages.length === 0) {
    throw new Error("BAML request did not render a user message.");
  }

  if (userMessages.length > 1) {
    throw new Error("BAML request rendered multiple user messages.");
  }

  const prompt = userMessages[0]?.trim() ?? "";

  if (prompt.length === 0) {
    throw new Error("BAML request rendered an empty user prompt.");
  }

  return prompt;
}

async function renderRlmWorkerPrompt(input: RlmWorkerContractInput): Promise<string> {
  const request = await b.request.RenderRlmWorkerTask(
    input.brief,
    input.delegatedTask,
    input.dependencies,
    { env: RLM_WORKER_RENDER_ENV },
  );
  const body: unknown = request.body.json();

  return extractUserPrompt(readMessages(body));
}

export const bamlRlmWorkerContract: RlmWorkerContract = {
  renderPrompt: renderRlmWorkerPrompt,
  parseResponse(raw) {
    return b.parse.RenderRlmWorkerTask(raw);
  },
  async deriveBrief(rawObjective) {
    return await b.DeriveRlmRunBrief(rawObjective, { env: RLM_BRIEF_DERIVATION_ENV });
  },
};

/**
 * The objective-only brief. Used when no contract can derive one, and as the fail-open result when
 * derivation errors, so a proxy outage degrades brief quality instead of stopping the run.
 */
export function emptyRlmRunBrief(objective: string): RlmRunBrief {
  return { objective, constraints: [], acceptanceCriteria: [], validationCommands: [] };
}

/**
 * Derives the shared acceptance contract, then overlays any operator-supplied field.
 *
 * Derivation failure falls back to the objective-only brief: a brief improves worker input
 * quality and is never a precondition for starting the run. Derivation is skipped entirely when
 * the overrides already bind every list, so an operator who states the full contract pays nothing.
 */
export async function resolveRlmRunBrief(
  rawObjective: string,
  contract: RlmWorkerContract,
  overrides: Partial<RlmRunBrief> = {},
  onError: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): Promise<RlmRunBrief> {
  const fullyOverridden =
    overrides.constraints !== undefined &&
    overrides.acceptanceCriteria !== undefined &&
    overrides.validationCommands !== undefined;
  const base =
    fullyOverridden || !contract.deriveBrief
      ? emptyRlmRunBrief(rawObjective)
      : await deriveOrFallBack(rawObjective, contract.deriveBrief, onError);
  return {
    // The derived objective is the self-contained restatement workers receive in place of a raw,
    // possibly multi-paragraph prompt. Fallback keeps the raw text rather than nothing.
    objective: overrides.objective ?? base.objective,
    constraints: overrides.constraints ?? base.constraints,
    acceptanceCriteria: overrides.acceptanceCriteria ?? base.acceptanceCriteria,
    validationCommands: overrides.validationCommands ?? base.validationCommands,
  };
}

async function deriveOrFallBack(
  rawObjective: string,
  deriveBrief: (rawObjective: string) => Promise<RlmRunBrief>,
  onError: (message: string) => void,
): Promise<RlmRunBrief> {
  try {
    const brief = await deriveBrief(rawObjective);
    return brief.objective.trim().length > 0 ? brief : emptyRlmRunBrief(rawObjective);
  } catch (error) {
    onError(
      "[rlm] Run brief derivation failed; continuing with the objective only: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return emptyRlmRunBrief(rawObjective);
  }
}

export function formatRlmWorkerReportText(report: RlmWorkerReport): string {
  return report.summary.trim();
}
