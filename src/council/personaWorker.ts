import type { PersonaDefinition, RawPersonaResult, RoundBrief } from "./types.js";

type CopilotLikeClient = {
  start(): Promise<void>;
  createSession(config: unknown): Promise<{
    sendAndWait(message: { prompt: string }, timeout?: number): Promise<{ data?: { content?: string } } | undefined>;
    disconnect(): Promise<void>;
  }>;
  stop(): Promise<void>;
};

export type PersonaWorker = {
  runPersona(args: {
    persona: PersonaDefinition;
    brief: RoundBrief;
  }): Promise<RawPersonaResult>;
};

export function buildPersonaPrompt(persona: PersonaDefinition, brief: RoundBrief): string {
  return [
    `You are ${persona.name}.`,
    "",
    persona.prompt,
    "",
    `Round ${brief.roundNumber}`,
    `Focus: ${brief.focus}`,
    "",
    "Design/question:",
    brief.prompt,
    "",
    "Return a concise critique with claims, risks, questions, and recommendations.",
  ].join("\n");
}

export class CopilotPersonaWorker implements PersonaWorker {
  private readonly clientFactory: () => CopilotLikeClient | Promise<CopilotLikeClient>;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(args: {
    clientFactory?: () => CopilotLikeClient | Promise<CopilotLikeClient>;
    model?: string;
    timeoutMs?: number;
  } = {}) {
    this.clientFactory = args.clientFactory ?? (async () => {
      const { CopilotClient } = await import("@github/copilot-sdk");
      return new CopilotClient() as unknown as CopilotLikeClient;
    });
    this.model = args.model ?? "gpt-5";
    this.timeoutMs = args.timeoutMs ?? 120_000;
  }

  async runPersona(args: { persona: PersonaDefinition; brief: RoundBrief }): Promise<RawPersonaResult> {
    const { persona, brief } = args;
    const client = await this.clientFactory();
    await client.start();

    const session = await client.createSession({
      model: this.model,
      agent: persona.id,
      customAgents: [
        {
          name: persona.id,
          displayName: persona.name,
          description: persona.description,
          prompt: persona.prompt,
        },
      ],
      // Approve all permission requests without prompting the user.
      onPermissionRequest: () => true,
    });

    try {
      const response = await session.sendAndWait({ prompt: buildPersonaPrompt(persona, brief) }, this.timeoutMs);
      const text = response?.data?.content ?? "";

      if (text.trim().length === 0) {
        throw new Error(`Copilot persona ${persona.id} returned an empty response.`);
      }

      return {
        personaId: persona.id,
        text,
        transcript: [`assistant: ${text}`],
        metadata: { model: this.model },
      };
    } finally {
      await session.disconnect();
      await client.stop();
    }
  }
}
