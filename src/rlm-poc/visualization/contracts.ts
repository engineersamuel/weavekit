import { join } from "node:path";

/** Directory, relative to the run's working directory, that holds every visualization artifact. */
export const RLM_VISUALIZATION_DIRECTORY = join(".weavekit", "rlm-visualization");
export const RLM_VISUALIZATION_HTML_PATH = join(RLM_VISUALIZATION_DIRECTORY, "visualization.html");
export const RLM_VISUALIZATION_PNG_PATH = join(RLM_VISUALIZATION_DIRECTORY, "visualization.png");
export const RLM_VISUALIZATION_STATE_PATH = join(
  RLM_VISUALIZATION_DIRECTORY,
  "visualization-state.json",
);

/** Which delegation boundary produced an observed completion. */
export const RlmVisualizationAction = {
  Rlm: "rlm",
  Trellage: "invoke_trellage",
} as const;
export type RlmVisualizationAction =
  (typeof RlmVisualizationAction)[keyof typeof RlmVisualizationAction];

export const RlmVisualizationStatus = {
  Succeeded: "succeeded",
  Failed: "failed",
} as const;
export type RlmVisualizationStatus =
  (typeof RlmVisualizationStatus)[keyof typeof RlmVisualizationStatus];

export const RlmVisualizationRunStatus = {
  Running: "running",
  Succeeded: "succeeded",
  Failed: "failed",
} as const;
export type RlmVisualizationRunStatus =
  (typeof RlmVisualizationRunStatus)[keyof typeof RlmVisualizationRunStatus];

/**
 * One completed delegation, as seen by the observer. Every field the tools can supply is captured
 * here so the renderer never has to reach back into RLM internals.
 */
export type RlmVisualizationCompletion = {
  action: RlmVisualizationAction;
  status: RlmVisualizationStatus;
  /** Stable identity of the completed call. Unique within one run. */
  callId: string;
  /** Owning call, when this completion happened inside a nested session. */
  parentCallId?: string;
  /** Completed sibling calls whose reports were injected into this one. */
  dependencyCallIds?: readonly string[];
  /** 1 for a delegation issued by the root session. */
  depth: number;
  /** The delegated task text. */
  prompt: string;
  profile: string;
  harness?: string;
  model?: string;
  worktreePath?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  /** Human-readable outcome text: worker summary, harness answer, or failure detail. */
  summary?: string;
  decisions?: readonly string[];
  artifacts?: readonly string[];
  error?: string;
};

/** A completion after the recorder has assigned it a deterministic position in the run. */
export type RlmVisualizationEvent = RlmVisualizationCompletion & {
  /** 1-based order in which the recorder observed this completion. */
  sequence: number;
  dependencyCallIds: readonly string[];
  decisions: readonly string[];
  artifacts: readonly string[];
};

export type RlmVisualizationDiagnostic = {
  observedAt: string;
  /** Which non-fatal boundary failed. */
  stage: "state" | "render" | "contract" | "html" | "rasterize" | "upload";
  message: string;
};

/** Durable, machine-readable state. Written before every render so a crash loses nothing. */
export type RlmVisualizationState = {
  schemaVersion: 1;
  runId: string;
  objective: string;
  renderer: RlmStoryboardRendererName;
  startedAt: string;
  updatedAt: string;
  /** Increments for initialization, every recorded completion, and finalization. */
  revision: number;
  runStatus: RlmVisualizationRunStatus;
  runSummary?: string;
  events: RlmVisualizationEvent[];
  diagnostics: RlmVisualizationDiagnostic[];
  storyboard?: { title: string; generatedAt: string; revision: number };
};

/** Model output contract. `svg` is untrusted until `sanitizeStoryboardSvg` accepts it. */
export type RlmStoryboard = {
  title: string;
  summary: string;
  narrative: string[];
  svg: string;
};

export type RlmStoryboardRenderRequest = {
  objective: string;
  runStatus: RlmVisualizationRunStatus;
  /** Bounded, deterministic ledger text derived from {@link RlmVisualizationState}. */
  eventLedger: string;
};

export type RlmStoryboardRenderer = ((
  request: RlmStoryboardRenderRequest,
) => Promise<RlmStoryboard>) & {
  /** Optional lifecycle hook for persistent SDK sessions owned by the renderer. */
  dispose?: () => Promise<void>;
};

export const RlmStoryboardRendererMode = {
  Baml: "baml",
  CopilotSdk: "copilot-sdk",
} as const;
export type RlmStoryboardRendererMode =
  (typeof RlmStoryboardRendererMode)[keyof typeof RlmStoryboardRendererMode];
export const DEFAULT_RLM_STORYBOARD_RENDERER_MODE = RlmStoryboardRendererMode.CopilotSdk;

export const RlmStoryboardRendererName = {
  ...RlmStoryboardRendererMode,
  Custom: "custom",
} as const;
export type RlmStoryboardRendererName =
  (typeof RlmStoryboardRendererName)[keyof typeof RlmStoryboardRendererName];

/** Turns a sanitized SVG document into PNG bytes. */
export type RlmStoryboardRasterizer = (svg: string) => Promise<Uint8Array>;

/** Paths are relative to the run's working directory so they can be stored and shared safely. */
export type RlmVisualizationArtifacts = {
  htmlPath: string;
  pngPath: string;
  statePath: string;
  /** Terminal status of the root run, as recorded on the storyboard. */
  runStatus: RlmVisualizationRunStatus;
  /** `ok` when every boundary succeeded, `degraded` when a non-fatal failure was recorded. */
  status: "ok" | "degraded";
  diagnostics: string[];
};

/**
 * Narrow seam the `rlm` and `invoke_trellage` tools depend on. Implementations must serialize
 * their own work and must never reject: a visualization failure cannot fail delegated work.
 */
export type RlmVisualizationObserver = {
  recordCompletion(completion: RlmVisualizationCompletion): Promise<void>;
};

export class RlmStoryboardContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RlmStoryboardContractError";
  }
}
