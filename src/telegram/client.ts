import type { MessageSender } from "./inquiry.js";
import type { UpdateSource } from "./poller.js";
import type { TelegramUpdate } from "./update.js";

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
};

/**
 * Thin Telegram Bot API client over global fetch. Implements both MessageSender (outbound
 * questions with force_reply) and UpdateSource (a single long-poll consumer), so one client
 * instance powers both halves of the human-in-the-loop bridge. The token is never logged.
 */
export class TelegramClient implements MessageSender, UpdateSource {
  constructor(private readonly token: string) {}

  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json()) as TelegramApiResponse<T>;
    if (!json.ok || json.result === undefined) {
      throw new Error(
        `${method} failed: ${json.error_code ?? "?"} ${json.description ?? ""}`.trim(),
      );
    }
    return json.result;
  }

  async sendMessage(
    chatId: number,
    text: string,
    opts: { forceReply?: boolean } = {},
  ): Promise<{ message_id: number }> {
    return this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      ...(opts.forceReply ? { reply_markup: { force_reply: true } } : {}),
    });
  }

  async getUpdates(
    offset: number,
    timeoutSec: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>("getUpdates", { offset, timeout: timeoutSec }, signal);
  }
}
