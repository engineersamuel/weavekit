/**
 * Minimal Telegram update shapes and a pure parser that turns an update into a routable reply.
 * Only the fields we need are modelled; the full Bot API Update is much larger.
 */

export type TelegramMessage = {
  message_id?: number;
  text?: string;
  chat: { id: number };
  reply_to_message?: { message_id: number };
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export type ReplyEnvelope = {
  chatId: number;
  replyToMessageId: number;
  text: string;
};

/**
 * Returns the routable reply carried by an update, or null when the update is not a usable
 * text reply (not a reply, no text, or no message at all).
 */
export function extractReply(update: TelegramUpdate): ReplyEnvelope | null {
  const message = update.message;
  if (!message?.text || !message.reply_to_message) return null;
  return {
    chatId: message.chat.id,
    replyToMessageId: message.reply_to_message.message_id,
    text: message.text.trim(),
  };
}
