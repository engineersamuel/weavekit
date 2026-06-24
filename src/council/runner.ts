import { GeneratedBamlAdapters } from "./bamlAdapters.js";
import { writeCouncilArtifacts } from "./artifacts.js";
import { runCouncilLoop, createCouncilWorkflow, type CouncilWorkflowDeps } from "./workflow.js";
import { CouncilRunFailedError } from "./errors.js";
import { CopilotPersonaWorker } from "./personaWorker.js";
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
  deps?: Partial<CouncilWorkflowDeps> & {
    writeArtifacts?: boolean;
  };
};

export async function runCouncil(input: z.input<typeof CouncilInputSchema>, options: RunCouncilOptions = {}): Promise<CouncilReport> {
  const parsedInput = CouncilInputSchema.parse(input);
  const personaSet = resolvePersonaSet(options.personaSet);
  const bamlAdapters = new GeneratedBamlAdapters();
  const deps: CouncilWorkflowDeps = {
    personaWorker: options.deps?.personaWorker ?? new CopilotPersonaWorker(),
    normalizer: options.deps?.normalizer ?? bamlAdapters,
    judge: options.deps?.judge ?? bamlAdapters,
  };

  const initialState = createInitialRunState(parsedInput, personaSet);
  const finalState = await runCouncilLoop(initialState, deps);

  if (!finalState.finalReport) {
    throw new CouncilRunFailedError("Council workflow completed without a final report.");
  }

  if (options.deps?.writeArtifacts !== false) {
    await writeCouncilArtifacts({
      outputDir: options.outputDir ?? "runs/latest",
      state: finalState,
    });
  }

  return finalState.finalReport;
}
