import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { TemplateOptimizationFixture } from "../../generated/baml_client/index.js";

export async function loadTemplateOptimizationFixtures(args: {
  templateId: "source-to-project";
  mode: "advisory" | "autonomous-pr";
  rootDir?: string;
}): Promise<TemplateOptimizationFixture[]> {
  const rootDir = args.rootDir ?? join("evals", "template-optimizer");
  const fixtureDir = join(rootDir, args.templateId, args.mode);
  const fixtureIds =
    args.mode === "advisory"
      ? ["strong-fit", "no-fit", "multiple-opportunities", "plumbing-temptation"]
      : [];
  const fixtures: TemplateOptimizationFixture[] = [];
  for (const id of fixtureIds) {
    const parsed: unknown = parseYaml(await readFile(join(fixtureDir, `${id}.yaml`), "utf8"));
    fixtures.push(validateFixture(parsed, id, args.mode));
  }
  return fixtures;
}

const requiredArrayFields = [
  "sourceLessons",
  "projectConstraints",
  "opportunities",
  "idealFeatures",
  "mustPreserve",
  "failureModes",
] as const;

function validateFixture(
  value: unknown,
  expectedId: string,
  expectedMode: "advisory" | "autonomous-pr",
): TemplateOptimizationFixture {
  if (!isRecord(value)) {
    throw new Error(`Fixture ${expectedId} requires object fixture.`);
  }
  const id = requireNonEmptyStringField(value, expectedId, "id");
  if (id !== expectedId) {
    throw new Error(`Fixture ${expectedId} has id ${id}.`);
  }
  const mode = requireNonEmptyStringField(value, expectedId, "mode");
  if (mode !== expectedMode) {
    throw new Error(`Fixture ${expectedId} has mode ${mode}.`);
  }
  const scenarioSummary = requireNonEmptyStringField(value, expectedId, "scenarioSummary");
  const arrays = Object.fromEntries(
    requiredArrayFields.map((field) => [
      field,
      requireNonEmptyStringArrayField(value, expectedId, field),
    ]),
  ) as Pick<TemplateOptimizationFixture, (typeof requiredArrayFields)[number]>;
  return {
    id,
    mode,
    scenarioSummary,
    ...arrays,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyStringField(
  value: Record<string, unknown>,
  fixtureId: string,
  field: "id" | "mode" | "scenarioSummary",
): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
    throw new Error(`Fixture ${fixtureId} requires non-empty ${field}.`);
  }
  return fieldValue;
}

function requireNonEmptyStringArrayField(
  value: Record<string, unknown>,
  fixtureId: string,
  field: (typeof requiredArrayFields)[number],
): string[] {
  const fieldValue = value[field];
  if (
    !Array.isArray(fieldValue) ||
    fieldValue.length === 0 ||
    fieldValue.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`Fixture ${fixtureId} requires non-empty ${field}.`);
  }
  return fieldValue;
}
