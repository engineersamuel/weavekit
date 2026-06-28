import { describe, expect, it } from "vitest";
import { extractReply, type TelegramUpdate } from "../../src/telegram/update.js";

function reply(text: string, replyToMessageId: number, chatId = 5): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      text,
      chat: { id: chatId },
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}

describe("extractReply", () => {
  it("extracts chat id, replied-to message id, and trimmed text from a reply", () => {
    expect(extractReply(reply("  salmon  ", 100, 42))).toEqual({
      chatId: 42,
      replyToMessageId: 100,
      text: "salmon",
    });
  });

  it("returns null for a message that is not a reply", () => {
    const update: TelegramUpdate = {
      update_id: 2,
      message: { text: "hi", chat: { id: 5 } },
    };

    expect(extractReply(update)).toBeNull();
  });

  it("returns null for a reply with no text (e.g. a sticker)", () => {
    const update: TelegramUpdate = {
      update_id: 3,
      message: { chat: { id: 5 }, reply_to_message: { message_id: 100 } },
    };

    expect(extractReply(update)).toBeNull();
  });

  it("returns null for an update with no message (e.g. a callback query)", () => {
    expect(extractReply({ update_id: 4 })).toBeNull();
  });
});
