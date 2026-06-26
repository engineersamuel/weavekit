import { describe, expect, it, vi } from "vitest";
import type { PersonaSelectionRequest } from "../../src/generated/baml_client/index.js";
import type { PersonaDefinition, PersonaSet } from "../../src/personas/schema.js";
import {
  createBamlPersonaSelector,
  createStaticPersonaSelector,
  type PersonaSelectionInput,
} from "../../src/personas/selector.js";
import { createBamlPersonaSelector as createFromPersonasIndex } from "../../src/personas/index.js";
import { createBamlPersonaSelector as createFromRootIndex } from "../../src/index.js";

const candidateA: PersonaDefinition = {
  id: "socratic",
  name: "Socratic",
  description: "Questions assumptions and tests logic.",
  prompt: "Ask hard questions.",
  archetype: "critic",
  tags: ["questions"],
  modes: ["analyze"],
  selectionHints: ["Use for requirement ambiguity."],
  selectionAntiHints: ["Avoid when pure implementation speed is needed."],
  framingCorrections: [],
  ignores: [],
};

const candidateB: PersonaDefinition = {
  id: "builder",
  name: "Builder",
  description: "Turns decisions into concrete implementation steps.",
  prompt: "Build pragmatic plans.",
  archetype: "analyst",
  tags: ["delivery"],
  modes: ["advise"],
  selectionHints: ["Use when execution clarity is needed."],
  selectionAntiHints: ["Avoid for purely adversarial review."],
  framingCorrections: [],
  ignores: [],
};

const baseInput: PersonaSelectionInput = {
  workflowName: "decision-council",
  workflowPurpose: "Produce a balanced recommendation.",
  taskPrompt: "Should we split this module?",
  context: ["Service is latency sensitive."],
  constraints: ["No schema migration this sprint."],
  roundNumber: 2,
  roundFocus: "Resolve disagreement on module seams.",
  previousSelectionIds: ["socratic"],
  previousRoundSignals: ["Need stronger execution focus."],
};

describe("createBamlPersonaSelector", () => {
  it("sends a compact candidate request and excludes raw persona prompts", async () => {
    let capturedRequest: PersonaSelectionRequest | undefined;
    const selector = createBamlPersonaSelector({
      candidatePersonas: [candidateA, candidateB],
      bamlClient: {
        async ChoosePersonasForTask(request) {
          capturedRequest = request;
          return { personaIds: ["socratic", "builder"], rationale: "Need critique and delivery." };
        },
      },
    });

    await selector.choosePersonas(baseInput);

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.candidates).toEqual([
      {
        id: "socratic",
        name: "Socratic",
        description: "Questions assumptions and tests logic.",
        archetype: "critic",
        tags: ["questions"],
        modes: ["analyze"],
        selectionHints: ["Use for requirement ambiguity."],
        selectionAntiHints: ["Avoid when pure implementation speed is needed."],
      },
      {
        id: "builder",
        name: "Builder",
        description: "Turns decisions into concrete implementation steps.",
        archetype: "analyst",
        tags: ["delivery"],
        modes: ["advise"],
        selectionHints: ["Use when execution clarity is needed."],
        selectionAntiHints: ["Avoid for purely adversarial review."],
      },
    ]);
    expect(capturedRequest?.candidates[0]).not.toHaveProperty("prompt");
  });

  it("returns selected personas in chooser order as cloned set named selected", async () => {
    const selector = createBamlPersonaSelector({
      candidatePersonas: [candidateA, candidateB],
      bamlClient: {
        async ChoosePersonasForTask() {
          return { personaIds: ["builder", "socratic"], rationale: "Cover execution and critique." };
        },
      },
    });

    const result = await selector.choosePersonas(baseInput);

    expect(result.rationale).toBe("Cover execution and critique.");
    expect(result.personaSet.name).toBe("selected");
    expect(result.personaSet.personas.map((p) => p.id)).toEqual(["builder", "socratic"]);

    result.personaSet.personas[0]!.name = "Mutated";
    const next = await selector.choosePersonas(baseInput);
    expect(next.personaSet.personas[0]!.name).toBe("Builder");
  });

  it("rejects unknown, duplicate, and out-of-range chooser outputs", async () => {
    const unknownSelector = createBamlPersonaSelector({
      candidatePersonas: [candidateA, candidateB],
      bamlClient: {
        async ChoosePersonasForTask() {
          return { personaIds: ["unknown"], rationale: "Bad id." };
        },
      },
    });
    await expect(unknownSelector.choosePersonas(baseInput)).rejects.toThrow(
      'Persona chooser returned unknown persona id "unknown".',
    );

    const duplicateSelector = createBamlPersonaSelector({
      candidatePersonas: [candidateA, candidateB],
      bamlClient: {
        async ChoosePersonasForTask() {
          return { personaIds: ["socratic", "socratic"], rationale: "Bad duplicate." };
        },
      },
    });
    await expect(duplicateSelector.choosePersonas(baseInput)).rejects.toThrow(
      'Persona chooser returned duplicate persona id "socratic".',
    );

    const rangeSelector = createBamlPersonaSelector({
      candidatePersonas: [candidateA, candidateB],
      minPersonas: 2,
      maxPersonas: 2,
      bamlClient: {
        async ChoosePersonasForTask() {
          return { personaIds: ["socratic"], rationale: "Too few." };
        },
      },
    });
    await expect(rangeSelector.choosePersonas(baseInput)).rejects.toThrow(
      "Persona chooser selected 1 personas; expected 2-2.",
    );
  });
});

describe("createStaticPersonaSelector", () => {
  it("returns cloned static selection without invoking BAML", async () => {
    const staticSet: PersonaSet = { name: "default", personas: [candidateA, candidateB] };
    const selector = createStaticPersonaSelector(staticSet);

    const first = await selector.choosePersonas(baseInput);
    first.personaSet.personas[0]!.name = "Mutated";

    const second = await selector.choosePersonas(baseInput);
    expect(second.personaSet.personas[0]!.name).toBe("Socratic");
    expect(second.rationale).toContain("Static persona selector");
  });
});

describe("public exports", () => {
  it("re-exports selector constructors from personas and root index", () => {
    expect(createFromPersonasIndex).toBe(createBamlPersonaSelector);
    expect(createFromRootIndex).toBe(createBamlPersonaSelector);
  });

  it("only calls BAML for BAML-backed selector", async () => {
    const ChoosePersonasForTask = vi.fn(async () => ({
      personaIds: ["socratic", "builder"],
      rationale: "Need both personas.",
    }));
    const selector = createBamlPersonaSelector({
      candidatePersonas: [candidateA, candidateB],
      bamlClient: { ChoosePersonasForTask },
    });

    await selector.choosePersonas(baseInput);
    expect(ChoosePersonasForTask).toHaveBeenCalledTimes(1);
  });
});
