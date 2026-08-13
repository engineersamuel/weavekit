import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(256);

export const HerdrApiSchemaDocumentSchema = z.record(z.unknown());

export const HerdrSnapshotSchema = z
  .object({
    workspaces: z
      .array(
        z
          .object({
            id: IdentifierSchema,
            cwd: z.string().min(1).optional(),
          })
          .passthrough(),
      )
      .default([]),
    panes: z
      .array(
        z
          .object({
            id: IdentifierSchema,
            workspaceId: IdentifierSchema,
            cwd: z.string().min(1).optional(),
            exited: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
    agents: z
      .array(
        z
          .object({
            id: IdentifierSchema,
            name: IdentifierSchema,
            paneId: IdentifierSchema,
            kind: z.string().optional(),
            status: z.string().optional(),
            interactiveReady: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export type HerdrSnapshot = z.infer<typeof HerdrSnapshotSchema>;

/**
 * Lifecycle states Herdr derives by scraping the PTY it owns.
 *
 * Critical semantics, verified live and documented in ADR 0011:
 * - `blocked` fires only for *structured* UI (permission dialogs, question widgets). An agent that
 *   asks a question in prose reports `idle`, indistinguishable from completion.
 * - `unknown` means an agent is present but unclassifiable; it does **not** prove completion.
 *
 * Consumers must therefore treat these as a hint about *when to look*, never as proof that a
 * delegated turn finished.
 */
export const HerdrAgentStatus = {
  Idle: "idle",
  Working: "working",
  Blocked: "blocked",
  Done: "done",
  Unknown: "unknown",
} as const;
export type HerdrAgentStatus = (typeof HerdrAgentStatus)[keyof typeof HerdrAgentStatus];

/** States Herdr treats as "settled" when `agent.wait` is called without an explicit `until`. */
export const HERDR_SETTLED_STATUSES: readonly HerdrAgentStatus[] = [
  HerdrAgentStatus.Idle,
  HerdrAgentStatus.Done,
  HerdrAgentStatus.Blocked,
];
