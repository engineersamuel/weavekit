import type { ApiProvider, ProviderResponse } from "promptfoo";
import { z } from "zod";
import { formatBoundedError } from "../boundedError.js";
import type { RecordedAbsoluteJudgeOutcome, SourceToProjectPlanJudge } from "./judge.js";
import { noAbsoluteJudgeRepairMetadata, shouldSwapPairwiseOrder } from "./judge.js";

const NonEmptyStringSchema = z.string().min(1);

const AbsoluteTaskSchema = z
  .object({
    kind: z.literal("absolute"),
    caseJson: z.string(),
    providerId: NonEmptyStringSchema,
    planMarkdown: z.string(),
  })
  .strict();

const PairwiseTaskSchema = z
  .object({
    kind: z.literal("pairwise"),
    caseId: NonEmptyStringSchema,
    trialId: NonEmptyStringSchema,
    caseJson: z.string(),
    providerIds: z.tuple([NonEmptyStringSchema, NonEmptyStringSchema]),
    plans: z.record(z.string()),
  })
  .strict();

const PromptfooJudgeTaskSchema = z
  .discriminatedUnion("kind", [AbsoluteTaskSchema, PairwiseTaskSchema])
  .superRefine((task, context) => {
    if (task.kind !== "pairwise") return;
    const [leftProviderId, rightProviderId] = task.providerIds;
    if (leftProviderId === rightProviderId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerIds"],
        message: "pairwise provider IDs must be distinct",
      });
      return;
    }
    const planProviderIds = Object.keys(task.plans).sort();
    const expectedProviderIds = [...task.providerIds].sort();
    if (
      planProviderIds.length !== expectedProviderIds.length ||
      planProviderIds.some((providerId, index) => providerId !== expectedProviderIds[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["plans"],
        message: "pairwise plans must contain exactly the two provider IDs",
      });
    }
  });

export type PromptfooJudgeTask = z.infer<typeof PromptfooJudgeTaskSchema>;

type PromptfooJudgeMetadata = Record<string, unknown>;

export function createPromptfooJudgeProviders(panel: SourceToProjectPlanJudge[]): ApiProvider[] {
  validateJudgePanel(panel);
  const judgeIds = panel.map(({ id }) => id);
  return panel.map((judge) => createPromptfooJudgeProvider(judge, judgeIds));
}

function validateJudgePanel(panel: SourceToProjectPlanJudge[]): void {
  const judgeIds = new Set<string>();
  for (const judge of panel) {
    if (judge.id.trim().length === 0) {
      throw new Error("Promptfoo judge ID must be non-empty.");
    }
    if (judgeIds.has(judge.id)) {
      throw new Error(`Duplicate judge ID for Promptfoo provider: ${judge.id}.`);
    }
    judgeIds.add(judge.id);
  }
}

function createPromptfooJudgeProvider(
  judge: SourceToProjectPlanJudge,
  judgeIds: string[],
): ApiProvider {
  return {
    id: () => `source-to-project-judge:${judge.id}`,
    callApi: async (prompt: string): Promise<ProviderResponse> => {
      const parsed = parsePromptfooJudgeTask(prompt);
      if (!parsed.ok) return { error: parsed.error, metadata: judgeMetadata(judge) };
      return parsed.task.kind === "absolute"
        ? await runAbsoluteTask(judge, parsed.task)
        : await runPairwiseTask(judge, judgeIds, parsed.task);
    },
  };
}

async function runAbsoluteTask(
  judge: SourceToProjectPlanJudge,
  task: Extract<PromptfooJudgeTask, { kind: "absolute" }>,
): Promise<ProviderResponse> {
  const baseMetadata: PromptfooJudgeMetadata = {
    kind: task.kind,
    ...judgeMetadata(judge),
    providerId: task.providerId,
  };
  try {
    const outcome = await absoluteOutcome(judge, task);
    const metadata = { ...baseMetadata, repairMetadata: outcome.repairMetadata };
    if (!outcome.ok) {
      return {
        error: formatPromptfooJudgeFailure("Absolute judge failed", outcome.error),
        metadata,
      };
    }
    return { output: JSON.stringify(outcome.result), metadata };
  } catch (error) {
    return {
      error: formatPromptfooJudgeFailure("Absolute judge failed", error),
      metadata: { ...baseMetadata, repairMetadata: noAbsoluteJudgeRepairMetadata() },
    };
  }
}

async function absoluteOutcome(
  judge: SourceToProjectPlanJudge,
  task: Extract<PromptfooJudgeTask, { kind: "absolute" }>,
): Promise<RecordedAbsoluteJudgeOutcome> {
  const input = { caseJson: task.caseJson, planMarkdown: task.planMarkdown };
  if (!judge.judgePlanWithMetadata) {
    throw new Error(
      `Judge ${judge.id} is incompatible with Promptfoo absolute evaluation: judgePlanWithMetadata is required.`,
    );
  }
  return await judge.judgePlanWithMetadata(input);
}

async function runPairwiseTask(
  judge: SourceToProjectPlanJudge,
  judgeIds: string[],
  task: Extract<PromptfooJudgeTask, { kind: "pairwise" }>,
): Promise<ProviderResponse> {
  const providerIds = [...task.providerIds].sort() as [string, string];
  const swap = shouldSwapPairwiseOrder({
    caseId: task.caseId,
    trialId: task.trialId,
    leftProviderId: providerIds[0],
    rightProviderId: providerIds[1],
    judgeId: judge.id,
    judgeIds,
  });
  const [planAProviderId, planBProviderId] = swap
    ? [providerIds[1], providerIds[0]]
    : [providerIds[0], providerIds[1]];
  const baseMetadata: PromptfooJudgeMetadata = {
    kind: task.kind,
    ...judgeMetadata(judge),
    providerIds: task.providerIds,
    planAProviderId,
    planBProviderId,
    anonymousOrder: { planAProviderId, planBProviderId },
  };
  try {
    const result = await judge.comparePlans({
      caseJson: task.caseJson,
      planA: task.plans[planAProviderId]!,
      planB: task.plans[planBProviderId]!,
    });
    const mappedWinner =
      result.winner === "tie"
        ? "tie"
        : result.winner === "plan-a"
          ? planAProviderId
          : planBProviderId;
    return {
      output: JSON.stringify(result),
      metadata: {
        ...baseMetadata,
        anonymousWinner: result.winner,
        mappedWinner,
      },
    };
  } catch (error) {
    return {
      error: formatPromptfooJudgeFailure("Pairwise judge failed", error),
      metadata: baseMetadata,
    };
  }
}

export type ParsedPromptfooJudgeTask =
  | { ok: true; task: PromptfooJudgeTask }
  | { ok: false; error: string };

export function parsePromptfooJudgeTask(prompt: string): ParsedPromptfooJudgeTask {
  let input: unknown;
  try {
    input = JSON.parse(prompt);
  } catch (error) {
    return {
      ok: false,
      error: formatPromptfooJudgeFailure("Invalid Promptfoo judge task", error),
    };
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const kind = (input as Record<string, unknown>).kind;
    if (kind !== "absolute" && kind !== "pairwise") {
      return {
        ok: false,
        error: formatPromptfooJudgeFailure(
          "Invalid Promptfoo judge task",
          `Unsupported task kind: ${String(kind)}.`,
        ),
      };
    }
  }
  const parsed = PromptfooJudgeTaskSchema.safeParse(input);
  if (parsed.success) return { ok: true, task: parsed.data };
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "task"}: ${issue.message}`)
    .join("; ");
  return {
    ok: false,
    error: formatPromptfooJudgeFailure("Invalid Promptfoo judge task", details),
  };
}

export const formatPromptfooJudgeFailure = formatBoundedError;

function judgeMetadata(judge: SourceToProjectPlanJudge): PromptfooJudgeMetadata {
  return {
    judgeId: judge.id,
    ...(judge.bamlClientName ? { bamlClientName: judge.bamlClientName } : {}),
  };
}
