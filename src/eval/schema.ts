import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const DIFFICULTIES = ["intro", "intermediate", "advanced"] as const;

export const ReferenceAnswerSchema = z.object({
  recommendation: z.string().min(1),
  rationale: z.array(z.string().min(1)).min(1),
  strongestObjections: z.array(z.string().min(1)).min(1),
  conditions: z.array(z.string().min(1)).default([]),
  viableAlternatives: z.array(z.string().min(1)).default([]),
  redFlags: z.array(z.string().min(1)).default([]),
  sources: z.array(z.string().url()).default([]),
});

export type ReferenceAnswer = z.infer<typeof ReferenceAnswerSchema>;

export const RubricCriterionSchema = z.object({
  criterion: z.string().min(1),
  weight: z.number().gt(0).lte(1),
  levels: z.string().min(1),
});

export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export const CorpusItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be kebab-case"),
  domain: z.string().min(1),
  difficulty: z.enum(DIFFICULTIES),
  title: z.string().min(1),
  prompt: z.string().min(1),
  context: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  referenceAnswer: ReferenceAnswerSchema,
  rubric: z
    .array(RubricCriterionSchema)
    .min(1)
    .refine(
      (rubric) => Math.abs(rubric.reduce((sum, c) => sum + c.weight, 0) - 1) < 1e-3,
      { message: "rubric weights must sum to 1.0" },
    ),
});

export type CorpusItem = z.infer<typeof CorpusItemSchema>;

export function loadCorpusItem(yamlText: string): CorpusItem {
  return CorpusItemSchema.parse(parseYaml(yamlText));
}

export function loadCorpus(dir: string): CorpusItem[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  const items = files.map((file) => {
    try {
      return loadCorpusItem(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      throw new Error(`Failed to load corpus item ${file}: ${(error as Error).message}`);
    }
  });
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate corpus id: ${item.id}`);
    seen.add(item.id);
  }
  return items;
}

export function formatQuestion(item: CorpusItem): string {
  const parts = [item.prompt];
  if (item.context.length > 0) {
    parts.push("\nContext:\n" + item.context.map((c) => `- ${c}`).join("\n"));
  }
  if (item.constraints.length > 0) {
    parts.push("\nConstraints:\n" + item.constraints.map((c) => `- ${c}`).join("\n"));
  }
  return parts.join("\n");
}

export function formatReference(ref: ReferenceAnswer): string {
  const lines = [
    `Recommendation: ${ref.recommendation}`,
    `Rationale: ${ref.rationale.join("; ")}`,
    `Strongest objections to weigh: ${ref.strongestObjections.join("; ")}`,
  ];
  if (ref.conditions.length > 0) {
    lines.push(`Conditions favoring an alternative: ${ref.conditions.join("; ")}`);
  }
  if (ref.viableAlternatives.length > 0) {
    lines.push(`Viable alternatives: ${ref.viableAlternatives.join("; ")}`);
  }
  if (ref.redFlags.length > 0) {
    lines.push(`Anti-patterns / red flags to avoid: ${ref.redFlags.join("; ")}`);
  }
  return lines.join("\n");
}
