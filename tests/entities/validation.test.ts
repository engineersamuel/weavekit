import { describe, expect, it } from "vitest";
import {
  EntityManifestSchema,
  collectZodEntityErrors,
} from "../../src/entities/index.js";

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
});
