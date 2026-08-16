import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RlmReasoningEffort } from "./contracts.js";

export const RlmModelGroup = {
  FrontierCurrent: "frontier-current",
  BalancedWorkhorse: "balanced-workhorse",
  CodingSpecialist: "coding-specialist",
  FastEfficient: "fast-efficient",
} as const;
export type RlmModelGroup = (typeof RlmModelGroup)[keyof typeof RlmModelGroup];

export type RlmModelCapabilities = {
  reasoning: boolean;
  toolCall: boolean;
  structuredOutput: boolean;
  attachments: boolean;
};

export type RlmModelPolicy = {
  preferredGroups: readonly RlmModelGroup[];
  fallbackGroups?: readonly RlmModelGroup[];
  requiredCapabilities?: Partial<RlmModelCapabilities>;
  requiredInputModalities?: readonly string[];
  preferredVendors?: readonly string[];
  preferredFamilies?: readonly string[];
  allowPreview?: boolean;
  defaultReasoningEffort?: RlmReasoningEffort;
  maxCandidates?: number;
};

export type RlmModel = {
  id: string;
  name: string;
  vendor?: string;
  family?: string;
  description: string;
  preview: boolean;
  inputModalities: readonly string[];
  capabilities: RlmModelCapabilities;
  classification?: string;
};

export type RlmModelCandidate = RlmModel & {
  group: RlmModelGroup;
};

export type RlmModelDecision = {
  model: string;
  reasoningEffort?: RlmReasoningEffort;
  rationale: string;
  requestedModel?: string;
  usedFallback: boolean;
  candidates: readonly RlmModelCandidate[];
};

export type CopilotModelCatalog = {
  generatedAt?: string;
  sourcePath: string;
  fallbackReason?: string;
  models: ReadonlyMap<string, RlmModel>;
  groups: Readonly<Record<RlmModelGroup, readonly string[]>>;
};

const ModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    vendor: z.string().nullable().optional(),
    family: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    preview: z.boolean().default(false),
    modalities: z
      .object({ input: z.array(z.string()).default([]), output: z.array(z.string()).default([]) })
      .nullable()
      .optional(),
    capabilities: z
      .object({
        reasoning: z.boolean().default(false),
        tool_call: z.boolean().default(false),
        structured_output: z.boolean().default(false),
        attachments: z.boolean().default(false),
      })
      .default({
        reasoning: false,
        tool_call: false,
        structured_output: false,
        attachments: false,
      }),
    classification: z.string().nullable().optional(),
  })
  .passthrough();

const CatalogSchema = z
  .object({
    generated_at: z.string().optional(),
    groups: z.record(z.array(z.string())),
    models: z.array(ModelSchema),
  })
  .passthrough();

export const DEFAULT_RLM_MODEL_EXCLUSIONS = new Set([
  "gemini-3.1-pro-preview",
  "gpt-5.4",
  "claude-sonnet-4.6",
  "mai-code-1-flash-picker",
  "gemini-3.5-flash",
  "gpt-5.4-mini",
]);

const EMPTY_GROUPS: Record<RlmModelGroup, readonly string[]> = {
  [RlmModelGroup.FrontierCurrent]: [],
  [RlmModelGroup.BalancedWorkhorse]: [],
  [RlmModelGroup.CodingSpecialist]: [],
  [RlmModelGroup.FastEfficient]: [],
};

export function defaultCopilotModelCatalogPath(): string {
  return join(homedir(), ".copilot", "models.json");
}

export async function loadCopilotModelCatalog(
  path = defaultCopilotModelCatalogPath(),
): Promise<CopilotModelCatalog> {
  const raw = await readFile(path, "utf8");
  return parseCopilotModelCatalog(JSON.parse(raw), path);
}

export async function loadCopilotModelCatalogWithFallback(
  path = defaultCopilotModelCatalogPath(),
): Promise<CopilotModelCatalog> {
  try {
    return await loadCopilotModelCatalog(path);
  } catch (error) {
    return createEmergencyModelCatalog(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function parseCopilotModelCatalog(
  input: unknown,
  sourcePath = "<memory>",
): CopilotModelCatalog {
  const parsed = CatalogSchema.parse(input);
  const models = new Map<string, RlmModel>();
  for (const model of parsed.models) {
    models.set(model.id, {
      id: model.id,
      name: model.name,
      ...(model.vendor ? { vendor: model.vendor } : {}),
      ...(model.family ? { family: model.family } : {}),
      description: model.description ?? "No description provided.",
      preview: model.preview,
      inputModalities: model.modalities?.input ?? [],
      capabilities: {
        reasoning: model.capabilities.reasoning,
        toolCall: model.capabilities.tool_call,
        structuredOutput: model.capabilities.structured_output,
        attachments: model.capabilities.attachments,
      },
      ...(model.classification ? { classification: model.classification } : {}),
    });
  }
  const group = (name: RlmModelGroup): string[] =>
    (parsed.groups[name] ?? []).filter(
      (id) => models.has(id) && !DEFAULT_RLM_MODEL_EXCLUSIONS.has(id),
    );
  const groups: Record<RlmModelGroup, readonly string[]> = {
    [RlmModelGroup.FrontierCurrent]: group(RlmModelGroup.FrontierCurrent),
    [RlmModelGroup.BalancedWorkhorse]: group(RlmModelGroup.BalancedWorkhorse),
    [RlmModelGroup.CodingSpecialist]: group(RlmModelGroup.CodingSpecialist),
    [RlmModelGroup.FastEfficient]: group(RlmModelGroup.FastEfficient),
  };
  return {
    ...(parsed.generated_at ? { generatedAt: parsed.generated_at } : {}),
    sourcePath,
    models,
    groups,
  };
}

export function createEmergencyModelCatalog(
  sourcePath: string,
  fallbackReason: string,
): CopilotModelCatalog {
  const emergencyModels: RlmModel[] = [
    {
      id: "claude-opus-5",
      name: "Claude Opus 5",
      vendor: "anthropic",
      family: "claude-opus",
      description: "Emergency frontier model fallback.",
      preview: false,
      inputModalities: ["text", "image", "pdf"],
      capabilities: {
        reasoning: true,
        toolCall: true,
        structuredOutput: true,
        attachments: true,
      },
      classification: RlmModelGroup.FrontierCurrent,
    },
    {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      vendor: "openai",
      family: "gpt",
      description: "Emergency frontier reasoning and coding fallback.",
      preview: false,
      inputModalities: ["text", "image", "pdf"],
      capabilities: {
        reasoning: true,
        toolCall: true,
        structuredOutput: true,
        attachments: true,
      },
      classification: RlmModelGroup.FrontierCurrent,
    },
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      vendor: "anthropic",
      family: "claude-sonnet",
      description: "Emergency balanced agent fallback.",
      preview: false,
      inputModalities: ["text", "image", "pdf"],
      capabilities: {
        reasoning: true,
        toolCall: true,
        structuredOutput: false,
        attachments: true,
      },
      classification: RlmModelGroup.BalancedWorkhorse,
    },
    {
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      vendor: "openai",
      family: "gpt-codex",
      description: "Emergency coding-specialist fallback.",
      preview: false,
      inputModalities: ["text", "image", "pdf"],
      capabilities: {
        reasoning: true,
        toolCall: true,
        structuredOutput: true,
        attachments: true,
      },
      classification: RlmModelGroup.CodingSpecialist,
    },
    {
      id: "gemini-3.7-flash",
      name: "Gemini 3.7 Flash",
      vendor: "google",
      family: "gemini-flash",
      description: "Emergency fast tool-capable fallback.",
      preview: false,
      inputModalities: ["text", "image", "pdf"],
      capabilities: {
        reasoning: true,
        toolCall: true,
        structuredOutput: true,
        attachments: true,
      },
      classification: RlmModelGroup.FastEfficient,
    },
  ];
  return {
    sourcePath,
    fallbackReason,
    models: new Map(emergencyModels.map((model) => [model.id, model])),
    groups: {
      ...EMPTY_GROUPS,
      [RlmModelGroup.FrontierCurrent]: ["claude-opus-5", "gpt-5.6-sol"],
      [RlmModelGroup.BalancedWorkhorse]: ["claude-sonnet-5"],
      [RlmModelGroup.CodingSpecialist]: ["gpt-5.3-codex"],
      [RlmModelGroup.FastEfficient]: ["gemini-3.7-flash"],
    },
  };
}

export function resolveRlmModelCandidates(
  catalog: CopilotModelCatalog,
  policy: RlmModelPolicy,
): RlmModelCandidate[] {
  const groups = [...policy.preferredGroups, ...(policy.fallbackGroups ?? [])];
  const candidates: Array<
    RlmModelCandidate & { groupOrder: number; order: number; preference: number }
  > = [];
  const seen = new Set<string>();
  let order = 0;
  for (const [groupOrder, group] of groups.entries()) {
    for (const id of catalog.groups[group]) {
      const model = catalog.models.get(id);
      if (!model || seen.has(id) || !modelMatchesPolicy(model, policy)) continue;
      seen.add(id);
      candidates.push({
        ...model,
        group,
        groupOrder,
        order,
        preference: modelPreference(model, policy),
      });
      order += 1;
    }
  }
  candidates.sort(
    (left, right) =>
      left.groupOrder - right.groupOrder ||
      right.preference - left.preference ||
      left.order - right.order,
  );
  return candidates
    .slice(0, policy.maxCandidates ?? 4)
    .map(
      ({ groupOrder: _groupOrder, order: _order, preference: _preference, ...candidate }) =>
        candidate,
    );
}

export function resolveRlmModelDecision(
  catalog: CopilotModelCatalog,
  policy: RlmModelPolicy,
  requestedModel?: string,
): RlmModelDecision {
  const candidates = resolveRlmModelCandidates(catalog, policy);
  const requested = requestedModel
    ? candidates.find((candidate) => candidate.id === requestedModel)
    : undefined;
  const selected = requested ?? candidates[0];
  if (!selected) {
    throw new Error("No current Copilot model satisfies the configured RLM model policy.");
  }

  const invalidRequest = Boolean(requestedModel && !requested);
  return {
    model: selected.id,
    ...(policy.defaultReasoningEffort ? { reasoningEffort: policy.defaultReasoningEffort } : {}),
    rationale: requested
      ? `The Submind selected ${selected.id} from the profile's validated candidates.`
      : invalidRequest
        ? `Requested model ${requestedModel} was not eligible; selected policy fallback ${selected.id}.`
        : `Selected highest-ranked eligible ${selected.group} model ${selected.id}.`,
    ...(requestedModel ? { requestedModel } : {}),
    usedFallback: invalidRequest,
    candidates,
  };
}

export function resolveRlmProfileModelDecision(
  catalog: CopilotModelCatalog | undefined,
  fallbackModel: string,
  policy: RlmModelPolicy | undefined,
  requestedModel?: string,
): RlmModelDecision {
  if (catalog && policy) {
    return resolveRlmModelDecision(catalog, policy, requestedModel);
  }
  return {
    model: fallbackModel,
    rationale: policy
      ? `The model catalog is unavailable; using configured fallback ${fallbackModel}.`
      : `Profile uses fixed model ${fallbackModel}.`,
    ...(requestedModel ? { requestedModel } : {}),
    usedFallback: Boolean(requestedModel && requestedModel !== fallbackModel),
    candidates: [],
  };
}

export const RLM_ANSWERER_MODEL_POLICY: RlmModelPolicy = {
  preferredGroups: [RlmModelGroup.FastEfficient],
  fallbackGroups: [RlmModelGroup.BalancedWorkhorse],
  maxCandidates: 3,
};

function modelMatchesPolicy(model: RlmModel, policy: RlmModelPolicy): boolean {
  if (model.preview && policy.allowPreview !== true) return false;
  const required = policy.requiredCapabilities ?? {};
  if (required.reasoning === true && !model.capabilities.reasoning) return false;
  if (required.toolCall === true && !model.capabilities.toolCall) return false;
  if (required.structuredOutput === true && !model.capabilities.structuredOutput) return false;
  if (required.attachments === true && !model.capabilities.attachments) return false;
  return (policy.requiredInputModalities ?? []).every((modality) =>
    model.inputModalities.includes(modality),
  );
}

function modelPreference(model: RlmModel, policy: RlmModelPolicy): number {
  const vendorIndex = policy.preferredVendors?.indexOf(model.vendor ?? "") ?? -1;
  const familyIndex = policy.preferredFamilies?.indexOf(model.family ?? "") ?? -1;
  return (vendorIndex >= 0 ? 100 - vendorIndex : 0) + (familyIndex >= 0 ? 100 - familyIndex : 0);
}
