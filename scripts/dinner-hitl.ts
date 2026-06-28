/**
 * HITL example (Telegram).
 *
 * Prompt: "Ask me what I want for dinner as a main course, then suggest the best side
 * dishes to go with that main course."
 *
 * Flow: send a question to Telegram -> wait (long-poll) for your reply -> ask the model for
 * the best side dishes for that main course -> send them back. A complete human-in-the-loop
 * round trip: ask -> wait for a human -> continue with the answer -> deliver.
 *
 * Usage:
 *   set -a; source ./.env; set +a; nub scripts/dinner-hitl.ts
 *
 * Needs: TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID in .env, and the model proxy
 * (COPILOT_PROXY_BASE_URL, default http://127.0.0.1:8080/v1).
 */

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
const proxyBase = (process.env.COPILOT_PROXY_BASE_URL ?? "http://127.0.0.1:8080/v1").replace(/\/$/, "");
const proxyKey = process.env.COPILOT_PROXY_API_KEY ?? "anything";
const model = process.env.BAML_MODEL ?? "gpt-5-mini";

type TgResponse<T> = { ok: boolean; result?: T; error_code?: number; description?: string };
type TgUpdate = { update_id: number; message?: { text?: string; chat: { id: number } } };

async function tg<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as TgResponse<T>;
  if (!json.ok || json.result === undefined) {
    throw new Error(`${method} failed: ${json.error_code ?? "?"} ${json.description ?? ""}`.trim());
  }
  return json.result;
}

async function send(text: string): Promise<void> {
  await tg("sendMessage", { chat_id: Number(chatId), text });
}

/** Long-poll getUpdates from `offset` until the owner sends a text reply (or timeout). */
async function waitForReply(offset: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let cursor = offset;
  while (Date.now() < deadline) {
    const updates = await tg<TgUpdate[]>("getUpdates", { offset: cursor, timeout: 25 });
    for (const update of updates) {
      cursor = update.update_id + 1;
      const message = update.message;
      if (message?.text && String(message.chat.id) === String(chatId)) {
        return message.text.trim();
      }
    }
  }
  throw new Error("Timed out waiting for a reply on Telegram.");
}

async function suggestSides(mainCourse: string): Promise<string> {
  const res = await fetch(`${proxyBase}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${proxyKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a thoughtful chef. Given a main course, suggest the three best side dishes. " +
            "For each, give the dish name and a short one-line reason it pairs well. Keep it under 120 words.",
        },
        { role: "user", content: `Main course: ${mainCourse}` },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`model proxy ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content?.trim() ?? "(no suggestion returned)";
}

/** Skip any backlog (e.g. your earlier 'hi') so we only react to a new reply. */
async function currentOffset(): Promise<number> {
  const updates = await tg<TgUpdate[]>("getUpdates", { offset: -1 });
  const last = updates.at(-1);
  return last ? last.update_id + 1 : 0;
}

async function main(): Promise<void> {
  if (!token || !chatId) {
    console.error("Need TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID in .env.");
    process.exitCode = 1;
    return;
  }

  const offset = await currentOffset();

  await send("\u{1F37D}\uFE0F What would you like for dinner as a main course?");
  console.log("Asked on Telegram. Waiting for your reply (up to 5 min)\u2026");

  const mainCourse = await waitForReply(offset, 5 * 60_000);
  console.log(`Main course: ${mainCourse}`);
  await send(`Great \u2014 ${mainCourse}. Picking the best sides\u2026`);

  let sides: string;
  try {
    sides = await suggestSides(mainCourse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await send(`I couldn't reach the model (${message}). Is the proxy running on ${proxyBase}?`);
    throw err;
  }

  await send(`\u{1F957} Best sides for ${mainCourse}:\n\n${sides}`);
  console.log("Sent side-dish suggestions. Done.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
