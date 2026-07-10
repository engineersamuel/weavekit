import { describe, expect, it } from "vitest";
import { getPersona, listPersonas } from "../../src/personas/index.js";
import { PersonaDefinitionSchema } from "../../src/decision-council/types.js";

const foundationalCouncilAnchors = {
  "council-aristotle": "taxonomic decomposition",
  "council-socrates": "elenchic questioning",
  "council-sun-tzu": "adversarial simulation",
  "council-ada": "formal stepwise verification",
  "council-aurelius": "negative visualization",
  "council-machiavelli": "incentive backward induction",
} as const;

const foundationalCouncilOutputLabels = [
  "- `claims`:",
  "- `risks`:",
  "- `questions`:",
  "- `recommendations`:",
] as const;

const forbiddenImportedPromptInstructions =
  /tools:|model:|\/council|Council Round 2|provider_affinity|provider routing|coordinator|engage at least|\bpeer(?:-|\s+)(?:engagement|review|response|critique|argument|position|analysis|member)s?\b|word limit|Output Format \(Standalone\)/i;

describe("manifest-backed council personas", () => {
  it("loads the shipped manifest personas", () => {
    expect(
      listPersonas()
        .map((persona) => persona.id)
        .sort(),
    ).toEqual([
      "council-ada",
      "council-aristotle",
      "council-aurelius",
      "council-machiavelli",
      "council-socrates",
      "council-sun-tzu",
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

  it("loads Markdown prompt prose from the entity catalog", () => {
    const pragmatic = PersonaDefinitionSchema.parse(getPersona("pragmatic"));

    expect(pragmatic.prompt).toBe(
      "You are the Pragmatic Builder. Identify the smallest useful next experiment, implementation slice, or prototype that would validate the design.",
    );
    expect(pragmatic.useWhen).toEqual([
      "Use for defining minimal experiments, incremental delivery plans, and practical next actions.",
    ]);
  });

  it("ships substantive normalized prompts for the foundational council personas", () => {
    for (const [id, anchor] of Object.entries(foundationalCouncilAnchors)) {
      const persona = PersonaDefinitionSchema.parse(getPersona(id));

      expect(persona.description.length).toBeGreaterThanOrEqual(20);
      expect(persona.useWhen.length).toBeGreaterThan(0);
      expect(persona.avoidWhen.length).toBeGreaterThan(0);
      expect(persona.prompt.length).toBeGreaterThanOrEqual(600);
      expect(persona.prompt.toLowerCase()).toContain(anchor.toLowerCase());
      expect(persona.prompt).toContain("## Weavekit Council Output");
      expect(persona.prompt).toContain(
        "Do not claim to represent the named person's actual views.",
      );
      for (const outputLabel of foundationalCouncilOutputLabels) {
        expect(persona.prompt).toContain(outputLabel);
      }
      expect(persona.prompt).not.toMatch(forbiddenImportedPromptInstructions);
    }
  });

  it("keeps strategic personas and skill provenance available by id", () => {
    const gameTheorist = PersonaDefinitionSchema.parse(getPersona("strategic-game-theorist"));
    const sunTzu = PersonaDefinitionSchema.parse(getPersona("sun-tzu"));
    const mckinseyStrategist = PersonaDefinitionSchema.parse(getPersona("mckinsey-strategist"));

    expect(gameTheorist.prompt).toContain("claims");
    expect(sunTzu.prompt).toContain("recommendations");
    expect(mckinseyStrategist.skill?.name).toBe("mckinsey-strategist");
  });

  it("returns clones so callers cannot mutate the registry", () => {
    const personas = listPersonas();
    personas[0]!.useWhen.push("bad");

    expect(listPersonas()[0]!.useWhen).not.toContain("bad");
  });
});
