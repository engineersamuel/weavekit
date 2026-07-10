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

const practicalCouncilAnchors = {
  "council-lao-tzu": "via negativa",
  "council-feynman": "first-principles reconstruction",
  "council-torvalds": "empirical reduction to practice",
  "council-musashi": "timing and tempo analysis",
  "council-watts": "frame dissolution",
  "council-karpathy": "gradient empiricism",
} as const;

const councilOutputLabels = [
  "- `claims`:",
  "- `risks`:",
  "- `questions`:",
  "- `recommendations`:",
] as const;

const forbiddenImportedPromptInstructions =
  /^[ \t]*(?:model|tools):|\/council\b|\bRound\s+\d+\b|\b\d+\s+words?\s+or\s+(?:less|fewer)\b|\bprovider(?:_affinity|\s+routing)\b|\bcoordinator\b|\bword limit\b|\bengage\s+at\s+least\s+\d+\s+other\s+members?\b|\brespond\s+to\s+peers?\b|\bchallenge\s+other\s+members?\b|Output Format \(Standalone\)/im;

const forbiddenImportedPromptExamples = [
  "model: opus",
  'tools: ["Read", "Bash"]',
  "Run this persona through /council.",
  "Council Round 2",
  "In Round 3 (Synthesis), state your final position.",
  "If the council is past Round 2, act before Round 3.",
  "Contribute your analysis in 300 words or less.",
  'provider_affinity: ["anthropic", "openai"]',
  "Use provider routing for this persona.",
  "Engage at least 2 other members' positions.",
  "Respond to peers before giving your verdict.",
  "Challenge other members when they disagree.",
  "Output Format (Standalone)",
] as const;

const legitimatePromptExamples = [
  "Use a compact model: inputs, outputs, and constraints.",
  "This claim needs peer review.",
  "Model uncertainty explicitly.",
] as const;

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
      "council-feynman",
      "council-karpathy",
      "council-lao-tzu",
      "council-machiavelli",
      "council-musashi",
      "council-socrates",
      "council-sun-tzu",
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

  it("loads Markdown prompt prose from the entity catalog", () => {
    const pragmatic = PersonaDefinitionSchema.parse(getPersona("pragmatic"));

    expect(pragmatic.prompt).toBe(
      "You are the Pragmatic Builder. Identify the smallest useful next experiment, implementation slice, or prototype that would validate the design.",
    );
    expect(pragmatic.useWhen).toEqual([
      "Use for defining minimal experiments, incremental delivery plans, and practical next actions.",
    ]);
  });

  it.each(forbiddenImportedPromptExamples)("rejects imported host instruction: %s", (snippet) => {
    expect(snippet).toMatch(forbiddenImportedPromptInstructions);
  });

  it.each(legitimatePromptExamples)("allows legitimate analytical prose: %s", (snippet) => {
    expect(snippet).not.toMatch(forbiddenImportedPromptInstructions);
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
      for (const outputLabel of councilOutputLabels) {
        expect(persona.prompt).toContain(outputLabel);
      }
      expect(persona.prompt).not.toMatch(forbiddenImportedPromptInstructions);
    }
  });

  it("ships substantive normalized prompts for the practical council personas", () => {
    for (const [id, anchor] of Object.entries(practicalCouncilAnchors)) {
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
      for (const outputLabel of councilOutputLabels) {
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
