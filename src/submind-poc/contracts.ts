import { z } from "zod";

export const SubmindRunStatus = {
  PROVISIONING: "provisioning",
  ORCHESTRATING: "orchestrating",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export const SubmindOrchestratorModel = {
  GPT_5_6_SOL: "gpt-5.6-sol",
  CLAUDE_OPUS_5: "claude-opus-5",
} as const;
export type SubmindOrchestratorModel =
  (typeof SubmindOrchestratorModel)[keyof typeof SubmindOrchestratorModel];

export const WorkerKind = {
  COPILOT: "copilot",
  GROK: "grok",
  CODEX: "codex",
  CLAUDE: "claude",
} as const;

const IsoDateSchema = z.string().datetime({ offset: true });
const IdentifierSchema = z.string().trim().min(1).max(256);

export const WorkerKindSchema = z.enum([
  WorkerKind.COPILOT,
  WorkerKind.GROK,
  WorkerKind.CODEX,
  WorkerKind.CLAUDE,
]);

export const WorkerRecordSchema = z
  .object({
    kind: WorkerKindSchema,
    command: z.string().trim().min(1),
    paneId: IdentifierSchema,
    agentId: IdentifierSchema,
    name: IdentifierSchema,
    question: z.string().trim().min(1),
    answer: z.string().trim().min(1),
    acknowledgement: z.string().trim().min(1),
    launchedAt: IsoDateSchema,
    answeredAt: IsoDateSchema,
    acknowledgedAt: IsoDateSchema,
  })
  .strict();

export const SubmindManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: IdentifierSchema,
    outcome: z.enum([SubmindRunStatus.COMPLETED, SubmindRunStatus.FAILED]),
    sourceRepositoryPath: z.string().min(1),
    worktreePath: z.string().min(1),
    branchName: IdentifierSchema,
    workspaceId: IdentifierSchema,
    orchestrator: z
      .object({ paneId: IdentifierSchema, agentId: IdentifierSchema, name: IdentifierSchema })
      .strict(),
    workers: z.array(WorkerRecordSchema),
    startedAt: IsoDateSchema,
    completedAt: IsoDateSchema,
    failure: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (Date.parse(manifest.completedAt) < Date.parse(manifest.startedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completion timestamp precedes start timestamp",
      });
    }
    for (const [index, worker] of manifest.workers.entries()) {
      if (
        Date.parse(worker.launchedAt) < Date.parse(manifest.startedAt) ||
        Date.parse(worker.answeredAt) < Date.parse(worker.launchedAt) ||
        Date.parse(worker.acknowledgedAt) < Date.parse(worker.answeredAt) ||
        Date.parse(worker.acknowledgedAt) > Date.parse(manifest.completedAt)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workers", index],
          message: "worker timestamps are out of order",
        });
      }
    }
    if (manifest.outcome === SubmindRunStatus.COMPLETED) {
      if (manifest.failure) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failure"],
          message: "completed manifest cannot contain a failure",
        });
      }
      const kinds = new Set(manifest.workers.map((worker) => worker.kind));
      if (manifest.workers.length !== 4 || kinds.size !== 4) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workers"],
          message: "completed manifest requires one conversation for each worker kind",
        });
      }
      const agentIds = new Set([
        manifest.orchestrator.agentId,
        ...manifest.workers.map((worker) => worker.agentId),
      ]);
      const paneIds = new Set([
        manifest.orchestrator.paneId,
        ...manifest.workers.map((worker) => worker.paneId),
      ]);
      if (agentIds.size !== 5 || paneIds.size !== 5) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workers"],
          message: "completed manifest requires five distinct agents and panes",
        });
      }
    }
    if (manifest.outcome === SubmindRunStatus.FAILED && !manifest.failure) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failure"],
        message: "failed manifest requires a failure reason",
      });
    }
  });

export type SubmindManifest = z.infer<typeof SubmindManifestSchema>;

export const SubmindRunStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: IdentifierSchema,
    state: z.enum([
      SubmindRunStatus.PROVISIONING,
      SubmindRunStatus.ORCHESTRATING,
      SubmindRunStatus.COMPLETED,
      SubmindRunStatus.FAILED,
    ]),
    sourceRepositoryPath: z.string().min(1),
    branchName: IdentifierSchema,
    runDirectory: z.string().min(1),
    agentPrefix: IdentifierSchema,
    worktreePath: z.string().min(1).optional(),
    workspaceId: IdentifierSchema.optional(),
    rootPaneId: IdentifierSchema.optional(),
    orchestratorAgentId: IdentifierSchema.optional(),
    orchestratorModel: z
      .enum([SubmindOrchestratorModel.GPT_5_6_SOL, SubmindOrchestratorModel.CLAUDE_OPUS_5])
      .optional(),
    orchestratorLaunchIntentAt: IsoDateSchema.optional(),
    orchestratorPromptIntentAt: IsoDateSchema.optional(),
    orchestratorPromptAcceptedAt: IsoDateSchema.optional(),
    manifestPath: z.string().min(1).optional(),
    failure: z.string().trim().min(1).optional(),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (state.state === SubmindRunStatus.COMPLETED && !state.manifestPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manifestPath"],
        message: "completed state requires a manifest path",
      });
    }
    if (state.state === SubmindRunStatus.FAILED && !state.failure) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failure"],
        message: "failed state requires a failure reason",
      });
    }
  });

export type SubmindRunState = z.infer<typeof SubmindRunStateSchema>;

export const SubmindEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    runId: IdentifierSchema,
    type: z.enum(["intent", "state", "operation", "receipt", "failure"]),
    timestamp: IsoDateSchema,
    data: z.record(z.unknown()),
  })
  .strict();

export type SubmindEvent = z.infer<typeof SubmindEventSchema>;

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
