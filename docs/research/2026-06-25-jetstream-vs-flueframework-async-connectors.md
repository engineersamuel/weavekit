# NATS JetStream vs Flueframework for Async Event Connectors

Date: 2026-06-25

Research comparing **NATS JetStream** and **Flue (flueframework.com)** for handling
async incoming connections — specifically a connector for direct Microsoft Teams
messages and a connector for new TickTick todo items, piped downstream through either
**PI** or Flueframework.

## TL;DR

For "get Teams DMs and new TickTick todos into an AI agent that acts on them," **Flue
handles the async incoming connections far better** — it is the only one of the two
with actual connectors. JetStream is a message bus: it does not _grab_ events, it
_stores and distributes_ them, and only earns its place once you have multiple
consumers or serious volume. Reach for JetStream when the bus itself is the
requirement, not before.

## The key reframing: they are different layers

These are not the same category, and the "PI" in the question is part of the Flue stack:

- **NATS JetStream** = messaging/streaming **infrastructure** (a broker/bus). Durable
  streams, pub/sub, delivery guarantees, replay. It is transport + persistence. It has
  **no concept of agents and no SaaS connectors**.
- **Flue (flueframework.com)** = a TypeScript **AI-agent framework**. It is _"powered by
  Pi, the open agent harness"_ ([pi.dev](https://pi.dev), `earendil-works/pi`) — the
  same Pi referenced in the `superpowers` `pi-tools.md`. So **"PI" = Pi, the low-level
  harness; Flue = the batteries-included framework built on top of it.** "Pipe through
  PI vs Flue" = bare harness vs. full framework on one stack.

Conclusion: this is not strictly "A or B." **JetStream is a possible nervous system;
Flue/Pi is the brain.** They are complementary layers. The real decision is whether you
need the bus at all.

## Connector reality (identical constraints for both tools)

| Source                 | Push or poll?                                                                                                                    | Needs public HTTPS endpoint?                        | Auth                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Teams DMs**          | **Push** — Graph change notifications (`/chats/{id}/messages`, `/users/{id}/chats/getAllMessages`) _or_ a Bot Framework endpoint | **Yes** (either path)                               | Entra OAuth / Bot creds; RSC (`ChatMessage.Read.Chat`) to receive all DMs without @mention |
| **TickTick new todos** | **Poll only** — Open API has **no webhooks** (`GET /open/v1/project/{id}/data`, diff task IDs)                                   | No for polling; Yes only if bridged via Zapier/Make | OAuth2 bearer, scope `tasks:read`                                                          |

Gotchas that apply regardless of which tool you choose:

- Graph subscriptions **expire every 60 min** and need renewal + a validation handshake
  (echo `validationToken` as `text/plain` within 10s).
- Rich Teams message content needs a callback `GET` or `includeResourceData: true`
  (which adds payload encryption requirements).
- TickTick must be **polled and diffed** against last-seen task IDs; no event push exists
  in the official Open API (Dida365 shares the same surface in China).

## Side-by-side comparison

|                               | **JetStream**                                                                                                           | **Flue / Pi**                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Layer**                     | Event bus / persistence                                                                                                 | Agent app framework + harness                                                                                                                        |
| **Teams connector**           | Build a Bot/Graph webhook bridge yourself, then publish                                                                 | First-party `@flue/teams` **Channel** (Bot Connector ingress, JWT verify, `dispatch` -> agent)                                                       |
| **TickTick connector**        | Build a poller that publishes                                                                                           | No prebuilt connector, but sanctioned **Schedules** idiom (Cloudflare Cron / Croner / BullMQ) -> `dispatch`                                          |
| **HTTP/webhook ingress**      | None native (TCP / WebSocket / MQTT only) — bridge required                                                             | HTTP-native (Channels / Routing)                                                                                                                     |
| **Durability & replay**       | Streams, durable consumers, at-least-once + dedup window (default 2 min), replay from offset/time, work-queue retention | "Durable Streams" — per-agent-instance durable queue + replay (Cloudflare Durable Objects/SQLite; Node needs a sqlite/postgres `PersistenceAdapter`) |
| **Delivery guarantees**       | At-least-once; publisher-side dedup via `Nats-Msg-Id`; practical exactly-once via double-ack + idempotent sinks         | Conservative interruption recovery; app owns idempotency (`dispatchId`, activity IDs); Teams channel does NOT dedup                                  |
| **Fan-out to many consumers** | Excellent (queue groups, work-queue streams, polyglot)                                                                  | Oriented around feeding agent instances, not a general multi-consumer bus                                                                            |
| **Ops footprint**             | Single Go binary, clustering, self-host or Synadia Cloud                                                                | Deploy to Node.js, Cloudflare Workers, GitHub/GitLab CI, Vercel, Fly.io, Render                                                                      |
| **Languages**                 | Polyglot, 40+ client languages                                                                                          | TypeScript                                                                                                                                           |
| **Maturity**                  | CNCF **Incubating**, Apache-2.0, battle-tested, large community                                                         | **1.0 Beta**, very new, docs partly "AI-generated, awaiting review"; Pi is a young minimal harness                                                   |
| **Best at**                   | High-volume, polyglot, decoupled event backbone                                                                         | Rapidly building an AI agent that _acts on_ events                                                                                                   |

## Recommendation by scope

### 1. Personal "second-brain" automation (most likely case): use Flue (on Pi); skip JetStream

Teams DM + new TickTick todo -> one agent that triages/acts. Flue **directly handles the
async incoming connections**:

- Teams: the first-party `@flue/teams` **Channel** is the ingress (Azure Bot messaging
  endpoint -> `/channels/teams/activities`, JWT/tenant verification, OAuth, outbound tool).
- TickTick: a **Schedule** (Cloudflare Cron / Croner / BullMQ) polls and diffs, then
  `dispatch()` pipes the new task into the agent.
- Durability/replay is covered by Flue's **Durable Streams** for the single-agent pipe,
  so you do not need JetStream.

Within the Flue stack, **prefer Flue over bare Pi**: Pi leaves Channels/Schedules/
routing/deploy for you to hand-roll (via extensions/RPC; cf. `pi-chat`, `pi-agent-bus`).
Choose raw Pi only if you want a minimalist harness and will build ingress yourself.

### 2. A real event platform (many consumers, high volume, polyglot, long retention): JetStream as the bus + Flue/Pi as a consumer

Hybrid, best-of-both:

```
Teams (Bot/Graph webhook)  ─┐
                            ├─ ingress bridge ─► JetStream stream ─► durable pull consumers
TickTick poller            ─┘                     (replay, work-queue,    (Flue/Pi agents,
                                                   dedup, fan-out)         other services)
```

You can even reuse a Flue Teams Channel as the _receiver_ that publishes to JetStream.
This buys decoupling, replay, retention, and work-queue distribution across a fleet — at
the cost of more moving parts. For one person and two sources, this is over-engineering.

## Maturity caveat

- **JetStream** is production-grade: CNCF Incubating (graduation application open),
  Apache-2.0, single binary, 40+ client languages, used widely. Safe long-term infra bet.
- **Flue/Pi** is bleeding-edge: Flue is 1.0 Beta with partially AI-generated docs marked
  "awaiting review"; Pi is a young, minimal, self-extensible harness. Ergonomic and
  fast for agent-centric building, but expect churn and gaps.

## Sources

- Flue: <https://flueframework.com/> ·
  [Channels](https://flueframework.com/docs/guide/channels/) ·
  [Teams channel](https://flueframework.com/docs/ecosystem/channels/teams/) ·
  [Schedules](https://flueframework.com/docs/guide/schedules/) ·
  [Durable Execution](https://flueframework.com/docs/concepts/durable-execution/) ·
  [Events Reference](https://flueframework.com/docs/api/events-reference/)
- Pi: <https://pi.dev/> ·
  [superpowers pi-tools](https://github.com/obra/superpowers/blob/main/skills/using-superpowers/references/pi-tools.md) ·
  [earendil-works/pi](https://github.com/earendil-works/pi)
- NATS JetStream: <https://docs.nats.io/nats-concepts/jetstream> ·
  [Consumers](https://docs.nats.io/nats-concepts/jetstream/consumers) ·
  [Streams](https://docs.nats.io/nats-concepts/jetstream/streams) ·
  [Synadia Connect](https://docs.synadia.com/connect)
- Microsoft Teams: [Graph change notifications for chat messages](https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage) ·
  [Change notifications overview](https://learn.microsoft.com/en-us/graph/change-notifications-overview) ·
  [Bot conversational capability](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/build-conversational-capability)
- TickTick: [Open API docs](https://developer.ticktick.com/docs/openapi.md) ·
  [openapi.yaml](https://ticktick.com/openapi.yaml)
