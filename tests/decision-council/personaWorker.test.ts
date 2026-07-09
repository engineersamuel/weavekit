import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPersonaPrompt,
  buildSkillPersonaMessage,
  CopilotPersonaWorker,
  getDisconnectError,
  getResultDisconnectError,
  getResultStopErrors,
  getStopErrors,
} from "../../src/decision-council/personaWorker.js";
import {
  PersonaDefinitionSchema,
  type PersonaDefinition,
  type RoundBrief,
} from "../../src/decision-council/types.js";
import type { ModelRouter } from "../../src/decision-council/modelRouter.js";

const persona: PersonaDefinition = PersonaDefinitionSchema.parse({
  id: "skeptic",
  name: "Skeptic",
  description: "Challenges weak evidence.",
  prompt: "Challenge weak evidence.",
  role: "reviewer",
  tags: ["risk"],
  useWhen: ["Use for risk discovery."],
  avoidWhen: ["Avoid for advocacy."],
});

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

  it("uses the persona worker default model when no model is supplied", async () => {
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
        model: "claude-sonnet-5",
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

    const config = client.createSession.mock.calls[0]![0] as {
      model: string;
      reasoningEffort?: string;
    };
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

    const config = client.createSession.mock.calls[0]![0] as {
      model: string;
      reasoningEffort?: string;
    };
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

    const worker = new CopilotPersonaWorker({
      clientFactory: () => client,
      model: "claude-sonnet-4.5",
    });
    await worker.runPersona({ persona, brief });

    const config = client.createSession.mock.calls[0]![0] as {
      model: string;
      reasoningEffort?: string;
    };
    expect(config.model).toBe("claude-sonnet-4.5");
    expect(config.reasoningEffort).toBeUndefined();
  });
});

describe("persona worker — skill-backed branch", () => {
  const skillPersona = PersonaDefinitionSchema.parse({
    id: "mckinsey-strategist",
    name: "McKinsey",
    description: "d",
    prompt: "p",
    role: "advisor",
    tags: ["strategy"],
    useWhen: ["Use for strategy."],
    avoidWhen: ["Avoid for implementation detail."],
    skill: { name: "mckinsey-strategist" },
  });

  const skillBrief: RoundBrief = {
    roundNumber: 2,
    prompt: "Should we enter the Asian market?",
    focus: "Strategic analysis",
  };

  it("uses skillDirectories+disabledSkills config and no customAgents for skill-backed persona", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "weavekit-test-"));
    mkdirSync(join(tmpBase, "mckinsey-strategist"));
    mkdirSync(join(tmpBase, "other-skill"));
    try {
      const session = {
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Strategic analysis" } }),
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
        ensureSkill: async () => tmpBase,
      });

      const result = await worker.runPersona({ persona: skillPersona, brief: skillBrief });

      const config = client.createSession.mock.calls[0]![0] as Record<string, unknown>;
      expect(config.skillDirectories).toEqual([tmpBase]);
      expect(config.disabledSkills).toEqual(["other-skill"]);
      expect(config).not.toHaveProperty("customAgents");
      expect(config).not.toHaveProperty("agent");
      expect(result.metadata.skill).toBe("mckinsey-strategist");
      expect(result.metadata.model).toBe("gpt-5");
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("sends a message starting with /mckinsey-strategist for skill-backed persona", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "weavekit-test-"));
    mkdirSync(join(tmpBase, "mckinsey-strategist"));
    try {
      const session = {
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Analysis" } }),
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
        ensureSkill: async () => tmpBase,
      });

      await worker.runPersona({ persona: skillPersona, brief: skillBrief });

      const [msg] = session.sendAndWait.mock.calls[0]!;
      expect((msg as { prompt: string }).prompt).toMatch(/^\/mckinsey-strategist /);
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("records skill name in result metadata for skill-backed persona", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "weavekit-test-"));
    mkdirSync(join(tmpBase, "mckinsey-strategist"));
    try {
      const session = {
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Analysis" } }),
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
        ensureSkill: async () => tmpBase,
      });

      const result = await worker.runPersona({ persona: skillPersona, brief: skillBrief });
      expect(result.metadata.skill).toBe("mckinsey-strategist");
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("rejects and never calls createSession when ensureSkill rejects", async () => {
    const client = {
      start: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const worker = new CopilotPersonaWorker({
      clientFactory: () => client,
      model: "gpt-5",
      ensureSkill: async () => {
        throw new Error("install failed");
      },
    });

    await expect(worker.runPersona({ persona: skillPersona, brief: skillBrief })).rejects.toThrow(
      "install failed",
    );
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("buildSkillPersonaMessage starts with the slash-command and includes round/focus/guard", () => {
    const msg = buildSkillPersonaMessage(skillPersona, skillBrief);
    expect(msg).toMatch(/^\/mckinsey-strategist /);
    expect(msg).toContain("Round 2");
    expect(msg).toContain("Strategic analysis");
    expect(msg).toContain("inline");
    expect(msg).toContain("claims");
  });
});
