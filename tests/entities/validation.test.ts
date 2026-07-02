import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EntityManifestSchema,
  collectZodEntityErrors,
  validateEntityCatalog,
} from "../../src/entities/index.js";

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

describe("entity manifest schemas", () => {
  it("rejects invalid kind reviewer with a repair hint", () => {
    const result = EntityManifestSchema.safeParse({
      id: "reviewer",
      kind: "reviewer",
      name: "Reviewer",
      description: "Wrong kind.",
      execution: { mode: "baml_direct", bamlFunction: "ReviewFinalRecommendation" },
    });

    expect(result.success).toBe(false);
    const errors = collectZodEntityErrors(result, "entities/personas/reviewer.yaml");
    expect(errors).toContainEqual(expect.objectContaining({
      code: "entity.schema",
      fieldPath: "kind",
      repairHint: "Use kind: persona and set persona.role: reviewer.",
    }));
  });

  it("rejects unknown fields in strict mode", () => {
    const result = EntityManifestSchema.safeParse({
      id: "source-analysis",
      kind: "artifact",
      name: "Source Analysis",
      description: "Typed source analysis.",
      unexpected: true,
      execution: { mode: "baml_direct", bamlFunction: "DistillSourceAnalysis" },
    });

    expect(result.success).toBe(false);
    const errors = collectZodEntityErrors(result, "entities/artifacts/source-analysis.yaml");
    expect(errors.some((error) => error.fieldPath === "unexpected")).toBe(true);
  });

  it("reports nested unknown fields with their parent path", () => {
    const result = EntityManifestSchema.safeParse({
      id: "pragmatic",
      kind: "persona",
      name: "Pragmatic Builder",
      description: "Finds small steps.",
      persona: {
        role: "advisor",
        tags: [],
        unexpected: true,
      },
      selection: { useWhen: [], avoidWhen: [] },
      execution: {
        mode: "harness_then_baml",
        harness: "copilot-sdk",
        promptRef: "./pragmatic.md",
        output: { normalizeWithBamlFunction: "NormalizePersonaCritique" },
      },
    });

    expect(result.success).toBe(false);
    const errors = collectZodEntityErrors(result, "entities/personas/pragmatic.yaml");
    expect(errors).toContainEqual(expect.objectContaining({
      code: "entity.schema",
      fieldPath: "persona.unexpected",
    }));
  });
});

describe("entity semantic validation", () => {
  it("rejects missing and empty persona prompt Markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-entities-"));
    await write(root, "entities/personas/pragmatic.yaml", `
id: pragmatic
kind: persona
name: Pragmatic Builder
description: Finds the smallest executable next step.
persona:
  role: advisor
  tags: []
selection:
  useWhen: []
  avoidWhen: []
execution:
  mode: harness_then_baml
  harness: copilot-sdk
  promptRef: ./pragmatic.md
  output:
    normalizeWithBamlFunction: NormalizePersonaCritique
`);
    const missing = validateEntityCatalog(root);
    expect(missing.errors).toContainEqual(expect.objectContaining({ code: "entity.prompt_missing" }));

    await write(root, "entities/personas/pragmatic.md", "\n");
    const empty = validateEntityCatalog(root);
    expect(empty.errors).toContainEqual(expect.objectContaining({ code: "entity.prompt_empty" }));
  });

  it("rejects invalid BAML functions and present mcps", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-entities-"));
    await write(root, "entities/artifacts/source-analysis.yaml", `
id: source-analysis
kind: artifact
name: Source Analysis
description: Typed source analysis.
execution:
  mode: baml_direct
  bamlFunction: NotAFunction
capabilities:
  mcps: []
`);
    const result = validateEntityCatalog(root);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
      "entity.baml_function_unknown",
      "entity.mcps_not_supported_v1",
    ]));
  });

  it("accepts valid generated BAML function references", async () => {
    const root = await mkdtemp(join(tmpdir(), "weavekit-entities-"));
    await write(root, "entities/personas/pragmatic.yaml", `
id: pragmatic
kind: persona
name: Pragmatic Builder
description: Finds the smallest executable next step.
persona:
  role: advisor
  tags: []
selection:
  useWhen: []
  avoidWhen: []
execution:
  mode: harness_then_baml
  harness: copilot-sdk
  promptRef: ./pragmatic.md
  output:
    normalizeWithBamlFunction: NormalizePersonaCritique
`);
    await write(root, "entities/personas/pragmatic.md", "Prompt prose");

    expect(validateEntityCatalog(root).errors).toEqual([]);
  });
});
