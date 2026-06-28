import { InquiryRegistry } from "./inquiryRegistry.js";
import { extractReply, type TelegramUpdate } from "./update.js";

/** The slice of a Telegram client that TelegramInquiry needs (kept narrow for testability). */
export interface MessageSender {
  sendMessage(
    chatId: number,
    text: string,
    opts?: { forceReply?: boolean },
  ): Promise<{ message_id: number }>;
}

/**
 * Asks a human a question over Telegram and waits for their reply, with correlation so many
 * questions can be in flight at once. Each question is sent with force_reply; the resulting
 * message id is the correlation key. A single poller feeds inbound updates to `handleUpdate`,
 * which routes each reply to the matching pending `ask`.
 */
export class TelegramInquiry {
  constructor(
    private readonly sender: MessageSender,
    private readonly chatId: number,
    private readonly registry: InquiryRegistry = new InquiryRegistry(),
  ) {}

  /**
   * Ask a question and resolve with the human's reply. If `timeoutMs` is given and no reply
   * arrives in time, the pending question is forgotten and the promise rejects — the caller can
   * then treat it as unanswered/skipped (ADR 0004's skip-or-timeout layer).
   */
  async ask(text: string, opts: { timeoutMs?: number } = {}): Promise<string> {
    const sent = await this.sender.sendMessage(this.chatId, text, { forceReply: true });
    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.registry.unregister(sent.message_id);
          reject(new Error(`Timed out waiting for a reply after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
        timer.unref?.();
      }
      this.registry.register(sent.message_id, (answer) => {
        if (timer) clearTimeout(timer);
        resolve(answer);
      });
    });
  }

  /** Route one inbound update; replies to our chat that match a pending question resolve it. */
  handleUpdate(update: TelegramUpdate): void {
    const reply = extractReply(update);
    if (!reply || reply.chatId !== this.chatId) return;
    this.registry.resolveReply(reply.replyToMessageId, reply.text);
  }
}
