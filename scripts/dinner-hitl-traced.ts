/**
 * HITL example — instrumented + correlation-keyed (the production-shaped version).
 *
 * Improves on scripts/dinner-hitl.ts in the two ways that demo lacked:
 *   1. OTEL/Langfuse: a span tree (root -> per-flow -> await-human + suggest-sides generation)
 *      exported via the repo's telemetry bootstrap. Set LANGFUSE_* keys to export; set
 *      LANGFUSE_EXPORT_RAW=true to see prompt/answer content (otherwise it is masked).
 *   2. Correlation under concurrency: ONE getUpdates poller (Telegram allows only one consumer
 *      per bot) plus force_reply correlation, so MULTIPLE questions can be in flight at once and
 *      each reply routes to the right waiter. This script proves it by running two dinner flows
 *      in parallel — you reply to each question (long-press -> Reply) and the answers are matched
 *      by reply_to_message.message_id, never by guesswork.
 *
 * Usage:
 *   set -a; source ./.env; set +a; nub scripts/dinner-hitl-traced.ts
 *
 * Needs: TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID in .env, the model proxy
 * (COPILOT_PROXY_BASE_URL, default http://127.0.0.1:8080/v1), and (optional) LANGFUSE_* keys.
 */

import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { startTelemetry, telemetryEnabled } from "../src/telemetry/bootstrap.js";
import { TelegramClient } from "../src/telegram/client.js";
import { InquiryRegistry } from "../src/telegram/inquiryRegistry.js";
import { TelegramInquiry } from "../src/telegram/inquiry.js";
import { startPoller } from "../src/telegram/poller.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_OWNER_CHAT_ID
  ? Number(process.env.TELEGRAM_OWNER_CHAT_ID)
  : undefined;
const proxyBase = (process.env.COPILOT_PROXY_BASE_URL ?? "http://127.0.0.1:8080/v1").replace(
  /\/$/,
  "",
);
const proxyKey = process.env.COPILOT_PROXY_API_KEY ?? "anything";

// Spans from the "weavekit" tracer are exported to Langfuse by the repo's bootstrap.
const tracer = trace.getTracer("weavekit");
const REPLY_TIMEOUT_MS = 10 * 60_000;

function setJson(span: Span, key: string, value: unknown): void {
  span.setAttribute(key, JSON.stringify(value));
}

async function suggestSides(mainCourse: string): Promise<{ text: string; model: string }> {
  const requestedModel = process.env.BAML_MODEL ?? "gpt-5-mini";
  const res = await fetch(`${proxyBase}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${proxyKey}` },
    body: JSON.stringify({
      model: requestedModel,
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
  const json = (await res.json()) as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
  };
  return {
    text: json.choices?.[0]?.message?.content?.trim() ?? "(no suggestion returned)",
    model: json.model ?? requestedModel,
  };
}

async function runDinnerFlow(
  inquiry: TelegramInquiry,
  client: TelegramClient,
  label: string,
): Promise<void> {
  await tracer.startActiveSpan(`dinner-flow.${label}`, async (span) => {
    span.setAttribute("langfuse.observation.type", "span");
    setJson(span, "langfuse.observation.input", { flow: label });
    try {
      // ---- await-human: ask over Telegram and block on the (correlated) reply ----
      let mainCourse: string;
      try {
        mainCourse = await tracer.startActiveSpan(`await-human.${label}`, async (askSpan) => {
          askSpan.setAttribute("langfuse.observation.type", "span");
          setJson(askSpan, "langfuse.observation.input", `[${label}] main course?`);
          try {
            const answer = await inquiry.ask(
              `\u{1F37D}\uFE0F [${label}] What would you like as a main course?\n(long-press this message \u2192 Reply)`,
              { timeoutMs: REPLY_TIMEOUT_MS },
            );
            setJson(askSpan, "langfuse.observation.output", answer);
            askSpan.setStatus({ code: SpanStatusCode.OK });
            return answer;
          } catch (waitErr) {
            askSpan.recordException(
              waitErr instanceof Error ? waitErr : new Error(String(waitErr)),
            );
            askSpan.setStatus({ code: SpanStatusCode.ERROR, message: "no reply" });
            throw waitErr;
          } finally {
            askSpan.end();
          }
        });
      } catch {
        // No reply in time: skip this flow cleanly (the human-may-skip layer of ADR 0004).
        await client.sendMessage(
          chatId!,
          `\u23ED\uFE0F [${label}] No reply in time \u2014 skipping.`,
        );
        span.setAttribute("weavekit.elicitation.answered", false);
        setJson(span, "langfuse.observation.output", { skipped: true, reason: "no-reply" });
        span.setStatus({ code: SpanStatusCode.OK });
        console.log(`[${label}] no reply \u2014 skipped`);
        return;
      }
      console.log(`[${label}] main course: ${mainCourse}`);
      span.setAttribute("weavekit.elicitation.answered", true);

      // ---- suggest-sides: model generation ----
      const sides = await tracer.startActiveSpan(`suggest-sides.${label}`, async (genSpan) => {
        genSpan.setAttribute("gen_ai.system", "copilot-proxy");
        genSpan.setAttribute("gen_ai.operation.name", "chat.completions");
        genSpan.setAttribute("langfuse.observation.type", "generation");
        setJson(genSpan, "langfuse.observation.input", mainCourse);
        try {
          const result = await suggestSides(mainCourse);
          genSpan.setAttribute("langfuse.observation.model", result.model);
          setJson(genSpan, "langfuse.observation.output", result.text);
          genSpan.setStatus({ code: SpanStatusCode.OK });
          return result.text;
        } catch (genErr) {
          genSpan.recordException(genErr instanceof Error ? genErr : new Error(String(genErr)));
          genSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: genErr instanceof Error ? genErr.message : String(genErr),
          });
          throw genErr;
        } finally {
          genSpan.end();
        }
      });

      await client.sendMessage(
        chatId!,
        `\u{1F957} [${label}] Best sides for ${mainCourse}:\n\n${sides}`,
      );
      setJson(span, "langfuse.observation.output", { mainCourse, sides });
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      span.recordException(err instanceof Error ? err : new Error(message));
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      console.error(`[${label}] error: ${message}`);
      try {
        await client.sendMessage(chatId!, `\u26A0\uFE0F [${label}] error: ${message}`);
      } catch {
        // best-effort notify only
      }
      // Do not rethrow: keep the parallel flow alive so one failure doesn't sink both.
    } finally {
      span.end();
    }
  });
}

/** Skip any backlog so we only react to new replies. */
async function skipBacklog(client: TelegramClient): Promise<number> {
  const updates = await client.getUpdates(-1, 0);
  const last = updates.at(-1);
  return last ? last.update_id + 1 : 0;
}

async function main(): Promise<void> {
  if (!token || chatId === undefined) {
    console.error("Need TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID in .env.");
    process.exitCode = 1;
    return;
  }

  const exporting =
    telemetryEnabled() &&
    Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
  console.log(
    exporting
      ? "Langfuse export: ON"
      : "Langfuse export: OFF (set LANGFUSE_PUBLIC_KEY/SECRET_KEY to enable)",
  );

  const telemetry = await startTelemetry("weavekit");
  const client = new TelegramClient(token);
  const inquiry = new TelegramInquiry(client, chatId, new InquiryRegistry());

  const startOffset = await skipBacklog(client);
  const poller = startPoller(client, (update) => inquiry.handleUpdate(update), { startOffset });

  try {
    await tracer.startActiveSpan("dinner-hitl-parallel", async (root) => {
      root.setAttribute("langfuse.trace.name", "dinner-hitl-parallel");
      const traceId = root.spanContext().traceId;
      console.log(`Trace id: ${traceId}`);
      console.log("Two questions sent to Telegram. Reply to BOTH (long-press each \u2192 Reply).");
      try {
        await Promise.all([
          runDinnerFlow(inquiry, client, "A"),
          runDinnerFlow(inquiry, client, "B"),
        ]);
        root.setStatus({ code: SpanStatusCode.OK });
      } finally {
        root.end();
      }
    });
    console.log("Both flows complete. Sides sent to Telegram.");
  } finally {
    poller.stop();
    await poller.done;
    await telemetry.shutdown();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
