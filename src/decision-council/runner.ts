import { GeneratedBamlAdapters } from "./bamlAdapters.js";
import { writeDecisionCouncilArtifacts } from "./artifacts.js";
import { runDecisionCouncilLoop, type DecisionCouncilWorkflowDeps } from "./workflow.js";
import { DecisionCouncilRunFailedError } from "./errors.js";
import { errorMessage, timestamp, type DecisionCouncilLogger } from "./logger.js";
import { CopilotPersonaWorker } from "./personaWorker.js";
import { resolvePersonaSet, resolvePersonaSetByName } from "./personas.js";
import {
  DecisionCouncilInputSchema,
  createInitialRunState,
  type DecisionCouncilReport,
  type PersonaSet,
} from "./types.js";
import type { z } from "zod";
import { createDefaultModelRouter, defaultRouteModelCall, type ModelRouter } from "./modelRouter.js";

export type RunDecisionCouncilOptions = {
  personaSet?: PersonaSet;
  personaSetName?: string;
  maxRounds?: number;
  outputDir?: string;
  inputPath?: string;
  logger?: DecisionCouncilLogger;
  router?: ModelRouter;
  deps?: Partial<DecisionCouncilWorkflowDeps> & {
    writeArtifacts?: boolean;
  };
};

export async function runDecisionCouncil(input: z.input<typeof DecisionCouncilInputSchema>, options: RunDecisionCouncilOptions = {}): Promise<DecisionCouncilReport> {
  const startedAt = performance.now();
  const runId = `council-${Date.now().toString(36)}`;
  const parsedInput = DecisionCouncilInputSchema.parse(input);
  const personaSet = options.personaSet
    ? resolvePersonaSet(options.personaSet)
    : resolvePersonaSetByName(options.personaSetName ?? parsedInput.personaSetName);
  const router = options.router ?? createDefaultModelRouter(defaultRouteModelCall);
  const bamlAdapters = new GeneratedBamlAdapters({ router });
  const maxRounds = options.maxRounds ?? 3;
  const deps: DecisionCouncilWorkflowDeps = {
    personaWorker: options.deps?.personaWorker ?? new CopilotPersonaWorker({ router }),
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
    maxRounds,
  });

  try {
    const initialState = createInitialRunState(parsedInput, personaSet, maxRounds);
    const finalState = await runDecisionCouncilLoop(initialState, deps);

    if (!finalState.finalReport) {
      throw new DecisionCouncilRunFailedError("Council workflow completed without a final report.");
    }

    if (options.deps?.writeArtifacts !== false) {
      const artifacts = await writeDecisionCouncilArtifacts({
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
