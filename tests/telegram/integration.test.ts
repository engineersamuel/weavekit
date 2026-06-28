import { describe, expect, it } from "vitest";
import { InquiryRegistry } from "../../src/telegram/inquiryRegistry.js";
import { TelegramInquiry, type MessageSender } from "../../src/telegram/inquiry.js";
import { startPoller, type UpdateSource } from "../../src/telegram/poller.js";
import type { TelegramUpdate } from "../../src/telegram/update.js";

const CHAT = 42;

/**
 * A fake client that is both the outbound sender and the inbound update source. It records the
 * message ids it hands out, then — once both questions have been sent — delivers one reply per
 * question (replying to the SECOND question first, to prove order independence).
 */
class FakeClient implements MessageSender, UpdateSource {
  readonly sentIds: number[] = [];
  private nextId = 100;
  private delivered = false;

  async sendMessage(_chatId: number, _text: string): Promise<{ message_id: number }> {
    const id = this.nextId++;
    this.sentIds.push(id);
    return { message_id: id };
  }

  async getUpdates(): Promise<TelegramUpdate[]> {
    await new Promise((resolve) => setTimeout(resolve, 1)); // yield so registrations land
    if (this.sentIds.length >= 2 && !this.delivered) {
      this.delivered = true;
      const [first, second] = this.sentIds;
      return [
        { update_id: 1, message: { text: "ribeye", chat: { id: CHAT }, reply_to_message: { message_id: second! } } },
        { update_id: 2, message: { text: "salmon", chat: { id: CHAT }, reply_to_message: { message_id: first! } } },
      ];
    }
    return [];
  }
}

describe("telegram HITL pipeline (poller + inquiry + registry)", () => {
  it("routes two parallel questions to their correct answers via the single poller", async () => {
    const client = new FakeClient();
    const inquiry = new TelegramInquiry(client, CHAT, new InquiryRegistry());
    const poller = startPoller(client, (update) => inquiry.handleUpdate(update), {
      startOffset: 0,
      longPollSec: 0,
    });

    const [answerA, answerB] = await Promise.all([inquiry.ask("A: main course?"), inquiry.ask("B: main course?")]);

    poller.stop();
    await poller.done;

    expect(answerA).toBe("salmon"); // first question, answered by the reply to message id 100
    expect(answerB).toBe("ribeye"); // second question, answered by the reply to message id 101
  });
});
