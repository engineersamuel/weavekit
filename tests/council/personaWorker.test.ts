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

  it("calls client.stop() even when createSession throws", async () => {
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockRejectedValue(new Error("session failed")),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const worker = new CopilotPersonaWorker({
      clientFactory: () => client,
      model: "gpt-5",
    });

    await expect(worker.runPersona({ persona, brief })).rejects.toThrow("session failed");
    expect(client.stop).toHaveBeenCalled();
  });

  it("onPermissionRequest handler returns approved shape", async () => {
    const session = {
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Response" } }),
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

    await worker.runPersona({ persona, brief });

    const config = client.createSession.mock.calls[0][0] as Record<string, unknown>;
    const handler = config.onPermissionRequest as () => unknown;
    expect(handler()).toEqual({ kind: "approved" });
  });

  it("surfaces stop errors when there is no earlier error", async () => {
    const session = {
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Response" } }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue(session),
      stop: vi.fn().mockResolvedValue([new Error("cleanup failed")]),
    };

    const worker = new CopilotPersonaWorker({
      clientFactory: () => client,
      model: "gpt-5",
    });

    const err = await worker.runPersona({ persona, brief }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors[0]).toMatchObject({ message: "cleanup failed" });
  });
});
