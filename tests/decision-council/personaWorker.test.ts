import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import {
  buildPersonaPrompt,
  CopilotPersonaWorker,
  getDisconnectError,
  getResultDisconnectError,
  getResultStopErrors,
  getStopErrors,
  resolveCopilotCliPath,
} from "../../src/decision-council/personaWorker.js";
import type { PersonaDefinition, RoundBrief } from "../../src/decision-council/types.js";
import type { ModelRouter } from "../../src/decision-council/modelRouter.js";

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

  it("resolves the installed Copilot CLI npm loader used by the SDK", () => {
    const cliPath = resolveCopilotCliPath();

    expect(cliPath).toContain("@github/copilot");
    expect(cliPath).toMatch(/npm-loader\.js$/);
    expect(existsSync(cliPath)).toBe(true);
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

  it("default onPermissionRequest handler denies all requests", async () => {
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
    expect(handler()).toEqual({ kind: "denied" });
  });

  it("uses the Copilot CLI default model when no model is supplied", async () => {
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
    });

    await worker.runPersona({ persona, brief });

    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4.5",
      }),
    );
  });

  it("accepts a caller-supplied onPermissionRequest handler that can approve", async () => {
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
      onPermissionRequest: () => ({ kind: "approved" as const }),
    });

    await worker.runPersona({ persona, brief });

    const config = client.createSession.mock.calls[0][0] as Record<string, unknown>;
    const handler = config.onPermissionRequest as () => unknown;
    expect(handler()).toEqual({ kind: "approved" });
  });

  it("returns persona result and makes stop errors inspectable when sendAndWait succeeds", async () => {
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

    const result = await worker.runPersona({ persona, brief });
    expect(result.text).toBe("Response");
    const stopErrs = getResultStopErrors(result);
    expect(stopErrs).toHaveLength(1);
    expect(stopErrs![0].message).toBe("cleanup failed");
  });

  it("attaches stop errors to the thrown error when both sendAndWait and stop fail", async () => {
    const session = {
      sendAndWait: vi.fn().mockRejectedValue(new Error("send failed")),
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
    // Original error must still propagate
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("send failed");
    // Stop errors must be attached, not silently dropped
    expect(getStopErrors(err)).toHaveLength(1);
    expect(getStopErrors(err)![0].message).toBe("cleanup failed");
  });

  it("preserves send error when disconnect also throws; disconnect error is inspectable", async () => {
    const session = {
      sendAndWait: vi.fn().mockRejectedValue(new Error("send failed")),
      disconnect: vi.fn().mockRejectedValue(new Error("disconnect failed")),
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

    const err = await worker.runPersona({ persona, brief }).catch((e: unknown) => e);
    // Original send error must still propagate
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("send failed");
    // Disconnect error must be inspectable, not silently lost
    expect(getDisconnectError(err)).toBeInstanceOf(Error);
    expect((getDisconnectError(err) as Error).message).toBe("disconnect failed");
  });

  it("when sendAndWait succeeds but disconnect throws, returns the result and makes disconnect error inspectable", async () => {
    const session = {
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Success text" } }),
      disconnect: vi.fn().mockRejectedValue(new Error("disconnect failed")),
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

    // Must NOT throw — the main operation succeeded
    const result = await worker.runPersona({ persona, brief });
    expect(result.text).toBe("Success text");
    expect(result.personaId).toBe("skeptic");
    // Disconnect error must be inspectable on the result
    const de = getResultDisconnectError(result);
    expect(de).toBeInstanceOf(Error);
    expect(de!.message).toBe("disconnect failed");
  });
});

describe("persona worker routing", () => {
  it("threads routed model and reasoningEffort into createSession", async () => {
    const session = {
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Critique text" } }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue(session),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const router: ModelRouter = {
      async route() {
        return { model: "gpt-5.4", reasoningEffort: "medium", rationale: "tier" };
      },
    };

    const worker = new CopilotPersonaWorker({
      clientFactory: () => client,
      router,
      supportsReasoningEffort: () => true,
    });
    const result = await worker.runPersona({ persona, brief });

    const config = client.createSession.mock.calls[0]![0] as { model: string; reasoningEffort?: string };
    expect(config.model).toBe("gpt-5.4");
    expect(config.reasoningEffort).toBe("medium");
    expect(result.metadata.model).toBe("gpt-5.4");
  });

  it("omits reasoningEffort when the model does not support it, even if routed", async () => {
    const session = {
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Critique text" } }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue(session),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const router: ModelRouter = {
      async route() {
        return { model: "claude-sonnet-4.5", reasoningEffort: "high", rationale: "tier" };
      },
    };

    // No supportsReasoningEffort predicate -> default () => false -> effort omitted.
    const worker = new CopilotPersonaWorker({ clientFactory: () => client, router });
    await worker.runPersona({ persona, brief });

    const config = client.createSession.mock.calls[0]![0] as { model: string; reasoningEffort?: string };
    expect(config.model).toBe("claude-sonnet-4.5");
    expect(config.reasoningEffort).toBeUndefined();
  });

  it("omits reasoningEffort and uses the constructor model when no router is set", async () => {
    const session = {
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Critique text" } }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue(session),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const worker = new CopilotPersonaWorker({ clientFactory: () => client, model: "claude-sonnet-4.5" });
    await worker.runPersona({ persona, brief });

    const config = client.createSession.mock.calls[0]![0] as { model: string; reasoningEffort?: string };
    expect(config.model).toBe("claude-sonnet-4.5");
    expect(config.reasoningEffort).toBeUndefined();
  });
});
