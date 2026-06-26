import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("personas.baml contract", () => {
  it("defines the persona selector contract and pins it to CopilotProxyGpt54", async () => {
    const source = await readFile("baml_src/personas.baml", "utf8");

    expect(source).toContain("class PersonaChoiceCandidate");
    expect(source).toContain("class PersonaSelectionRequest");
    expect(source).toContain("class PersonaSelection");
    expect(source).toContain("function ChoosePersonasForTask");
    expect(source).toContain("client CopilotProxyGpt54");
  });

  it("exposes a generated async client binding for ChoosePersonasForTask", async () => {
    const generated = await readFile("src/generated/baml_client/async_client.ts", "utf8");

    expect(generated).toContain("ChoosePersonasForTask");
  });
});
