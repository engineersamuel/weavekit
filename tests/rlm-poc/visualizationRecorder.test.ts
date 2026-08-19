import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RLM_VISUALIZATION_DIRECTORY,
  RLM_VISUALIZATION_HTML_PATH,
  RLM_VISUALIZATION_PNG_PATH,
  RLM_VISUALIZATION_STATE_PATH,
  RlmVisualizationAction,
  RlmVisualizationRunStatus,
  RlmVisualizationStatus,
  createRlmVisualizationRecorder,
  type RlmStoryboard,
  type RlmStoryboardRenderRequest,
  type RlmStoryboardRenderer,
  type RlmVisualizationCompletion,
  type RlmVisualizationState,
} from "../../src/rlm-poc/visualization/index.js";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#111" /></svg>';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function workingDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rlm-visualization-"));
  directories.push(path);
  return path;
}

function completion(
  overrides: Partial<RlmVisualizationCompletion> = {},
): RlmVisualizationCompletion {
  return {
    action: RlmVisualizationAction.Rlm,
    status: RlmVisualizationStatus.Succeeded,
    callId: "call-1",
    depth: 1,
    prompt: "Do the bounded task.",
    profile: "implementation",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    summary: "Done.",
    ...overrides,
  };
}

async function readState(path: string): Promise<RlmVisualizationState> {
  return JSON.parse(
    await readFile(join(path, RLM_VISUALIZATION_STATE_PATH), "utf8"),
  ) as RlmVisualizationState;
}

function fakeRenderer(requests: RlmStoryboardRenderRequest[] = [], svg = SVG) {
  return async (request: RlmStoryboardRenderRequest) => {
    requests.push(request);
    return {
      title: `Storyboard ${requests.length}`,
      summary: "Rendered summary.",
      narrative: [`beat ${requests.length}`],
      svg,
    };
  };
}

const fakeRasterizer = async (svg: string): Promise<Uint8Array> =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, svg.length % 256]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createRlmVisualizationRecorder", () => {
  it("writes an initial prompt frame, durable completion state, and a terminal frame", async () => {
    const path = await workingDirectory();
    const requests: RlmStoryboardRenderRequest[] = [];
    const recorder = createRlmVisualizationRecorder({
      workingDirectory: path,
      runId: "run-1",
      objective: "Ship the storyboard.",
      rendererName: "copilot-sdk",
      renderer: fakeRenderer(requests),
      rasterizer: fakeRasterizer,
    });

    await recorder.initialize();
    expect(await readState(path)).toMatchObject({
      renderer: "copilot-sdk",
      revision: 1,
      runStatus: "running",
      events: [],
    });
    await expect(readFile(join(path, RLM_VISUALIZATION_HTML_PATH), "utf8")).resolves.toContain(
      "Ship the storyboard.",
    );
    await expect(readFile(join(path, RLM_VISUALIZATION_PNG_PATH))).resolves.toHaveLength(5);

    await recorder.recordCompletion(completion());
    await recorder.recordCompletion(
      completion({ callId: "call-2", parentCallId: "call-1", depth: 2 }),
    );

    const runningState = await readState(path);
    expect(runningState.revision).toBe(3);
    expect(runningState.events.map((event) => [event.sequence, event.callId])).toEqual([
      [1, "call-1"],
      [2, "call-2"],
    ]);

    await recorder.finalize({ status: RlmVisualizationRunStatus.Succeeded, summary: "done" });
    const finalState = await readState(path);
    expect(finalState).toMatchObject({
      revision: 4,
      runStatus: "succeeded",
      runSummary: "done",
      storyboard: { revision: 4 },
    });
    const html = await readFile(join(path, RLM_VISUALIZATION_HTML_PATH), "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("renderer</dt><dd>copilot-sdk");
    expect(html).toContain("call-2");
    expect(requests.at(-1)?.eventLedger).toContain("call-2");
    // The terminal render must be grounded in the Submind's own final result text, not only in
    // the completed-delegation ledger, since root-level verification and risks never appear there.
    expect(requests.at(-1)?.finalSummary).toBe("done");
    expect(requests.slice(0, -1).every((request) => request.finalSummary === undefined)).toBe(true);
  });

  it("returns after durable state without waiting for Gemini and coalesces pending revisions", async () => {
    const path = await workingDirectory();
    const calls: Array<{
      request: RlmStoryboardRenderRequest;
      result: ReturnType<typeof deferred<RlmStoryboard>>;
    }> = [];
    const renderer: RlmStoryboardRenderer = async (request) => {
      const result = deferred<RlmStoryboard>();
      calls.push({ request, result });
      return result.promise;
    };
    const recorder = createRlmVisualizationRecorder({
      workingDirectory: path,
      runId: "run-1",
      objective: "Do not block recursion.",
      renderer,
      rasterizer: fakeRasterizer,
    });

    await recorder.initialize();
    expect(calls).toHaveLength(1);

    await Promise.all([
      recorder.recordCompletion(completion()),
      recorder.recordCompletion(completion({ callId: "call-2" })),
    ]);
    expect((await readState(path)).events.map((event) => event.callId)).toEqual([
      "call-1",
      "call-2",
    ]);
    expect((await readState(path)).revision).toBe(3);
    expect(calls).toHaveLength(1);

    calls[0]!.result.resolve({
      title: "Stale initial",
      summary: "stale",
      narrative: [],
      svg: SVG,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.request.eventLedger).toContain("call-1");
    expect(calls[1]!.request.eventLedger).toContain("call-2");

    const finalization = recorder.finalize({
      status: RlmVisualizationRunStatus.Succeeded,
      summary: "done",
    });
    await vi.waitFor(async () =>
      expect((await readState(path)).runStatus).toBe(RlmVisualizationRunStatus.Succeeded),
    );
    calls[1]!.result.resolve({
      title: "Stale running",
      summary: "stale",
      narrative: [],
      svg: SVG,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[2]!.result.resolve({
      title: "Current terminal",
      summary: "done",
      narrative: ["complete"],
      svg: SVG,
    });
    await finalization;

    const state = await readState(path);
    expect(state.storyboard).toMatchObject({ title: "Current terminal", revision: 4 });
    const html = await readFile(join(path, RLM_VISUALIZATION_HTML_PATH), "utf8");
    expect(html).toContain("Current terminal");
    expect(html).not.toContain("Stale running");
  });

  it("keeps accepted metadata and records later render and contract failures", async () => {
    const path = await workingDirectory();
    let call = 0;
    const recorder = createRlmVisualizationRecorder({
      workingDirectory: path,
      runId: "run-1",
      objective: "Survive bad renders.",
      renderer: async () => {
        call += 1;
        if (call === 1) {
          return { title: "Accepted", summary: "s", narrative: ["kept"], svg: SVG };
        }
        if (call === 2) throw new Error("model unavailable");
        return { title: "Rejected", summary: "s", narrative: [], svg: "<svg><script/></svg>" };
      },
      rasterizer: fakeRasterizer,
      log: () => {},
    });

    await recorder.initialize();
    await vi.waitFor(async () =>
      expect((await readState(path)).storyboard).toMatchObject({ title: "Accepted", revision: 1 }),
    );
    await recorder.recordCompletion(completion());
    await vi.waitFor(async () =>
      expect((await readState(path)).diagnostics.map((entry) => entry.stage)).toContain("render"),
    );
    await recorder.finalize({ status: RlmVisualizationRunStatus.Failed, summary: "root failed" });

    const state = await readState(path);
    expect(state.storyboard).toMatchObject({ title: "Accepted", revision: 1 });
    expect(state.diagnostics.map((entry) => entry.stage)).toEqual(["render", "contract"]);
    expect(state.runStatus).toBe(RlmVisualizationRunStatus.Failed);
  });

  it("escapes injected content instead of letting it become markup", async () => {
    const path = await workingDirectory();
    const recorder = createRlmVisualizationRecorder({
      workingDirectory: path,
      runId: "run-1",
      objective: "<script>alert('objective')</script>",
      renderer: fakeRenderer(),
      rasterizer: fakeRasterizer,
    });

    await recorder.initialize();
    await recorder.recordCompletion(completion({ prompt: "<img src=x onerror=alert(1)>" }));
    await recorder.finalize({ status: RlmVisualizationRunStatus.Succeeded, summary: "done" });

    const html = await readFile(join(path, RLM_VISUALIZATION_HTML_PATH), "utf8");
    expect(html).not.toContain("<script>alert('objective')</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("writes HTML and state and reports degradation when rasterization fails", async () => {
    const path = await workingDirectory();
    const recorder = createRlmVisualizationRecorder({
      workingDirectory: path,
      runId: "run-1",
      objective: "Survive a bad rasterizer.",
      renderer: fakeRenderer(),
      rasterizer: async () => {
        throw new Error("resvg exploded");
      },
      log: () => {},
    });

    await recorder.initialize();
    await recorder.recordCompletion(completion());
    await recorder.finalize({ status: RlmVisualizationRunStatus.Succeeded, summary: "done" });

    const artifacts = recorder.artifacts();
    expect(artifacts.status).toBe("degraded");
    expect(artifacts.diagnostics.join(" ")).toContain("resvg exploded");
    await expect(readFile(join(path, RLM_VISUALIZATION_HTML_PATH), "utf8")).resolves.toContain(
      "call-1",
    );
  });

  it("creates a local PNG immediately and retains a terminal fallback when the model fails", async () => {
    const path = await workingDirectory();
    const recorder = createRlmVisualizationRecorder({
      workingDirectory: path,
      runId: "run-1",
      objective: "Fall back.",
      renderer: async () => {
        throw new Error("no model");
      },
      rasterizer: fakeRasterizer,
      log: () => {},
    });

    await recorder.initialize();
    await expect(readFile(join(path, RLM_VISUALIZATION_PNG_PATH))).resolves.toHaveLength(5);
    await recorder.recordCompletion(completion());
    await recorder.finalize({ status: RlmVisualizationRunStatus.Failed, summary: "failed" });

    const html = await readFile(join(path, RLM_VISUALIZATION_HTML_PATH), "utf8");
    expect(html).toContain("FALLBACK LEDGER");
    expect(html).toContain("call-1");
    // The fallback summary must reflect the run's own final result text once known, not a generic
    // "N completed delegations" line that says nothing about what actually happened.
    expect(html).toContain('<p class="summary">failed</p>');
  });

  it("returns fixed relative artifact paths and disposes the renderer once", async () => {
    const path = await workingDirectory();
    let disposed = 0;
    const renderer: RlmStoryboardRenderer = fakeRenderer();
    renderer.dispose = async () => {
      disposed += 1;
    };
    const recorder = createRlmVisualizationRecorder({
      workingDirectory: path,
      runId: "run-1",
      objective: "Finish.",
      renderer,
      rasterizer: fakeRasterizer,
    });

    await recorder.initialize();
    const artifacts = await recorder.finalize({
      status: RlmVisualizationRunStatus.Failed,
      summary: "Root session threw.",
    });

    expect(artifacts).toEqual({
      htmlPath: RLM_VISUALIZATION_HTML_PATH,
      pngPath: RLM_VISUALIZATION_PNG_PATH,
      statePath: RLM_VISUALIZATION_STATE_PATH,
      runStatus: RlmVisualizationRunStatus.Failed,
      status: "ok",
      diagnostics: [],
    });
    expect(disposed).toBe(1);
  });

  it("leaves no temporary files behind after the terminal render", async () => {
    const path = await workingDirectory();
    const recorder = createRlmVisualizationRecorder({
      workingDirectory: path,
      runId: "run-1",
      objective: "Write atomically.",
      renderer: fakeRenderer(),
      rasterizer: fakeRasterizer,
    });

    await recorder.initialize();
    await recorder.recordCompletion(completion());
    await recorder.finalize({ status: RlmVisualizationRunStatus.Succeeded, summary: "ok" });

    const entries = await readdir(join(path, RLM_VISUALIZATION_DIRECTORY));
    expect(entries.sort()).toEqual([
      "visualization-state.json",
      "visualization.html",
      "visualization.png",
    ]);
  });
});
