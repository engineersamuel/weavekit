/**
 * HITL example (Copilot SDK + Telegram).
 *
 * Prompt: ask Copilot to use ask_user to ask what you want for dinner as a main
 * course, then recommend the best side dishes for that main course.
 *
 * Flow: Copilot SDK session -> agent ask_user -> onUserInputRequest -> Telegram
 * force-reply question -> wait for your Telegram reply -> return answer to SDK ->
 * send Copilot's final recommendation back to Telegram.
 *
 * Usage:
 *   set -a; source ./.env; set +a; nub scripts/dinner-hitl-copilot.ts
 *
 * Needs: TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID in .env, and a working
 * Copilot SDK/CLI environment. Optional: [copilot].model in ~/.weavekit/config.toml
 * (default gpt-5-mini).
 */

import { pathToFileURL } from "node:url";
import { CopilotClient } from "@github/copilot-sdk";
import { loadTypedWeavekitConfig } from "../src/config.js";
import { TelegramClient } from "../src/telegram/client.js";
import { TelegramInquiry } from "../src/telegram/inquiry.js";
import { InquiryRegistry } from "../src/telegram/inquiryRegistry.js";
import { startPoller } from "../src/telegram/poller.js";

const REPLY_TIMEOUT_MS = 10 * 60_000;
const SESSION_TIMEOUT_MS = 12 * 60_000;

type UserInputRequest = {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
};

type UserInputResponse = {
  answer: string;
  wasFreeform: boolean;
};

type CopilotSession = {
  sendAndWait(
    message: { prompt: string },
    timeout?: number,
  ): Promise<{ data?: { content?: string } } | null | undefined>;
  disconnect(): Promise<void>;
};

export function buildTelegramQuestion(request: UserInputRequest): string {
  const parts = [request.question.trim()];
  if (request.choices && request.choices.length > 0) {
    parts.push(
      `Choices:\n${request.choices.map((choice, index) => `${index + 1}. ${choice}`).join("\n")}`,
    );
    parts.push(
      request.allowFreeform === false
        ? "Reply with one of the choices."
        : "Reply with a choice or your own answer.",
    );
  }
  return parts.join("\n\n");
}

export function createUserInputResponse(
  answer: string,
  choices: string[] | undefined,
): UserInputResponse {
  const trimmed = answer.trim();
  return {
    answer: trimmed,
    wasFreeform: !(choices ?? []).some((choice) => choice === trimmed),
  };
}

export function parseOwnerChatId(raw: string | undefined): number {
  if (!raw) {
    throw new Error("Need TELEGRAM_OWNER_CHAT_ID in .env.");
  }
  const chatId = Number(raw);
  if (!Number.isFinite(chatId)) {
    throw new Error("TELEGRAM_OWNER_CHAT_ID must be a number.");
  }
  return chatId;
}

async function skipBacklog(client: TelegramClient): Promise<number> {
  const updates = await client.getUpdates(-1, 0);
  const last = updates.at(-1);
  return last ? last.update_id + 1 : 0;
}

async function main(): Promise<void> {
  const config = loadTypedWeavekitConfig();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("Need TELEGRAM_BOT_TOKEN in .env.");
    process.exitCode = 1;
    return;
  }

  let chatId: number;
  try {
    chatId = parseOwnerChatId(process.env.TELEGRAM_OWNER_CHAT_ID);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const telegram = new TelegramClient(token);
  const inquiry = new TelegramInquiry(telegram, chatId, new InquiryRegistry());
  const startOffset = await skipBacklog(telegram);
  const poller = startPoller(telegram, (update) => inquiry.handleUpdate(update), { startOffset });
  const copilot = new CopilotClient();
  let session: CopilotSession | undefined;

  try {
    await copilot.start();
    session = (await copilot.createSession({
      model: config.copilot.model ?? "gpt-5-mini",
      onPermissionRequest: () => ({
        kind: "denied-interactively-by-user",
        feedback: "This example only allows ask_user.",
      }),
      onUserInputRequest: async (request: UserInputRequest) => {
        const question = buildTelegramQuestion(request);
        console.log(`Copilot asked: ${request.question}`);
        const answer = await inquiry.ask(`${question}\n\n(long-press this message -> Reply)`, {
          timeoutMs: REPLY_TIMEOUT_MS,
        });
        return createUserInputResponse(answer, request.choices);
      },
    })) as CopilotSession;

    await telegram.sendMessage(
      chatId,
      "Starting Copilot dinner planner. It will ask you a question here.",
    );
    const response = await session.sendAndWait(
      {
        prompt:
          "Use ask_user to ask what I want for dinner as a main course. " +
          "After I answer, recommend the three best side dishes for that main course. " +
          "For each side dish, include a short one-line reason it pairs well. " +
          "Keep the final response under 120 words and suitable for Telegram.",
      },
      SESSION_TIMEOUT_MS,
    );

    const finalText = response?.data?.content?.trim();
    if (!finalText) {
      throw new Error("Copilot returned no final dinner recommendation.");
    }

    await telegram.sendMessage(chatId, `\u{1F957} Copilot dinner sides:\n\n${finalText}`);
    console.log("Sent Copilot side-dish suggestions. Done.");
  } finally {
    try {
      await session?.disconnect();
    } finally {
      const stopErrors = await copilot.stop();
      for (const err of stopErrors) {
        console.error(`Copilot cleanup error: ${err.message}`);
      }
      poller.stop();
      await poller.done;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
