import { describe, expect, it } from "vitest";
import { InquiryRegistry } from "../../src/telegram/inquiryRegistry.js";
import { TelegramInquiry, type MessageSender } from "../../src/telegram/inquiry.js";
import type { TelegramUpdate } from "../../src/telegram/update.js";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeSender(startId = 100) {
  let nextId = startId;
  const sent: Array<{ chatId: number; text: string; forceReply?: boolean }> = [];
  const sender: MessageSender = {
    async sendMessage(chatId, text, opts) {
      sent.push({ chatId, text, forceReply: opts?.forceReply });
      return { message_id: nextId++ };
    },
  };
  return { sender, sent };
}

function replyUpdate(text: string, replyTo: number, chatId: number): TelegramUpdate {
  return {
    update_id: replyTo,
    message: { text, chat: { id: chatId }, reply_to_message: { message_id: replyTo } },
  };
}

describe("TelegramInquiry", () => {
  it("sends each question with force_reply", () => {
    const { sender, sent } = fakeSender();
    const inquiry = new TelegramInquiry(sender, 42, new InquiryRegistry());

    void inquiry.ask("Main course?");

    expect(sent).toEqual([{ chatId: 42, text: "Main course?", forceReply: true }]);
  });

  it("routes two concurrent questions to the right awaiters by reply target", async () => {
    const { sender } = fakeSender(100); // ids 100, then 101
    const inquiry = new TelegramInquiry(sender, 42, new InquiryRegistry());

    const a = inquiry.ask("A: main course?"); // message_id 100
    const b = inquiry.ask("B: main course?"); // message_id 101
    await tick();

    // Reply to B first, then A — correlation must not depend on order.
    inquiry.handleUpdate(replyUpdate("ribeye", 101, 42));
    inquiry.handleUpdate(replyUpdate("salmon", 100, 42));

    expect(await a).toBe("salmon");
    expect(await b).toBe("ribeye");
  });

  it("ignores replies from a different chat", async () => {
    const registry = new InquiryRegistry();
    const { sender } = fakeSender(100);
    const inquiry = new TelegramInquiry(sender, 42, registry);

    void inquiry.ask("Main course?"); // 100
    await tick();
    inquiry.handleUpdate(replyUpdate("from elsewhere", 100, 999));

    expect(registry.pendingCount).toBe(1);
  });

  it("rejects and unregisters when no reply arrives before the timeout", async () => {
    const registry = new InquiryRegistry();
    const { sender } = fakeSender(100);
    const inquiry = new TelegramInquiry(sender, 42, registry);

    await expect(inquiry.ask("Main course?", { timeoutMs: 10 })).rejects.toThrow(/Timed out/);
    expect(registry.pendingCount).toBe(0);
  });

  it("clears the timeout when a reply arrives in time", async () => {
    const registry = new InquiryRegistry();
    const { sender } = fakeSender(100);
    const inquiry = new TelegramInquiry(sender, 42, registry);

    const answer = inquiry.ask("Main course?", { timeoutMs: 1000 });
    await tick();
    inquiry.handleUpdate(replyUpdate("salmon", 100, 42));

    expect(await answer).toBe("salmon");
    expect(registry.pendingCount).toBe(0);
  });
});
