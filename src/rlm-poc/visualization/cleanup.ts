import { rm } from "node:fs/promises";
import { join } from "node:path";
import { RLM_VISUALIZATION_DIRECTORY } from "./contracts.js";

/**
 * Removes the run's storyboard directory so a new visualized run cannot inherit the artifacts of
 * the previous one.
 *
 * A storyboard is rewritten in place on every update, so a run that never renders - or that dies
 * before its first completion - would otherwise leave the earlier run's HTML, PNG, and state on
 * disk, where `RlmDirectExecutor.collect` would attach them as if they described this attempt.
 *
 * Only the fixed `.weavekit/rlm-visualization` directory is removed, never `.weavekit` itself,
 * which holds the prompt, log, and manifest files of the same run.
 */
export async function clearRlmVisualizationArtifacts(workingDirectory: string): Promise<void> {
  await rm(join(workingDirectory, RLM_VISUALIZATION_DIRECTORY), { recursive: true, force: true });
}
