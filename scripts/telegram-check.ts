/**
 * One-off Telegram bot setup check (no dependencies; uses global fetch).
 *
 * Usage — loads the gitignored .env so the token never appears on the command line:
 *   set -a; source ./.env; set +a; nub scripts/telegram-check.ts
 *
 * - Validates TELEGRAM_BOT_TOKEN via getMe.
 * - With TELEGRAM_OWNER_CHAT_ID set: sends a test message (full round-trip).
 * - Without it: lists chats from getUpdates so you can find your chat id
 *   (message the bot once first, then re-run).
 *
 * The token is never printed.
 */

type TelegramChat = {
  id: number;
  type: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
};

const token = process.env.TELEGRAM_BOT_TOKEN;
const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID;

async function call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as TelegramResponse<T>;
  if (!json.ok || json.result === undefined) {
    throw new Error(`${method} failed: ${json.error_code ?? "?"} ${json.description ?? ""}`.trim());
  }
  return json.result;
}

type Update = {
  message?: { chat: TelegramChat };
  channel_post?: { chat: TelegramChat };
  edited_message?: { chat: TelegramChat };
};

async function main(): Promise<void> {
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set. Add it to .env and re-run.");
    process.exitCode = 1;
    return;
  }

  const me = await call<{ id: number; username?: string }>("getMe");
  console.log(`\u2713 Token valid. Bot: @${me.username ?? "?"} (id ${me.id})`);

  if (ownerChatId) {
    await call<unknown>("sendMessage", {
      chat_id: Number(ownerChatId),
      text: "\u2705 weavekit Telegram check \u2014 this chat is wired up.",
    });
    console.log(`\u2713 Sent a test message to chat ${ownerChatId}. Check Telegram.`);
    return;
  }

  const updates = await call<Update[]>("getUpdates");
  const chats = new Map<number, TelegramChat>();
  for (const update of updates) {
    const chat = (update.message ?? update.channel_post ?? update.edited_message)?.chat;
    if (chat) chats.set(chat.id, chat);
  }

  if (chats.size === 0) {
    console.log("No chats yet. In Telegram, send your bot any message (e.g. 'hi'), then re-run.");
    return;
  }

  console.log("Found chats \u2014 add the right id to .env as TELEGRAM_OWNER_CHAT_ID:");
  for (const [id, chat] of chats) {
    const who = chat.username
      ? `@${chat.username}`
      : [chat.first_name, chat.last_name].filter(Boolean).join(" ");
    console.log(`  chat_id ${id}  (${chat.type}${who ? `, ${who}` : ""})`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
