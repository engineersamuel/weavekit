# 0014 — Continual storyboard for a recursive Submind run

Status: accepted

## Context

A Submind run ([ADR 0010](0010-recursive-llm-tool-rlm.md)) is a recursion tree. `rlm` spawns a
nested Copilot SDK session, `invoke_trellage` ([ADR 0011](0011-invoke-trellage.md)) hands work to a
foreign harness in its own worktree, and both can be called from any session at any depth. The only
record of what actually happened was interleaved console output plus a Langfuse trace. Neither
answers the question a human asks while a run is in flight: _what has this thing delegated, to whom,
in what order, and where does it stand right now?_

`DELEGATE_SUBMIND` ([ADR 0012](0012-mastermind-delegate-submind-to-rlm.md)) makes that worse, because
the run is a detached process and the reviewer is looking at a Linear ticket, not a terminal.

## Decision

- **A narrow observer, not a dependency.** `RlmVisualizationObserver` (in
  `src/rlm-poc/visualization/contracts.ts`) is a single-method interface,
  `recordCompletion(completion)`. `createRlmTool` and `createTrellageTool` take it as an option.
  The tools never import the renderer, the rasterizer, or the writer, so the delegation path stays
  testable with a two-line fake.

- **One recorder per run, two serialized paths.** `src/rlm-poc/runtime.ts` owns exactly one
  `createRlmVisualizationRecorder` and passes the same instance to the root tool, every recursive
  tool it builds, and every per-session `invoke_trellage` instance. The recorder serializes every
  state update onto a short promise chain. A separate single-worker render queue preserves the
  persistent model session without making recursive work wait for Gemini.

- **Completion order is the record.** An event is recorded when a call _finishes_, so a nested call
  is always observed before its parent. Parentage is explicit rather than inferred: the `rlm` tool
  passes its own `callId` down as `parentCallId`, and `invoke_trellage` is built by a per-parent
  factory (`RlmAdditionalToolFactory`) so each session's instance knows which `rlm` call owns it.
  Without that factory a Trellage call from depth 3 would be attributed to the root.

- **Non-fatal at both boundaries.** Both tools await only the recorder's durable state write inside
  a dedicated try/catch and drop the error to `writeRlmOutput`. Gemini continues asynchronously.
  A storyboard is not worth failing finished work for. The same rule holds for the Linear upload
  in `MastermindExecutionCoordinator.publishStoryboard`, where a failure becomes a comment line
  and an `onProgress` message instead of a failed attempt.

- **Initial frame, durable state, asynchronous picture.** Before the root session starts, the
  recorder writes revision 1 with the initial prompt and a locally rendered HTML/PNG frame. Every
  completion then increments the revision, appends the complete event, and atomically writes
  `visualization-state.json` before returning. Slow model work runs behind one latest-wins queue:
  while one immutable snapshot renders, newer pending snapshots replace older pending snapshots.
  No facts are lost because every snapshot contains the cumulative event ledger. A model response
  may write HTML/PNG only if its revision still equals current state, so an old response cannot
  overwrite a newer local or model frame. Finalization supersedes pending running work, drains the
  worker, and guarantees one terminal render before artifact paths are returned.

- **Skill-backed Copilot SDK renderer by default.** An omitted renderer selection creates one
  persistent `gemini-3.7-flash` Copilot SDK session for the run and enables only
  `aiz-infographic`, `algorithmic-art`, `canvas-design`, `frontend-design`, and `theme-factory`.
  The session has no shell, browser, network, or filesystem tools; it can load those skills and call
  one typed `submit_storyboard` tool. A compact style guide returned with the first revision is fed
  back on later turns to reduce visual drift. The upstream skills are resolved to immutable commits
  under the ignored `.weavekit/rlm-profile-skills` cache. `aiz-infographic` has no declared
  repository license, so it is fetched only into that local cache and is not vendored, published,
  or attached as an artifact.

- **BAML is an explicit storyboard alternative.** `--visualization-renderer baml` selects
  `RenderRlmStoryboard(objective, runStatus, eventLedger) -> RlmStoryboard` from
  `baml_src/visualization.baml`. This changes only storyboard rendering; weavekit still uses BAML
  for worker contracts and other structured LLM boundaries. SDK failure never silently switches to
  BAML.

- **Every model SVG is untrusted.** Both renderer paths pass returned SVG through
  `sanitizeStoryboardSvg` before writing it: one root `<svg>`, an element allowlist, no
  `script`/`foreignObject`/`image`/`use`/`a`, no `on*` handlers, no remote URLs or `@import`, and a
  bounded length. Title, summary, and narrative beats are length-bounded, and every injected value
  is escaped for its destination. A contract violation is recorded as a `contract` diagnostic and
  otherwise treated like any render failure.

- **Three files, one stable pair of paths.** `visualization.html`, `visualization.png`, and
  `visualization-state.json` under `<workingDirectory>/.weavekit/rlm-visualization/`, each written
  as a temporary file inside that same directory and then renamed. The HTML is self-contained (the
  SVG is inlined, no remote fonts or scripts) so it opens from disk; the PNG is the same SVG
  rasterized in-process by `@resvg/resvg-js`, which needs no browser and works in Kitty. The
  renderer and rasterizer are injectable, so no test needs a model or a rasterizer binary.

- **Artifacts flow outward.** `RlmPrototypeResult.visualization` carries the run's terminal status
  and the three relative paths. `RlmDirectExecutor.collect` appends them to the Submind-authored
  `artifactPaths` — never replacing them, and only for relative paths that really exist, because the
  coordinator validates artifact paths again before publishing.

- **Each run starts from an empty directory.** The storyboard is rewritten in place, so a run that
  dies before its first completion would otherwise leave the previous run's artifacts on disk, where
  `collect` would attach them as if they described this attempt. Both entry points call
  `clearRlmVisualizationArtifacts` first: `scripts/rlm-poc.ts` for a direct CLI run, and
  `RlmDirectExecutor.start` before it spawns the detached child. Only the fixed
  `.weavekit/rlm-visualization` directory is removed, never `.weavekit` itself. `scripts/rlm-poc.ts`
  runs `main()` on import and has no seam a test can drive without a live model, so the CLI path is
  covered indirectly: `tests/rlm-poc/visualizationCleanup.test.ts` covers the shared function both
  callers use, and `tests/submind/rlm.test.ts` proves the detached start clears the directory before
  spawning.

- **Uploads only where there is a ticket.** `LinearGateway` gained an optional
  `uploadIssueAttachment` implementing Linear's three-step contract: `fileUpload` returns a signed
  `uploadUrl`, `assetUrl`, and the headers the signature covers; the bytes are `PUT` with exactly
  those headers; `attachmentCreate` links the asset. The coordinator uploads at the one point where
  the execution comment does not exist yet, so a retried projection never republishes, and embeds the
  PNG and links the HTML in that comment. A run with no ticket, or a gateway without the method,
  stays local.

## Consequences

- Gemini rendering does not gate recursive delegation. Model frames can skip intermediate
  revisions when completions arrive faster than Gemini, but durable state contains every event and
  each produced frame contains the full story through its revision.
- The default SDK mode has startup cost on its first run because it downloads the ignored skill
  cache, and it retains one model transcript for visual continuity. BAML remains available when an
  operator explicitly prefers its smaller typed call.
- The storyboard shows completions, not work in flight. A call that never returns never appears; the
  run status and the diagnostics panel are what tell a reader something is stuck.
- `@resvg/resvg-js` is a native dependency, so the PNG half is unavailable on any platform it has no
  prebuilt binary for. The HTML and the state JSON are still written.
- The Linear upload is best-effort by design: a failed upload leaves the storyboard on disk only, and
  the comment says so.
