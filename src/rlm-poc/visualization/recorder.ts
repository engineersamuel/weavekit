import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeRlmOutput } from "../environment.js";
import {
  RLM_VISUALIZATION_DIRECTORY,
  RLM_VISUALIZATION_HTML_PATH,
  RLM_VISUALIZATION_PNG_PATH,
  RLM_VISUALIZATION_STATE_PATH,
  RlmStoryboardContractError,
  RlmStoryboardRendererName,
  RlmVisualizationRunStatus,
  type RlmStoryboard,
  type RlmStoryboardRasterizer,
  type RlmStoryboardRenderer,
  type RlmVisualizationArtifacts,
  type RlmVisualizationCompletion,
  type RlmVisualizationDiagnostic,
  type RlmVisualizationEvent,
  type RlmVisualizationObserver,
  type RlmVisualizationState,
} from "./contracts.js";
import { buildVisualizationHtml } from "./html.js";
import { bounded, buildFallbackStoryboard, buildStoryboardLedger } from "./storyboard.js";
import { sanitizeStoryboardSvg } from "./svg.js";

const MAX_NARRATIVE_BEATS = 60;
const MAX_DIAGNOSTICS = 50;

export type RlmVisualizationRecorder = RlmVisualizationObserver & {
  /** Writes the initial prompt frame and schedules its model enhancement. */
  initialize(): Promise<void>;
  /** Records terminal state, supersedes pending work, and waits for the final rendered frame. */
  finalize(input: {
    status: typeof RlmVisualizationRunStatus.Succeeded | typeof RlmVisualizationRunStatus.Failed;
    summary: string;
  }): Promise<RlmVisualizationArtifacts>;
  /** Worktree-relative artifact paths plus the non-fatal failures observed so far. */
  artifacts(): RlmVisualizationArtifacts;
};

export type CreateRlmVisualizationRecorderOptions = {
  /** Run's working directory. Artifacts land in `<workingDirectory>/.weavekit/rlm-visualization`. */
  workingDirectory: string;
  runId: string;
  objective: string;
  rendererName?: RlmStoryboardRendererName;
  renderer: RlmStoryboardRenderer;
  rasterizer: RlmStoryboardRasterizer;
  now?: () => Date;
  log?: (message: string) => void;
};

/**
 * Keeps one cumulative storyboard current without making slow model rendering part of the
 * recursive execution critical path.
 *
 * State mutations and atomic state writes use a short serialized queue. Model renders use one
 * separate persistent-session worker with one latest pending snapshot, so completions can continue
 * while Gemini works and stale model responses can never overwrite a newer revision.
 */
export function createRlmVisualizationRecorder(
  options: CreateRlmVisualizationRecorderOptions,
): RlmVisualizationRecorder {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? writeRlmOutput;
  const directory = join(options.workingDirectory, RLM_VISUALIZATION_DIRECTORY);
  const htmlPath = join(options.workingDirectory, RLM_VISUALIZATION_HTML_PATH);
  const pngPath = join(options.workingDirectory, RLM_VISUALIZATION_PNG_PATH);
  const statePath = join(options.workingDirectory, RLM_VISUALIZATION_STATE_PATH);
  const startedAt = now().toISOString();
  const state: RlmVisualizationState = {
    schemaVersion: 1,
    runId: options.runId,
    objective: bounded(options.objective, 2000),
    renderer: options.rendererName ?? RlmStoryboardRendererName.Custom,
    startedAt,
    updatedAt: startedAt,
    revision: 0,
    runStatus: RlmVisualizationRunStatus.Running,
    events: [],
    diagnostics: [],
  };

  let sequence = 0;
  let temporaryCounter = 0;
  let lastStoryboard: RlmStoryboard | undefined;
  let stateQueue: Promise<void> = Promise.resolve();
  let renderWorker: Promise<void> | undefined;
  let pendingRender: RlmVisualizationState | undefined;
  let initialized = false;
  let finalized = false;
  let rendererDisposed = false;

  function diagnose(stage: RlmVisualizationDiagnostic["stage"], error: unknown): void {
    const message = bounded(error instanceof Error ? error.message : String(error), 400);
    state.diagnostics.push({ observedAt: now().toISOString(), stage, message });
    if (state.diagnostics.length > MAX_DIAGNOSTICS) {
      state.diagnostics.splice(0, state.diagnostics.length - MAX_DIAGNOSTICS);
    }
    log(`[visualization] ${stage} step failed: ${message}\n`);
  }

  async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
    temporaryCounter += 1;
    const temporary = `${path}.${process.pid}.${temporaryCounter}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, path);
  }

  async function writeState(): Promise<void> {
    try {
      await writeAtomic(statePath, `${JSON.stringify(state, undefined, 2)}\n`);
    } catch (error) {
      diagnose("state", error);
    }
  }

  function snapshotState(): RlmVisualizationState {
    return structuredClone(state);
  }

  function enqueueState(operation: () => Promise<void>): Promise<void> {
    const result = stateQueue.then(operation, operation).catch((error: unknown) => {
      diagnose("state", error);
    });
    stateQueue = result;
    return result;
  }

  async function recordDiagnostic(
    stage: RlmVisualizationDiagnostic["stage"],
    error: unknown,
  ): Promise<void> {
    await enqueueState(async () => {
      diagnose(stage, error);
      await writeState();
    });
  }

  async function persistRevision(input: { initial: boolean }): Promise<RlmVisualizationState> {
    state.revision += 1;
    state.updatedAt = now().toISOString();
    try {
      await mkdir(directory, { recursive: true });
    } catch (error) {
      diagnose("state", error);
      return snapshotState();
    }

    // State is always durable before any HTML, PNG, or model operation begins.
    await writeState();
    const snapshot = snapshotState();
    const immediateStoryboard = lastStoryboard ?? buildFallbackStoryboard(snapshot);
    const diagnosticsBefore = state.diagnostics.length;
    try {
      await writeAtomic(htmlPath, buildVisualizationHtml(snapshot, immediateStoryboard));
    } catch (error) {
      diagnose("html", error);
    }
    if (input.initial) {
      try {
        await writeAtomic(pngPath, await options.rasterizer(immediateStoryboard.svg));
      } catch (error) {
        diagnose("rasterize", error);
      }
    }
    if (state.diagnostics.length !== diagnosticsBefore) {
      await writeState();
    }
    return snapshotState();
  }

  function scheduleRender(snapshot: RlmVisualizationState): void {
    // Latest wins while one model turn is active. Every event remains in state and in the full
    // ledger carried by the replacement snapshot.
    pendingRender = snapshot;
    if (renderWorker) return;

    const worker = runRenderWorker()
      .catch((error: unknown) => recordDiagnostic("render", error))
      .then(() => undefined)
      .finally(() => {
        if (renderWorker === worker) renderWorker = undefined;
      });
    renderWorker = worker;
  }

  async function runRenderWorker(): Promise<void> {
    while (pendingRender) {
      const snapshot = pendingRender;
      pendingRender = undefined;
      await renderSnapshot(snapshot);
    }
  }

  async function renderSnapshot(snapshot: RlmVisualizationState): Promise<void> {
    let storyboard: RlmStoryboard;
    let accepted = false;
    try {
      const rendered = await options.renderer({
        objective: snapshot.objective,
        runStatus: snapshot.runStatus,
        eventLedger: buildStoryboardLedger(snapshot),
        ...(snapshot.runSummary ? { finalSummary: snapshot.runSummary } : {}),
      });
      storyboard = {
        title: bounded(rendered.title, 200) || `RLM run ${snapshot.runId}`,
        summary: bounded(rendered.summary, 1200),
        narrative: rendered.narrative
          .slice(0, MAX_NARRATIVE_BEATS)
          .map((beat) => bounded(beat, 400)),
        svg: sanitizeStoryboardSvg(rendered.svg),
      };
      accepted = true;
    } catch (error) {
      await recordDiagnostic(
        error instanceof RlmStoryboardContractError ? "contract" : "render",
        error,
      );
      storyboard =
        snapshot.runStatus === RlmVisualizationRunStatus.Running && lastStoryboard
          ? lastStoryboard
          : buildFallbackStoryboard(snapshot);
    }

    let png: Uint8Array | undefined;
    try {
      png = await options.rasterizer(storyboard.svg);
    } catch (error) {
      await recordDiagnostic("rasterize", error);
    }

    await enqueueState(async () => {
      // A newer completion or terminal transition arrived while this model turn was running.
      if (state.revision !== snapshot.revision) return;

      if (accepted) {
        lastStoryboard = storyboard;
        state.storyboard = {
          title: storyboard.title,
          generatedAt: now().toISOString(),
          revision: snapshot.revision,
        };
      }
      const documentState = snapshotState();
      try {
        await writeAtomic(htmlPath, buildVisualizationHtml(documentState, storyboard));
      } catch (error) {
        diagnose("html", error);
      }
      if (png) {
        try {
          await writeAtomic(pngPath, png);
        } catch (error) {
          diagnose("rasterize", error);
        }
      }
      await writeState();
    });
  }

  async function waitForRenderWorker(): Promise<void> {
    while (renderWorker) {
      await renderWorker;
    }
  }

  async function disposeRenderer(): Promise<void> {
    if (rendererDisposed) return;
    rendererDisposed = true;
    try {
      await options.renderer.dispose?.();
    } catch (error) {
      await recordDiagnostic("render", error);
    }
  }

  return {
    initialize() {
      return enqueueState(async () => {
        if (initialized) return;
        initialized = true;
        const snapshot = await persistRevision({ initial: true });
        scheduleRender(snapshot);
      });
    },
    recordCompletion(completion) {
      return enqueueState(async () => {
        if (finalized) return;
        if (!initialized) {
          initialized = true;
          const initialSnapshot = await persistRevision({ initial: true });
          scheduleRender(initialSnapshot);
        }
        sequence += 1;
        state.events.push(normalizeEvent(completion, sequence));
        const snapshot = await persistRevision({ initial: false });
        scheduleRender(snapshot);
      });
    },
    async finalize(input) {
      await enqueueState(async () => {
        if (!initialized) {
          initialized = true;
          const initialSnapshot = await persistRevision({ initial: true });
          scheduleRender(initialSnapshot);
        }
        if (finalized) return;
        finalized = true;
        state.runStatus = input.status;
        state.runSummary = bounded(input.summary, 2000);
        const snapshot = await persistRevision({ initial: false });
        scheduleRender(snapshot);
      });
      await waitForRenderWorker();
      await disposeRenderer();
      return currentArtifacts(state);
    },
    artifacts() {
      return currentArtifacts(state);
    },
  };
}

function currentArtifacts(state: RlmVisualizationState): RlmVisualizationArtifacts {
  return {
    htmlPath: RLM_VISUALIZATION_HTML_PATH,
    pngPath: RLM_VISUALIZATION_PNG_PATH,
    statePath: RLM_VISUALIZATION_STATE_PATH,
    runStatus: state.runStatus,
    status: state.diagnostics.length > 0 ? "degraded" : "ok",
    diagnostics: state.diagnostics.map(
      (diagnostic) => `${diagnostic.stage}: ${diagnostic.message}`,
    ),
  };
}

function normalizeEvent(
  completion: RlmVisualizationCompletion,
  sequence: number,
): RlmVisualizationEvent {
  return {
    ...completion,
    sequence,
    prompt: bounded(completion.prompt, 2000),
    ...(completion.summary === undefined ? {} : { summary: bounded(completion.summary, 2000) }),
    ...(completion.error === undefined ? {} : { error: bounded(completion.error, 2000) }),
    dependencyCallIds: [...(completion.dependencyCallIds ?? [])],
    decisions: (completion.decisions ?? []).slice(0, 20).map((entry) => bounded(entry, 400)),
    artifacts: (completion.artifacts ?? []).slice(0, 20).map((entry) => bounded(entry, 300)),
  };
}
