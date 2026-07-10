import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("personas.baml contract", () => {
  it("defines manifest selector fields for PersonaChoiceCandidate", async () => {
    const source = await readFile("baml_src/personas.baml", "utf8");

    expect(source).toContain("class PersonaChoiceCandidate");
    expect(source).toContain("useWhen string[]");
    expect(source).toContain("avoidWhen string[]");
  });

  it("defines the persona selector contract and pins it to CopilotProxyGpt5Mini", async () => {
    const source = await readFile("baml_src/personas.baml", "utf8");

    expect(source).toContain("class PersonaSelectionRequest");
    expect(source).toContain("class PersonaSelection");
    expect(source).toContain("function ChoosePersonasForTask");
    expect(source).toContain("client CopilotProxyGpt5Mini");
  });

  it("instructs the chooser to prefer complementary methods and fill later-round gaps", async () => {
    const source = await readFile("baml_src/personas.baml", "utf8");

    expect(source).toContain("distinct reasoning methods");
    expect(source).toContain("materially overlapping domains and methods");
    expect(source).toContain("deliberate opposition");
    expect(source).toContain("previousSelectionIds");
    expect(source).toContain("previousRoundSignals");
    expect(source).toContain("missing lens");
  });

  it("exposes generated candidate fields and async client binding", async () => {
    const generatedTypes = await readFile("src/generated/baml_client/types.ts", "utf8");
    const generatedClient = await readFile("src/generated/baml_client/async_client.ts", "utf8");

    expect(generatedTypes).toContain("useWhen: string[]");
    expect(generatedTypes).toContain("avoidWhen: string[]");
    expect(generatedClient).toContain("ChoosePersonasForTask");
  });
});
