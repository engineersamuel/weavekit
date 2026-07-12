import { GeneratedBamlAdapters } from "./bamlAdapters.js";
import { writeDecisionCouncilArtifacts } from "./artifacts.js";
import { runDecisionCouncilLoop, type DecisionCouncilWorkflowDeps } from "./workflow.js";
import { DecisionCouncilRunFailedError } from "./errors.js";
import { errorMessage, timestamp, type DecisionCouncilLogger } from "./logger.js";
import { composeDecisionCouncilLoggers, createOtelDecisionCouncilLogger } from "./otelLogger.js";
import { CopilotPersonaWorker } from "./personaWorker.js";
import { SkipSource } from "./elicitation.js";
import { createBamlPersonaSelector, listPersonas } from "../personas/index.js";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { setSerializedAttribute } from "./bamlTelemetry.js";
import {
  DecisionCouncilInputSchema,
  createInitialRunState,
  type DecisionCouncilReport,
  type DecisionCouncilRunState,
} from "./types.js";
import type { z } from "zod";
import {
  createDefaultModelRouter,
  defaultRouteModelCall,
  type ModelRouter,
} from "./modelRouter.js";

export type RunDecisionCouncilOptions = {
  maxRounds?: number;
  outputDir?: string;
  inputPath?: string;
  logger?: DecisionCouncilLogger;
  router?: ModelRouter;
  smoke?: boolean;
  deps?: Partial<DecisionCouncilWorkflowDeps> & {
    writeArtifacts?: boolean;
  };
  /**
   * Additive hook invoked with the full final run state once the council loop completes
   * successfully. Callers that only need the DecisionCouncilReport can ignore this; callers
   * that need round-level detail not present on the report (e.g. the persona ids actually
   * selected via rounds[].personaSelection.personaIds) can read it from here without changing
   * the runDecisionCouncil return type.
   */
  onRunState?: (state: DecisionCouncilRunState) => void;
};

const tracer = trace.getTracer("weavekit.decision-council");

function traceIdFor(span: { spanContext(): { traceId?: string } }): string | undefined {
  const traceId = span.spanContext().traceId;
  return traceId && traceId !== "00000000000000000000000000000000" ? traceId : undefined;
}

export async function runDecisionCouncil(
  input: z.input<typeof DecisionCouncilInputSchema>,
  options: RunDecisionCouncilOptions = {},
): Promise<DecisionCouncilReport> {
  const { assertValidEntityCatalog } = await import("../entities/index.js");
  assertValidEntityCatalog(process.cwd());

  const startedAt = performance.now();
  const runId = `council-${Date.now().toString(36)}`;
  return tracer.startActiveSpan("council-run", async (span) => {
    const traceId = traceIdFor(span);
    const logger = composeDecisionCouncilLoggers(
      options.logger,
      createOtelDecisionCouncilLogger({ span }),
    );

    try {
      const parsedInput = DecisionCouncilInputSchema.parse(input);
      span.setAttribute("langfuse.trace.name", "council-run");
      setSerializedAttribute(span, "langfuse.trace.input", parsedInput);
      setSerializedAttribute(span, "langfuse.observation.input", parsedInput);
      const candidatePool = listPersonas();
      const personaSelector =
        options.deps?.personaSelector ??
        createBamlPersonaSelector({
          candidatePersonas: candidatePool,
          minPersonas: 2,
          maxPersonas: options.smoke ? 2 : 6,
        });
      const runVisiblePersonas = { name: "candidates" as const, personas: candidatePool };
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
        elicitation: options.deps?.elicitation ?? new SkipSource(),
      };

      const initialState = createInitialRunState(parsedInput, runVisiblePersonas, maxRounds);
      span.setAttribute("weavekit.decision_council.run_id", runId);
      span.setAttribute("weavekit.decision_council.persona_count", initialState.personas.length);
      span.setAttribute("weavekit.decision_council.max_rounds", maxRounds);
      const skillPersonas = initialState.personas
        .filter((p) => p.skill?.name)
        .map((p) => p.skill!.name);
      if (skillPersonas.length > 0) {
        span.setAttribute("weavekit.decision_council.skill_personas", skillPersonas.join(","));
      }
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
        traceId,
        inputPath: options.inputPath,
        outputDir: options.outputDir,
        personaCount: initialState.personas.length,
        maxRounds,
      });

      const finalState = await runDecisionCouncilLoop(initialState, deps);

      if (!finalState.finalReport) {
        throw new DecisionCouncilRunFailedError(
          "Council workflow completed without a final report.",
        );
      }

      options.onRunState?.(finalState);

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
        traceId,
        stopReason: finalState.stopReason,
        durationMs,
      });
      if (finalState.stopReason) {
        span.setAttribute("weavekit.decision_council.stop_reason", finalState.stopReason);
      }
      span.setAttribute("weavekit.decision_council.duration_ms", durationMs);
      setSerializedAttribute(span, "langfuse.trace.output", finalState.finalReport);
      setSerializedAttribute(span, "langfuse.observation.output", finalState.finalReport);
      span.setStatus({ code: SpanStatusCode.OK });

      return finalState.finalReport;
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      logger.event({
        type: "council.run.failed",
        timestamp: timestamp(),
        runId,
        traceId,
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
