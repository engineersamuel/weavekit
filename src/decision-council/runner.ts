import { GeneratedBamlAdapters } from "./bamlAdapters.js";
import { writeDecisionCouncilArtifacts } from "./artifacts.js";
import { runDecisionCouncilLoop, type DecisionCouncilWorkflowDeps } from "./workflow.js";
import { DecisionCouncilRunFailedError } from "./errors.js";
import { errorMessage, timestamp, type DecisionCouncilLogger } from "./logger.js";
import { composeDecisionCouncilLoggers, createOtelDecisionCouncilLogger } from "./otelLogger.js";
import { CopilotPersonaWorker } from "./personaWorker.js";
import { resolvePersonaSet, resolvePersonaSetByName } from "./personas.js";
import { createBamlPersonaSelector, createStaticPersonaSelector, listPersonas } from "../personas/index.js";
import { SpanStatusCode, trace } from "@opentelemetry/api";
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

const tracer = trace.getTracer("weavekit.decision-council");

export async function runDecisionCouncil(input: z.input<typeof DecisionCouncilInputSchema>, options: RunDecisionCouncilOptions = {}): Promise<DecisionCouncilReport> {
  const startedAt = performance.now();
  const runId = `council-${Date.now().toString(36)}`;
  return tracer.startActiveSpan("council-run", async (span) => {
    const logger = composeDecisionCouncilLoggers(options.logger, createOtelDecisionCouncilLogger({ span }));

    try {
      const parsedInput = DecisionCouncilInputSchema.parse(input);
      const explicitPersonaSet = options.personaSet ? resolvePersonaSet(options.personaSet) : undefined;
      let staticPersonaSet = explicitPersonaSet;
      if (!staticPersonaSet) {
        const explicitPersonaSetName = options.personaSetName ?? parsedInput.personaSetName;
        if (explicitPersonaSetName) {
          staticPersonaSet = resolvePersonaSetByName(explicitPersonaSetName);
        }
      }
      const candidatePool = staticPersonaSet ? undefined : listPersonas();
      const personaSelector = staticPersonaSet
        ? createStaticPersonaSelector(staticPersonaSet)
        : (options.deps?.personaSelector ??
          createBamlPersonaSelector({
            candidatePersonas: candidatePool!,
            minPersonas: 2,
            maxPersonas: 6,
          }));
      const runVisiblePersonaSet = staticPersonaSet ?? { name: "candidates", personas: candidatePool! };
      const router = options.router ?? createDefaultModelRouter(defaultRouteModelCall);
      const bamlAdapters = new GeneratedBamlAdapters({ router });
      const maxRounds = options.maxRounds ?? 3;
      const deps: DecisionCouncilWorkflowDeps = {
        personaSelector,
        personaWorker: options.deps?.personaWorker ?? new CopilotPersonaWorker({ router }),
        normalizer: options.deps?.normalizer ?? bamlAdapters,
        judge: options.deps?.judge ?? bamlAdapters,
        logger,
        runId,
      };

      const initialState = createInitialRunState(parsedInput, runVisiblePersonaSet, maxRounds);
      span.setAttribute("weavekit.decision_council.run_id", runId);
      span.setAttribute("weavekit.decision_council.persona_count", initialState.personas.length);
      span.setAttribute("weavekit.decision_council.max_rounds", maxRounds);
      if (options.inputPath) {
        span.setAttribute("weavekit.decision_council.input_path", options.inputPath);
      }
      if (options.outputDir) {
        span.setAttribute("weavekit.decision_council.output_dir", options.outputDir);
      }

      logger.event({
        type: "council.run.started",
        timestamp: timestamp(),
        runId,
        inputPath: options.inputPath,
        outputDir: options.outputDir,
        personaCount: initialState.personas.length,
        maxRounds,
      });

      const finalState = await runDecisionCouncilLoop(initialState, deps);

      if (!finalState.finalReport) {
        throw new DecisionCouncilRunFailedError("Council workflow completed without a final report.");
      }

      if (options.deps?.writeArtifacts !== false) {
        const artifacts = await writeDecisionCouncilArtifacts({
          outputDir: options.outputDir ?? "runs/latest",
          state: finalState,
        });
        logger.event({
          type: "council.artifacts.written",
          timestamp: timestamp(),
          runId,
          reportPath: artifacts.reportPath,
          statePath: artifacts.statePath,
          debugTranscriptCount: artifacts.debugTranscriptPaths.length,
        });
      }

      const durationMs = performance.now() - startedAt;
      logger.event({
        type: "council.run.completed",
        timestamp: timestamp(),
        runId,
        stopReason: finalState.stopReason,
        durationMs,
      });
      if (finalState.stopReason) {
        span.setAttribute("weavekit.decision_council.stop_reason", finalState.stopReason);
      }
      span.setAttribute("weavekit.decision_council.duration_ms", durationMs);
      span.setStatus({ code: SpanStatusCode.OK });

      return finalState.finalReport;
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      logger.event({
        type: "council.run.failed",
        timestamp: timestamp(),
        runId,
        durationMs,
        error: errorMessage(error),
      });
      span.setAttribute("weavekit.decision_council.duration_ms", durationMs);
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
