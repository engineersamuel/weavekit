import { readdirSync } from "node:fs";
import type { PersonaDefinition, RawPersonaResult, RoundBrief } from "./types.js";
import type { PersonaSkill } from "../personas/schema.js";
import { RouteTaskKind, type ModelRouter } from "./modelRouter.js";
import { composePersonaPrompt } from "../personas/composer.js";

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
  return composePersonaPrompt(persona, { brief });
}

export function buildSkillPersonaMessage(persona: PersonaDefinition, brief: RoundBrief): string {
  const skill = persona.skill!;
  return (
    `/${skill.name} ${brief.prompt}\n\n` +
    `Round ${brief.roundNumber} — ${brief.focus}\n\n` +
    `Produce the complete strategic analysis inline as your direct written response. ` +
    `Do not run shell commands, do not explore the filesystem, and do not spawn sub-agents.\n\n` +
    `End with four lists: claims, risks, questions, recommendations.`
  );
}

export class CopilotPersonaWorker implements PersonaWorker {
  private readonly clientFactory: () => CopilotLikeClient | Promise<CopilotLikeClient>;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly onPermissionRequest: () => { kind: "approved" | "denied" };
  private readonly router?: ModelRouter;
  private readonly supportsReasoningEffort: (model: string) => boolean;
  private readonly ensureSkill: (skill: PersonaSkill) => Promise<string>;

  constructor(args: {
    clientFactory?: () => CopilotLikeClient | Promise<CopilotLikeClient>;
    model?: string;
    timeoutMs?: number;
    /** Permission handler for persona sessions. Defaults to deny-by-default. */
    onPermissionRequest?: () => { kind: "approved" | "denied" };
    router?: ModelRouter;
    supportsReasoningEffort?: (model: string) => boolean;
    ensureSkill?: (skill: PersonaSkill) => Promise<string>;
  } = {}) {
    this.clientFactory = args.clientFactory ?? (async () => {
      const { CopilotClient } = await import("@github/copilot-sdk");
      return new CopilotClient() as unknown as CopilotLikeClient;
    });
    this.model = args.model ?? "claude-sonnet-4.5";
    this.timeoutMs = args.timeoutMs ?? 120_000;
    this.onPermissionRequest = args.onPermissionRequest ?? (() => ({ kind: "denied" as const }));
    this.router = args.router;
    this.supportsReasoningEffort = args.supportsReasoningEffort ?? (() => false);
    this.ensureSkill = args.ensureSkill ?? (async (skill) => {
      const { ensureSkillInstalled } = await import("../personas/skillInstaller.js");
      return ensureSkillInstalled({ skill });
    });
  }

  async runPersona(args: { persona: PersonaDefinition; brief: RoundBrief }): Promise<RawPersonaResult> {
    const { persona, brief } = args;
    const client = await this.clientFactory();
    await client.start();

    let primaryError: unknown = undefined;
    let successResult: RawPersonaResult | undefined = undefined;

    try {
      const decision = this.router
        ? await this.router.route({
            taskKind: RouteTaskKind.PERSONA,
            personaId: persona.id,
            roundNumber: brief.roundNumber,
            summary: brief.prompt,
          })
        : undefined;
      const model = decision?.model ?? this.model;

      // Covers both the inline-agent shape and the skill-backed shape.
      type SessionConfig = {
        model: string;
        reasoningEffort?: string;
        agent?: string;
        customAgents?: Array<{ name: string; displayName: string; description: string; prompt: string }>;
        skillDirectories?: string[];
        disabledSkills?: string[];
        onPermissionRequest: () => { kind: "approved" | "denied" };
      };

      let sessionConfig: SessionConfig;
      let message: string;

      if (persona.skill) {
        const skillsDir = await this.ensureSkill(persona.skill);
        const allDirs = readdirSync(skillsDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        const disabledSkills = allDirs.filter(name => name !== persona.skill!.name);
        sessionConfig = {
          model,
          skillDirectories: [skillsDir],
          disabledSkills,
          onPermissionRequest: this.onPermissionRequest,
        };
        if (decision?.reasoningEffort && this.supportsReasoningEffort(model)) {
          sessionConfig.reasoningEffort = decision.reasoningEffort;
        }
        message = buildSkillPersonaMessage(persona, brief);
      } else {
        sessionConfig = {
          model,
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
        };
        if (decision?.reasoningEffort && this.supportsReasoningEffort(model)) {
          sessionConfig.reasoningEffort = decision.reasoningEffort;
        }
        message = buildPersonaPrompt(persona, brief);
      }

      const session = await client.createSession(sessionConfig);

      let sendError: unknown = undefined;
      try {
        const response = await session.sendAndWait({ prompt: message }, this.timeoutMs);
        const text = response?.data?.content ?? "";

        if (text.trim().length === 0) {
          throw new Error(`Copilot persona ${persona.id} returned an empty response.`);
        }

        successResult = {
          personaId: persona.id,
          text,
          transcript: [`assistant: ${text}`],
          metadata: persona.skill ? { model, skill: persona.skill.name } : { model },
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
