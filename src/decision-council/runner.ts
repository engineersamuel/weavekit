import { GeneratedBamlAdapters } from "./bamlAdapters.js";
import { writeCouncilArtifacts } from "./artifacts.js";
import { runCouncilLoop, type CouncilWorkflowDeps } from "./workflow.js";
import { CouncilRunFailedError } from "./errors.js";
import { errorMessage, timestamp, type CouncilLogger } from "./logger.js";
import { BamlPersonaWorker } from "./personaWorker.js";
import { resolvePersonaSet } from "./personas.js";
import {
  CouncilInputSchema,
  createInitialRunState,
  type CouncilReport,
  type PersonaSet,
} from "./types.js";
import type { z } from "zod";

export type RunCouncilOptions = {
  personaSet?: PersonaSet;
  outputDir?: string;
  inputPath?: string;
  logger?: CouncilLogger;
  deps?: Partial<CouncilWorkflowDeps> & {
    writeArtifacts?: boolean;
  };
};

export async function runCouncil(input: z.input<typeof CouncilInputSchema>, options: RunCouncilOptions = {}): Promise<CouncilReport> {
  const startedAt = performance.now();
  const runId = `council-${Date.now().toString(36)}`;
  const parsedInput = CouncilInputSchema.parse(input);
  const personaSet = resolvePersonaSet(options.personaSet);
  const bamlAdapters = new GeneratedBamlAdapters();
  const deps: CouncilWorkflowDeps = {
    personaWorker: options.deps?.personaWorker ?? new BamlPersonaWorker(),
    normalizer: options.deps?.normalizer ?? bamlAdapters,
    judge: options.deps?.judge ?? bamlAdapters,
    logger: options.logger,
    runId,
  };

  options.logger?.event({
    type: "council.run.started",
    timestamp: timestamp(),
    runId,
    inputPath: options.inputPath,
    outputDir: options.outputDir,
    personaCount: personaSet.personas.length,
    maxRounds: 3,
  });

  try {
    const initialState = createInitialRunState(parsedInput, personaSet);
    const finalState = await runCouncilLoop(initialState, deps);

    if (!finalState.finalReport) {
      throw new CouncilRunFailedError("Council workflow completed without a final report.");
    }

    if (options.deps?.writeArtifacts !== false) {
      const artifacts = await writeCouncilArtifacts({
        outputDir: options.outputDir ?? "runs/latest",
        state: finalState,
      });
      options.logger?.event({
        type: "council.artifacts.written",
        timestamp: timestamp(),
        runId,
        reportPath: artifacts.reportPath,
        statePath: artifacts.statePath,
        debugTranscriptCount: artifacts.debugTranscriptPaths.length,
      });
    }

    options.logger?.event({
      type: "council.run.completed",
      timestamp: timestamp(),
      runId,
      stopReason: finalState.stopReason,
      durationMs: performance.now() - startedAt,
    });

    return finalState.finalReport;
  } catch (error) {
    options.logger?.event({
      type: "council.run.failed",
      timestamp: timestamp(),
      runId,
      durationMs: performance.now() - startedAt,
      error: errorMessage(error),
    });
    throw error;
  }
}

export const runDecisionCouncil = runCouncil;
export type RunDecisionCouncilOptions = RunCouncilOptions;
