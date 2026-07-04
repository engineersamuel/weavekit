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
    const parsed = parseYaml(
      await readFile(join(fixtureDir, `${id}.yaml`), "utf8"),
    ) as TemplateOptimizationFixture;
    fixtures.push(validateFixture(parsed, id, args.mode));
  }
  return fixtures;
}

function validateFixture(
  value: TemplateOptimizationFixture,
  expectedId: string,
  expectedMode: "advisory" | "autonomous-pr",
): TemplateOptimizationFixture {
  if (value.id !== expectedId) {
    throw new Error(`Fixture ${expectedId} has id ${value.id}.`);
  }
  if (value.mode !== expectedMode) {
    throw new Error(`Fixture ${expectedId} has mode ${value.mode}.`);
  }
  for (const key of ["idealFeatures", "mustPreserve", "failureModes"] as const) {
    if (!Array.isArray(value[key]) || value[key].length === 0) {
      throw new Error(`Fixture ${expectedId} requires non-empty ${key}.`);
    }
  }
  return value;
}
