import { Collector } from "@boundaryml/baml";

export type WorkflowTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
};

export type WorkflowUsageRecord = WorkflowTokenUsage & {
  id: string;
  executor: "baml" | "copilot-sdk";
  operation?: string;
  mode?: string;
  model?: string;
  nodeId?: string;
  cwd?: string;
  label: string;
  estimatedCostUsd?: number;
};

export type WorkflowUsageSummary = WorkflowTokenUsage & {
  records: WorkflowUsageRecord[];
  estimatedCostUsd?: number;
  unpricedModels: string[];
};

type WorkflowUsageRecordInput = Omit<WorkflowUsageRecord, "id" | "label" | "estimatedCostUsd"> & {
  label?: string;
};

type ModelPricing = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  outputUsdPerMillion: number;
};

const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-5.5": { inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30 },
  "gpt-5.4": { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 },
  "gpt-5.4-mini": {
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 4.5,
  },
  "gpt-5.3-codex": {
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.125,
    outputUsdPerMillion: 10,
  },
  "gpt-5.2": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
  "gpt-5.1": { inputUsdPerMillion: 1.25, cachedInputUsdPerMillion: 0.125, outputUsdPerMillion: 10 },
  "gpt-5": { inputUsdPerMillion: 1.25, cachedInputUsdPerMillion: 0.125, outputUsdPerMillion: 10 },
  "gpt-5-mini": {
    inputUsdPerMillion: 0.25,
    cachedInputUsdPerMillion: 0.025,
    outputUsdPerMillion: 2,
  },
  "claude-opus-4.8": {
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
  },
  "claude-opus-4-8": {
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
  },
  "claude-sonnet-5": {
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 10,
  },
  "claude-sonnet-4-6": {
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
  },
  "claude-sonnet-4.6": {
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
  },
  "claude-haiku-4-5": {
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 5,
  },
};

export class WorkflowUsageCollector {
  private nextId = 1;
  private readonly records: WorkflowUsageRecord[] = [];

  createBamlCollector(name: string): Collector {
    return new Collector(name);
  }

  recordBamlCollector(args: {
    operation: string;
    model?: string;
    collector: Collector;
    nodeId?: string;
  }): void {
    this.record({
      executor: "baml",
      operation: args.operation,
      model: args.model,
      nodeId: args.nodeId,
      label: `BAML ${args.operation}`,
      ...normalizeUsage(args.collector.usage),
    });
  }

  record(input: WorkflowUsageRecordInput): void {
    const usage = normalizeUsage(input);
    if (
      usage.inputTokens === undefined &&
      usage.outputTokens === undefined &&
      usage.cachedInputTokens === undefined &&
      usage.totalTokens === undefined
    ) {
      return;
    }
    const estimatedCostUsd = estimateUsageCostUsd(input.model, usage);
    const totalTokens = totalTokenCount(usage);
    this.records.push({
      id: `usage-${this.nextId++}`,
      ...input,
      ...usage,
      ...(totalTokens === undefined ? {} : { totalTokens }),
      label: input.label ?? defaultUsageLabel(input),
      ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    });
  }

  summarize(): WorkflowUsageSummary {
    const totals = this.records.reduce<WorkflowTokenUsage>(
      (total, record) => ({
        inputTokens: addOptional(total.inputTokens, record.inputTokens),
        outputTokens: addOptional(total.outputTokens, record.outputTokens),
        cachedInputTokens: addOptional(total.cachedInputTokens, record.cachedInputTokens),
        totalTokens: addOptional(total.totalTokens, record.totalTokens),
      }),
      {},
    );
    const costRecords = this.records.filter((record) => record.estimatedCostUsd !== undefined);
    const estimatedCostUsd =
      costRecords.length > 0
        ? costRecords.reduce((total, record) => total + (record.estimatedCostUsd ?? 0), 0)
        : undefined;
    const unpricedModels = Array.from(
      new Set(
        this.records
          .filter((record) => record.model && record.estimatedCostUsd === undefined)
          .map((record) => record.model!),
      ),
    ).sort();
    return {
      records: [...this.records],
      ...totals,
      ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
      unpricedModels,
    };
  }
}

export function extractUsageFromCopilotEventData(data: unknown): WorkflowTokenUsage | undefined {
  const candidates = [
    data,
    readRecord(data).usage,
    readRecord(data).usageDetails,
    readRecord(data).usage_details,
    readRecord(data).tokenUsage,
    readRecord(data).token_usage,
  ];
  for (const candidate of candidates) {
    const record = readRecord(candidate);
    const inputTokens = readNumber(
      record.inputTokens,
      record.input_tokens,
      record.promptTokens,
      record.prompt_tokens,
      record.input,
    );
    const outputTokens = readNumber(
      record.outputTokens,
      record.output_tokens,
      record.completionTokens,
      record.completion_tokens,
      record.output,
    );
    const cachedInputTokens = readNumber(
      record.cachedInputTokens,
      record.cached_input_tokens,
      record.cacheReadInputTokens,
      record.cache_read_input_tokens,
      readRecord(record.prompt_tokens_details).cached_tokens,
      readRecord(record.input_token_details).cache_read,
    );
    const totalTokens = readNumber(
      record.totalTokens,
      record.total_tokens,
      record.total,
      record.totalTokensUsed,
      record.total_tokens_used,
    );
    if (
      inputTokens !== undefined ||
      outputTokens !== undefined ||
      cachedInputTokens !== undefined ||
      totalTokens !== undefined
    ) {
      return { inputTokens, outputTokens, cachedInputTokens, totalTokens };
    }
  }
  return undefined;
}

export function renderWorkflowUsageSummary(summary: WorkflowUsageSummary): string {
  if (summary.records.length === 0) {
    return "[weavekit] Token usage: no model token usage was reported.\n";
  }
  const lines = [
    `[weavekit] Token usage: total ${formatInteger(summary.totalTokens)} tokens, input ${formatInteger(summary.inputTokens)}, cached ${formatInteger(summary.cachedInputTokens)}, output ${formatInteger(summary.outputTokens)}${summary.estimatedCostUsd === undefined ? "" : `, estimated cost ${formatUsd(summary.estimatedCostUsd)}`}`,
    ...summary.records.map((record) => {
      const cost =
        record.estimatedCostUsd === undefined ? "" : `, est ${formatUsd(record.estimatedCostUsd)}`;
      const model = record.model ? ` model=${record.model}` : "";
      return `[weavekit]   - ${record.label}${model}: total ${formatInteger(record.totalTokens)} tokens, input ${formatInteger(record.inputTokens)}, cached ${formatInteger(record.cachedInputTokens)}, output ${formatInteger(record.outputTokens)}${cost}`;
    }),
    ...(summary.unpricedModels.length > 0
      ? [`[weavekit]   Unpriced models: ${summary.unpricedModels.join(", ")}`]
      : []),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderWorkflowUsageMarkdown(summary: WorkflowUsageSummary | undefined): string[] {
  if (!summary || summary.records.length === 0) {
    return ["## Token Usage and Cost", "", "No model token usage was reported."];
  }
  return [
    "## Token Usage and Cost",
    "",
    `- Total tokens: ${formatInteger(summary.totalTokens)}`,
    `- Total input tokens: ${formatInteger(summary.inputTokens)}`,
    `- Cached input tokens: ${formatInteger(summary.cachedInputTokens)}`,
    `- Output tokens: ${formatInteger(summary.outputTokens)}`,
    `- Total estimated cost: ${summary.estimatedCostUsd === undefined ? "n/a" : formatUsd(summary.estimatedCostUsd)}`,
    ...(summary.unpricedModels.length > 0
      ? [`- Unpriced models: ${summary.unpricedModels.join(", ")}`]
      : []),
    "",
    "| Call | Executor | Model | Total | Input | Cached | Output | Estimated cost |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...summary.records
      .map((record) =>
        [
          escapeMarkdownTableCell(record.label),
          record.executor,
          escapeMarkdownTableCell(record.model ?? "n/a"),
          formatInteger(record.totalTokens),
          formatInteger(record.inputTokens),
          formatInteger(record.cachedInputTokens),
          formatInteger(record.outputTokens),
          record.estimatedCostUsd === undefined ? "n/a" : formatUsd(record.estimatedCostUsd),
        ].join(" | "),
      )
      .map((line) => `| ${line} |`),
    "",
    "_Cost is a rough estimate from current OpenAI and Anthropic public per-million-token pricing. Tool-call fees, regional uplifts, priority/flex/batch discounts, cache writes, and proxy-specific billing are not included._",
  ];
}

function estimateUsageCostUsd(
  model: string | undefined,
  usage: WorkflowTokenUsage,
): number | undefined {
  if (!model) {
    return undefined;
  }
  const pricing = MODEL_PRICING[normalizeModelName(model)];
  if (!pricing) {
    return undefined;
  }
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const inputTokens = Math.max(0, (usage.inputTokens ?? 0) - cachedInputTokens);
  const outputTokens = usage.outputTokens ?? 0;
  return (
    (inputTokens * pricing.inputUsdPerMillion +
      cachedInputTokens * (pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion) +
      outputTokens * pricing.outputUsdPerMillion) /
    1_000_000
  );
}

function normalizeUsage(value: unknown): WorkflowTokenUsage {
  const record = readRecord(value);
  const inputTokens = readNumber(record.inputTokens, record.input_tokens);
  const outputTokens = readNumber(record.outputTokens, record.output_tokens);
  const cachedInputTokens = readNumber(record.cachedInputTokens, record.cached_input_tokens);
  const totalTokens = totalTokenCount({
    inputTokens,
    outputTokens,
    totalTokens: readNumber(record.totalTokens, record.total_tokens),
  });
  return { inputTokens, outputTokens, cachedInputTokens, totalTokens };
}

function normalizeModelName(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/-\d{8}$/, "");
}

function defaultUsageLabel(input: WorkflowUsageRecordInput): string {
  if (input.executor === "baml") {
    return `BAML ${input.operation ?? "call"}`;
  }
  return `Copilot ${input.mode ?? "call"}`;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function addOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}

function totalTokenCount(usage: WorkflowTokenUsage): number | undefined {
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  return usage.totalTokens;
}

function formatInteger(value: number | undefined): string {
  return value === undefined ? "n/a" : Math.round(value).toLocaleString("en-US");
}

function formatUsd(value: number): string {
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
