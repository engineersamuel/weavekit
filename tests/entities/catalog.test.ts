import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertValidEntityCatalog,
  formatEntityValidationErrors,
  loadEntityCatalog,
  validateEntityCatalog,
} from "../../src/entities/index.js";

async function writeManifest(root: string, relativePath: string, yaml: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, yaml, "utf8");
}

describe("entity catalog validation", () => {
  it("reports missing entities directory with a repair hint", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-entities-"));
    const result = validateEntityCatalog(root);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "catalog.missing_entities_dir",
        fieldPath: "entities",
        repairHint:
          "Create repo-local entities/personas, entities/artifacts, and entities/elicitation directories.",
      }),
    );
  });

  it("collects duplicate id and filename mismatch errors in one result", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-entities-"));
    await writeManifest(
      root,
      "entities/personas/wrong-name.yaml",
      `
id: duplicated
kind: persona
name: First
description: First persona.
persona:
  role: advisor
  tags: []
selection:
  useWhen: []
  avoidWhen: []
execution:
  mode: harness_then_baml
  harness: copilot-sdk
  promptRef: ./wrong-name.md
  output:
    normalizeWithBamlFunction: NormalizePersonaCritique
`,
    );
    await writeManifest(root, "entities/personas/wrong-name.md", "Prompt");
    await writeManifest(
      root,
      "entities/artifacts/duplicated.yaml",
      `
id: duplicated
kind: artifact
name: Source Analysis
description: Duplicate id artifact.
execution:
  mode: baml_direct
  bamlFunction: DistillSourceAnalysis
`,
    );

    const result = validateEntityCatalog(root);
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["catalog.filename_id_mismatch", "catalog.duplicate_id"]),
    );
  });

  it("throws one formatted error containing all validation failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-entities-"));
    expect(() => assertValidEntityCatalog(root)).toThrow(/Entity catalog validation failed/);
    expect(formatEntityValidationErrors(validateEntityCatalog(root).errors)).toContain("Repair:");
  });

  it("loads runtime personas from sibling Markdown prompt prose", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-entities-"));
    await writeManifest(
      root,
      "entities/personas/pragmatic.yaml",
      `
id: pragmatic
kind: persona
name: Pragmatic Builder
description: Finds small steps.
persona:
  role: advisor
  archetype: analyst
  tags: [implementation]
selection:
  useWhen: [Use for incremental delivery.]
  avoidWhen: [Avoid for adversarial critique.]
execution:
  mode: harness_then_baml
  harness: copilot-sdk
  promptRef: ./pragmatic.md
  output:
    normalizeWithBamlFunction: NormalizePersonaCritique
`,
    );
    await writeManifest(root, "entities/personas/pragmatic.md", "Prompt prose");
    const catalog = loadEntityCatalog(root);
    expect(catalog.personas).toEqual([
      expect.objectContaining({
        id: "pragmatic",
        prompt: "Prompt prose",
        useWhen: ["Use for incremental delivery."],
      }),
    ]);
  });
});

describe("shipped entity catalog", () => {
  it("validates the repo-local entities catalog", () => {
    const result = validateEntityCatalog(process.cwd());
    expect(result.errors).toEqual([]);
    expect(
      loadEntityCatalog(process.cwd())
        .personas.map((persona) => persona.id)
        .sort(),
    ).toEqual([
      "council-ada",
      "council-aristotle",
      "council-aurelius",
      "council-feynman",
      "council-kahneman",
      "council-karpathy",
      "council-lao-tzu",
      "council-machiavelli",
      "council-meadows",
      "council-munger",
      "council-musashi",
      "council-rams",
      "council-socrates",
      "council-sun-tzu",
      "council-sutskever",
      "council-taleb",
      "council-torvalds",
      "council-watts",
      "deep-module-dry",
      "dialectic-adversary",
      "dialectic-advocate",
      "hostile-auditor",
      "mckinsey-strategist",
      "pragmatic",
      "skeptic",
      "socratic",
      "strategic-game-theorist",
      "sun-tzu",
      "synthesist",
    ]);
  });
});
