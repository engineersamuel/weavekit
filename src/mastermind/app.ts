import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";
import type { MastermindDefaults } from "../config.js";
import { mountLinearWebhook } from "./linear/channel.js";
import type { MastermindService } from "./service.js";
import type { MastermindStore } from "./store/store.js";

export function createMastermindApp(args: {
  config: MastermindDefaults;
  webhookSecret: string;
  store: MastermindStore;
  service: MastermindService;
}) {
  const app = new Hono();
  app.get("/health", (context) => context.json({ ok: true, service: "weavekit-mastermind" }));
  app.get("/ready", (context) =>
    args.service.isReady() ? context.json({ ready: true }) : context.json({ ready: false }, 503),
  );
  mountLinearWebhook({
    app,
    config: args.config,
    webhookSecret: args.webhookSecret,
    store: args.store,
    onAccepted: (workId) => args.service.enqueue(workId),
  });
  app.route("/", flue());
  return app;
}
