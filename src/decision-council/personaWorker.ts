import { b } from "../generated/baml_client/index.js";
import type { PersonaDefinition, RawPersonaResult, RoundBrief } from "./types.js";

const personaRunners: Record<string, (brief: RoundBrief) => Promise<RawPersonaResult>> = {
  socratic: (brief) => b.RunSocraticQuestioner(brief),
  "deep-module-dry": (brief) => b.RunDeepModuleDryArchitect(brief),
  pragmatic: (brief) => b.RunPragmaticBuilder(brief),
  skeptic: (brief) => b.RunSkeptic(brief),
};

/**
 * Reads stop errors attached to a persona result by `BamlPersonaWorker`.
 * Returns the array of cleanup errors, or undefined if none were attached.
 */
export function getResultStopErrors(result: RawPersonaResult): Error[] | undefined {
  const r = result as unknown as Record<string, unknown>;
  const se = r._stopErrors;
  if (Array.isArray(se) && se.length > 0) return se as Error[];
  return undefined;
}

/**
 * Reads stop errors attached to a propagating error by `BamlPersonaWorker`.
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
 * Reads a disconnect error attached to a persona result by `BamlPersonaWorker`.
 * Returns the error, or undefined if none was attached.
 */
export function getResultDisconnectError(result: RawPersonaResult): Error | undefined {
  const r = result as unknown as Record<string, unknown>;
  const de = r._disconnectError;
  if (de instanceof Error) return de;
  return undefined;
}

/**
 * Reads a disconnect error attached to a propagating error by `BamlPersonaWorker`.
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
  (result as unknown as Record<string, unknown>)._stopErrors = stopErrors;
}

function attachDisconnectErrorToResult(result: RawPersonaResult, disconnectErr: unknown): void {
  (result as unknown as Record<string, unknown>)._disconnectError = disconnectErr;
}

function attachDisconnectError(err: unknown, disconnectErr: unknown): void {
  if (err !== null && typeof err === "object") {
    (err as unknown as Record<string, unknown>).disconnectError = disconnectErr;
  }
}

function attachStopErrors(err: unknown, stopErrors: Error[]): void {
  if (err !== null && typeof err === "object") {
    (err as unknown as Record<string, unknown>).stopErrors = stopErrors;
  }
}

export type PersonaWorker = {
  runPersona(args: {
    persona: PersonaDefinition;
    brief: RoundBrief;
  }): Promise<RawPersonaResult>;
};

export class BamlPersonaWorker implements PersonaWorker {
  private readonly model: string;

  constructor(args: { model?: string } = {}) {
    this.model = args.model ?? "claude-sonnet-4.5";
  }

  async runPersona(args: { persona: PersonaDefinition; brief: RoundBrief }): Promise<RawPersonaResult> {
    const { persona, brief } = args;
    const runner = personaRunners[persona.id];

    if (!runner) {
      throw new Error(`No BAML persona runner is registered for persona "${persona.id}".`);
    }

    try {
      const result = await runner(brief);

      if (result.text.trim().length === 0) {
        throw new Error(`BAML persona ${persona.id} returned an empty response.`);
      }

      return {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          model: this.model,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("empty response")) {
        throw error;
      }

      throw error;
    }
  }
}
