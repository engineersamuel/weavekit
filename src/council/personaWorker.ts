import type { PersonaDefinition, RawPersonaResult, RoundBrief } from "./types.js";

type CopilotLikeClient = {
  start(): Promise<void>;
  createSession(config: unknown): Promise<{
    sendAndWait(message: { prompt: string }, timeout?: number): Promise<{ data?: { content?: string } } | undefined>;
    disconnect(): Promise<void>;
  }>;
  // Real SDK returns Error[] on stop; undefined is tolerated for mocks/no-error cases.
  stop(): Promise<Error[] | undefined>;
};

/**
 * Reads stop errors attached to a persona result by `CopilotPersonaWorker`.
 * Returns the array of cleanup errors, or undefined if none were attached.
 */
export function getResultStopErrors(result: RawPersonaResult): Error[] | undefined {
  const r = result as Record<string, unknown>;
  const se = r._stopErrors;
  if (Array.isArray(se) && se.length > 0) return se as Error[];
  return undefined;
}

/**
 * Reads stop errors attached to a propagating error by `CopilotPersonaWorker`.
 * Returns the array of cleanup errors, or undefined if none were attached.
 */
export function getStopErrors(err: unknown): Error[] | undefined {
  if (err !== null && typeof err === "object" && "stopErrors" in err) {
    const se = (err as Record<string, unknown>).stopErrors;
    if (Array.isArray(se) && se.length > 0) return se as Error[];
  }
  return undefined;
}

/**
 * Reads a disconnect error attached to a persona result by `CopilotPersonaWorker`.
 * Returns the error, or undefined if none was attached.
 */
export function getResultDisconnectError(result: RawPersonaResult): Error | undefined {
  const r = result as Record<string, unknown>;
  const de = r._disconnectError;
  if (de instanceof Error) return de;
  return undefined;
}

/**
 * Reads a disconnect error attached to a propagating error by `CopilotPersonaWorker`.
 * Returns the error, or undefined if none was attached.
 */
export function getDisconnectError(err: unknown): Error | undefined {
  if (err !== null && typeof err === "object" && "disconnectError" in err) {
    const de = (err as Record<string, unknown>).disconnectError;
    if (de instanceof Error) return de;
  }
  return undefined;
}

function attachStopErrorsToResult(result: RawPersonaResult, stopErrors: Error[]): void {
  (result as Record<string, unknown>)._stopErrors = stopErrors;
}

function attachDisconnectErrorToResult(result: RawPersonaResult, disconnectErr: unknown): void {
  (result as Record<string, unknown>)._disconnectError = disconnectErr;
}

function attachDisconnectError(err: unknown, disconnectErr: unknown): void {
  if (err !== null && typeof err === "object") {
    (err as Record<string, unknown>).disconnectError = disconnectErr;
  }
}

function attachStopErrors(err: unknown, stopErrors: Error[]): void {
  if (err !== null && typeof err === "object") {
    (err as Record<string, unknown>).stopErrors = stopErrors;
  }
}

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
  private readonly onPermissionRequest: () => { kind: "approved" | "denied" };

  constructor(args: {
    clientFactory?: () => CopilotLikeClient | Promise<CopilotLikeClient>;
    model?: string;
    timeoutMs?: number;
    /** Permission handler for persona sessions. Defaults to deny-by-default. */
    onPermissionRequest?: () => { kind: "approved" | "denied" };
  } = {}) {
    this.clientFactory = args.clientFactory ?? (async () => {
      const { CopilotClient } = await import("@github/copilot-sdk");
      return new CopilotClient() as unknown as CopilotLikeClient;
    });
    this.model = args.model ?? "gpt-5";
    this.timeoutMs = args.timeoutMs ?? 120_000;
    this.onPermissionRequest = args.onPermissionRequest ?? (() => ({ kind: "denied" as const }));
  }

  async runPersona(args: { persona: PersonaDefinition; brief: RoundBrief }): Promise<RawPersonaResult> {
    const { persona, brief } = args;
    const client = await this.clientFactory();
    await client.start();

    let primaryError: unknown = undefined;
    let successResult: RawPersonaResult | undefined = undefined;

    try {
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
        onPermissionRequest: this.onPermissionRequest,
      });

      let sendError: unknown = undefined;
      try {
        const response = await session.sendAndWait({ prompt: buildPersonaPrompt(persona, brief) }, this.timeoutMs);
        const text = response?.data?.content ?? "";

        if (text.trim().length === 0) {
          throw new Error(`Copilot persona ${persona.id} returned an empty response.`);
        }

        successResult = {
          personaId: persona.id,
          text,
          transcript: [`assistant: ${text}`],
          metadata: { model: this.model },
        };
      } catch (err) {
        sendError = err;
        throw err;
      } finally {
        try {
          await session.disconnect();
        } catch (disconnectErr) {
          if (sendError !== undefined) {
            // Preserve original send error; attach disconnect error for inspection.
            attachDisconnectError(sendError, disconnectErr);
          } else {
            // sendAndWait succeeded but disconnect failed — preserve the result and
            // attach the disconnect error for inspection (mirrors stop-error behavior).
            if (successResult !== undefined) {
              attachDisconnectErrorToResult(successResult, disconnectErr);
            }
          }
        }
      }
    } catch (_err) {
      primaryError = _err;
    }

    // Collect stop errors outside the try/finally so that stop() rejections are handled
    // without masking a primary error, and stop errors on the success path don't discard the result.
    let stopErrors: Error[] | undefined;
    try {
      const rawStop = await client.stop();
      if (rawStop && rawStop.length > 0) stopErrors = rawStop;
    } catch (stopRejection) {
      stopErrors = [stopRejection instanceof Error ? stopRejection : new Error(String(stopRejection))];
    }

    if (successResult !== undefined) {
      // Happy path: return the result and surface any cleanup errors for inspection.
      if (stopErrors) {
        attachStopErrorsToResult(successResult, stopErrors);
      }
      return successResult;
    }

    if (primaryError !== undefined) {
      if (stopErrors) {
        attachStopErrors(primaryError, stopErrors);
      }
      throw primaryError;
    }

    throw new Error("runPersona: unreachable state");
  }
}
