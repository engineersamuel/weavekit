import {
  b,
  type RlmDependencyReport,
  type RlmRunBrief,
  type RlmWorkerReport,
} from "../generated/baml_client/index.js";

const RLM_WORKER_RENDER_ENV = {
  COPILOT_PROXY_API_KEY: process.env.COPILOT_PROXY_API_KEY ?? "rlm-worker-contract-render-only",
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
};

export function formatRlmWorkerReportText(report: RlmWorkerReport): string {
  return report.summary.trim();
}
