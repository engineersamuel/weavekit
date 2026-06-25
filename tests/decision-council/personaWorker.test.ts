import { beforeEach, describe, expect, it, vi } from "vitest";

const runSocraticMock = vi.hoisted(() => vi.fn());
const runDeepModuleDryMock = vi.hoisted(() => vi.fn());
const runPragmaticMock = vi.hoisted(() => vi.fn());
const runSkepticMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/generated/baml_client/index.js", () => ({
  b: {
    RunSocraticQuestioner: runSocraticMock,
    RunDeepModuleDryArchitect: runDeepModuleDryMock,
    RunPragmaticBuilder: runPragmaticMock,
    RunSkeptic: runSkepticMock,
  },
}));

import { BamlPersonaWorker } from "../../src/decision-council/personaWorker.js";
import type { PersonaDefinition, RoundBrief } from "../../src/decision-council/types.js";

const persona: PersonaDefinition = {
  id: "skeptic",
  name: "Skeptic",
  description: "Challenges weak evidence.",
};

const brief: RoundBrief = {
  roundNumber: 1,
  prompt: "Should we use Flue?",
  focus: "Initial critique",
};

describe("persona worker", () => {
  beforeEach(() => {
    runSocraticMock.mockReset();
    runDeepModuleDryMock.mockReset();
    runPragmaticMock.mockReset();
    runSkepticMock.mockReset();
  });

  it("calls the matching BAML persona function for the round brief", async () => {
    runSkepticMock.mockResolvedValue({
      personaId: "skeptic",
      text: "Critique text",
      transcript: ["assistant: Critique text"],
      metadata: { model: "claude-sonnet-4.5" },
    });

    const worker = new BamlPersonaWorker();
    await worker.runPersona({ persona, brief });

    expect(runSkepticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        roundNumber: 1,
        prompt: "Should we use Flue?",
        focus: "Initial critique",
      }),
    );
  });

  it("returns a structured result from the BAML client", async () => {
    runSkepticMock.mockResolvedValue({
      personaId: "skeptic",
      text: "Critique text",
      transcript: ["assistant: Critique text"],
      metadata: { model: "claude-sonnet-4.5" },
    });

    const worker = new BamlPersonaWorker();
    const result = await worker.runPersona({ persona, brief });

    expect(result).toMatchObject({
      personaId: "skeptic",
      text: "Critique text",
      transcript: ["assistant: Critique text"],
    });
  });

  it("throws when the BAML client returns an empty response", async () => {
    runSkepticMock.mockResolvedValue({
      personaId: "skeptic",
      text: "   ",
      transcript: [],
      metadata: {},
    });

    const worker = new BamlPersonaWorker();

    await expect(worker.runPersona({ persona, brief })).rejects.toThrow("returned an empty response");
  });

  it("propagates BAML failures", async () => {
    runSkepticMock.mockRejectedValue(new Error("baml failed"));

    const worker = new BamlPersonaWorker();

    await expect(worker.runPersona({ persona, brief })).rejects.toThrow("baml failed");
  });
});
