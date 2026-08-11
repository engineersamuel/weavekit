import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import type { MastermindDefaults } from "../../config.js";
import type { MastermindStore } from "../store/store.js";

type LinearIssueWebhook = {
  action: string;
  type: string;
  organizationId: string;
  webhookId?: string;
  webhookTimestamp: number | string;
  data: {
    id: string;
  };
};

export function mountLinearWebhook(args: {
  app: Hono;
  config: MastermindDefaults;
  webhookSecret: string;
  store: MastermindStore;
  onAccepted(workId: string): void;
}): void {
  args.app.post(args.config.webhookPath, async (context) => {
    const rawBody = await context.req.text();
    if (
      !verifyLinearSignature(rawBody, context.req.header("linear-signature"), args.webhookSecret)
    ) {
      return context.json({ error: "Invalid Linear signature." }, 401);
    }

    let payload: LinearIssueWebhook;
    try {
      payload = JSON.parse(rawBody) as LinearIssueWebhook;
    } catch {
      return context.json({ error: "Invalid JSON." }, 400);
    }
    const validationError = validatePayload(payload, args.config, context);
    if (validationError) {
      return validationError;
    }
    if (payload.type !== "Issue" || !["create", "update"].includes(payload.action)) {
      return context.json({ accepted: false, ignored: true }, 202);
    }

    const deliveryId = context.req.header("linear-delivery");
    if (!deliveryId || !isUuid(deliveryId)) {
      return context.json({ error: "Missing or invalid Linear-Delivery header." }, 400);
    }
    const result = await args.store.ingestDelivery({
      deliveryId,
      organizationId: payload.organizationId,
      webhookId: payload.webhookId,
      eventType: payload.type,
      action: payload.action,
      issueId: payload.data.id,
    });
    if (!result.duplicate) {
      args.onAccepted(result.workId);
    }
    return context.json(
      { accepted: true, duplicate: result.duplicate, workId: result.workId },
      200,
    );
  });
}

export function verifyLinearSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !/^[a-f0-9]{64}$/iu.test(signature)) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validatePayload(
  payload: LinearIssueWebhook,
  config: MastermindDefaults,
  context: Context,
): Response | undefined {
  if (!payload?.data?.id || !payload.organizationId || !payload.webhookTimestamp) {
    return context.json({ error: "Incomplete Linear payload." }, 400);
  }
  if (config.linearOrganizationId && payload.organizationId !== config.linearOrganizationId) {
    return context.json({ error: "Unexpected Linear organization." }, 403);
  }
  if (config.linearWebhookId && payload.webhookId !== config.linearWebhookId) {
    return context.json({ error: "Unexpected Linear webhook." }, 403);
  }
  const timestamp = Number(payload.webhookTimestamp);
  const timestampMs = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 60_000) {
    return context.json({ error: "Expired Linear webhook." }, 401);
  }
  return undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
