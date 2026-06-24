import { describe, expect, it, vi } from "vitest";
import { buildPersonaPrompt, CopilotPersonaWorker } from "../../src/council/personaWorker.js";
import type { PersonaDefinition, RoundBrief } from "../../src/council/types.js";

const persona: PersonaDefinition = {
  id: "skeptic",
  name: "Skeptic",
  description: "Challenges weak evidence.",
  prompt: "Challenge weak evidence.",
};

const brief: RoundBrief = {
  roundNumber: 1,
  prompt: "Should we use Flue?",
  focus: "Initial critique",
};

describe("persona worker", () => {
  it("builds a prompt with persona instructions and round brief", () => {
    const prompt = buildPersonaPrompt(persona, brief);

    expect(prompt).toContain("Challenge weak evidence.");
    expect(prompt).toContain("Round 1");
    expect(prompt).toContain("Should we use Flue?");
  });

  it("returns raw persona text and transcript from Copilot sendAndWait", async () => {
    const session = {
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Critique text" } }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue(session),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const worker = new CopilotPersonaWorker({
      clientFactory: () => client,
      model: "gpt-5",
    });

    const result = await worker.runPersona({ persona, brief });

    expect(result).toMatchObject({
      personaId: "skeptic",
      text: "Critique text",
    });
    expect(result.transcript[0]).toContain("Critique text");
    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5",
        agent: "skeptic",
      }),
    );
  });
});
