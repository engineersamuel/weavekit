# RLM POC handoff

The recursive Copilot SDK prototype lives in `src/rlm-poc/`; its decision record is
`docs/adr/0010-recursive-llm-tool-rlm.md`. Delegation out to a _foreign_ harness — Claude Code,
Codex, Grok, Prime, or a Trellage container profile — is the `invoke_trellage` tool in
`src/rlm-poc/trellage/`, recorded in `docs/adr/0011-invoke-trellage.md`.

## Run and verify

```sh
nub scripts/rlm-poc.ts
nub scripts/rlm-poc.ts -p "Use the council profile to evaluate this architecture tradeoff."
nub scripts/rlm-poc.ts -p "Use the design profile to turn this architecture comparison into a visual plan."
nub scripts/rlm-poc.ts --resume <conversation-uuid> -p "Continue using the prior context."
nub scripts/rlm-poc.ts --trellage -p "Use invoke_trellage with harness=claude profile=default to ..."
nub scripts/rlm-poc.ts --trellage --eager-worktree -p "..."
nub run test -- tests/rlm-poc
nub run typecheck
nub run lint
nub run fmt:check
```

The no-argument CLI runs the narrow three-question validation scenario. `-p/--prompt` and
`runRlmSubmind(prompt, options)` run the general recursive Submind path, where the root can select
any configured profile. Every successful general Submind turn prints its Copilot SDK conversation
ID, a copyable `--resume <uuid> --prompt "<follow-up>"` command, and its Langfuse trace link.
Resume is deliberately single-turn and headless: a follow-up prompt is required, and each
invocation receives a fresh depth/total-call budget.

The Copilot SDK's on-disk session store is the canonical conversation history. `--resume` calls the
SDK's `resumeSession` and re-registers the current RLM tools and orchestration configuration; it
does not replay a weavekit-owned transcript or create a duplicate JSONL under `~/.weavekit`.
Missing or deleted session IDs fail explicitly rather than starting a replacement conversation.
The no-argument validation scenario remains a disposable proof and does not print a resume receipt.

## Runtime model

- The d0 root remains explicitly pinned to `mai-code-1.1-flash`. This operator choice is not
  replaced by dynamic routing; any disagreement with nightly catalog capability metadata is
  recorded for diagnosis and covered by a live recursive-tool smoke.
- One immutable `~/.copilot/models.json` snapshot is loaded per run. Recursive profiles declare
  preferred/fallback groups plus capability and modality requirements. The Submind may pass an
  optional current candidate ID to `rlm`; omitted choices use policy order, while invalid or stale
  IDs fall back to a canonical offered candidate.
- `describeRlmProfileModelRouting(catalog)` provides a no-model-call dry run of current profile
  candidates. Catalog generation time, candidates, selected ID, rationale, and fallback are
  included in Langfuse telemetry.
- The isolated root-conversation answerers use a separate `fast-efficient` policy instead of
  inheriting the root or worker model.
- Every `rlm` call creates a clean Copilot SDK client/session and re-registers `rlm`.
- Depth limits path length; one shared budget limits total sibling/descendant `rlm` calls.
- Native `ask_user` is intentionally available to recursive workers. Every question is answered by
  an isolated answerer grounded in the root Submind's current full-conversation snapshot plus the
  immediate delegated prompt; completed exchanges bubble structurally to ancestors.
- `validation` and `review` profiles restrict both tools and recursively selectable profiles.
- Final independent review uses a current frontier reasoning/tool-capable candidate.
- The d0 root is a routing/synthesis meta-harness, not an implementation worker. Its allowlist is
  `rlm`, optional `invoke_trellage`, and discovered MCP tools. The
  headless root does not advertise inert native `ask_user`; child questions continue through the
  root-conversation answerer. It keeps `enableConfigDiscovery: true` so host/workspace MCP remains
  available, but it cannot use direct repository implementation tools.
- Root and recursive sessions discover skills through the SDK before creation, populate
  `disabledSkills` for every name outside the applicable manifest/path, then call the session skill
  listing API and fail before sending a prompt if any enabled skill falls outside that boundary.
  The same validation wraps both fresh and resumed roots. Project, host, plugin, and builtin skills
  therefore remain disabled unless the selected profile explicitly names them and their
  `SKILL.md` is under an explicit profile directory.
- Every recursive profile also receives `handoff`; specialized profiles receive it alongside only
  the explicitly named skills in their own bundle.
- Each worker gets a generated execution envelope, separate from the d0 prompt, containing its
  profile, authority, repository write permission, remaining depth/call budget, allowed child
  profiles, and accountability for integrated verified output. `general`, `superpowers`, and
  `design` implement; `research`, `council`, and `media` investigate without repository edits;
  `review` is read-only; `validation` performs no repository work.
- The root prompt documents the loopback `copilot-proxy-rs` compatibility bridge at
  `http://127.0.0.1:8080`: third-party OpenAI-compatible clients use `/v1`, Anthropic Messages
  clients use `/v1/messages`, and callers discover current Copilot-hosted models from `/v1/models`.
  Normal orchestration still uses the Copilot SDK and `rlm` profiles.
- At terminal completion, the root delegates one bounded `general` worker to send a
  sub-300-character Telegram summary when both `TG_BOT_ID` and `TG_CHAT_ID` are non-empty. Missing
  variables skip notification; secrets are not returned, and delivery failure is reported without
  changing the work outcome.
- When bounded troubleshooting is completely stuck, the root delegates one bounded `general`
  worker to send one precise Telegram blocking question or invoke `handoff`, write its redacted
  document under the OS temporary directory, and give it to at most one new Herdr-managed agent in
  the same worktree.
- `general` is the full-tool implementation worker with the common `handoff` skill but no
  additional profile-specific bundle.
- `superpowers`, `council`, `research`, `design`, and `media` check their upstream default-branch
  `HEAD` on use and cache immutable recursion-local bundles under `.weavekit/rlm-profile-skills`;
  their skills are enabled only for the selected child. An unavailable update check falls back to
  the last verified cache entry with a warning.
- The research bundle combines `/last30days` with the complete isolated generated Hyperresearch
  entry and step-skill manifest. Research and media may write only within their prepared
  cache-scoped working directories; Council may read its prepared bundle/workspace and run only
  read-only provider detection. All three remain prohibited from repository writes.
- Research is fail-closed specialization: the child must invoke the loaded `hyperresearch` or
  `last30days` skill before its result is accepted; generic web-search-only output is rejected.
- The frontier `design` profile softly prefers Claude/Opus candidates and combines selected
  Anthropic visual/frontend skills, the full
  Owl designer skill library, AntV infographic skills, Builder.io `visual-plan`, and the
  asset-adjacent `img2threejs` skill. Its explicit manifest names concrete `critique-*`,
  infographic companion, and design-system skills, and installation fails if any allowed name
  lacks a matching installed `SKILL.md`. The Submind always considers design delegation when a visual
  plan, comparison, complex-topic diagram, infographic, work summary, or frontend artifact would
  materially improve human review.
- The `media` profile invokes `watch-video` for YouTube, Loom, Vimeo, Riverside, Zoom, social-video,
  and local-file transcription or analysis. It supports transcript, visual, and multimodal depth,
  records outputs under its prepared cache workspace, and fails closed unless the skill is actually
  invoked.
  weavekit normalizes the upstream skill so visual and multimodal frames use
  `http://127.0.0.1:8080/v1/messages` with Copilot-backed Claude vision instead of
  `GEMINI_API_KEY`. The proxy has no native-video upload, so multimodal mode uses dense local frame
  extraction with bounded image batches.
- Primarily visual deliverables must route through `design`, including DNS topology/resolution-flow
  diagrams and other DNS-style visual explanations.
- Research gets the isolated Hyperresearch runtime on `PATH`, a stable ignored cache workspace, and
  a one-hour base turn timeout; Council gets a 20-minute base timeout. Parent/root timeouts derive
  from reachable children. The general recursion-tree call budget defaults to 12.

## Delegating to a Trellage harness

`invoke_trellage` runs a real harness in a real terminal and returns its final answer, so the
Submind can reach a tool `rlm` cannot: Claude Code's own agent loop, a Codex or Grok launcher, or a
Trellage container profile such as `claude-council` or `copilot-hve`.

- **Off by default.** Pass `--trellage`. The tool is also _not registered at all_ unless the run is
  inside a Herdr session with a reachable socket, in a git repository, and at least one profile is
  discoverable — the model never sees a tool it cannot use. It is registered on recursive `rlm`
  sessions too, not just the root.
- **Arguments** are `{ prompt, harness, profile, readOnly?, model? }`. `harness=container` runs
  `trellage --profile <name>`; anything else runs the launcher reported by `trx list --json`.
  Container profiles come from `trellage list --json`. The tool exposes each profile's live
  description, mode, launcher, and sandbox status in safety-preferred order: sandboxed native,
  container, then unsandboxed native. Capability fit remains primary, so distinctive unsandboxed
  harnesses such as Prime stay available. If `trx` cannot aggregate a newer launcher catalog,
  discovery falls back to each known launcher's own `list --json`. Native profiles are
  readiness-checked with
  `inventory --json` before launch. `model` is accepted only
  for native Copilot (`cpx`) and must be a current validated tool-capable catalog ID; every other
  harness owns its model and rejects an override before launch.
- **Every invocation gets its own background Herdr tab**, closed when the call ends, and an agent
  name prefixed `rlm-t-<runId>-`. Herdr owns the interactive PTY used to launch and read every
  native or container harness; nothing the tool did not create is ever closed.
- **One `invoke_trellage` call is one depth hop** and one unit of the shared `RlmExecutionBudget`.
  The spawned harness is a leaf: it cannot call back into `rlm`. A global concurrency cap limits how
  many harness panes exist at once.
- **Questions are answered for it.** Unambiguous permission dialogs are approved automatically;
  anything else is escalated to the same isolated root-Submind answerer `ask_user` uses.

### Worktrees

All delegated work happens in a Herdr-managed git worktree, never in the user's checkout.

- One worktree per repository, on branch `rlm/<runId>`, cut from the repository's **main** working
  tree (Herdr refuses to branch from a linked worktree). Herdr chooses the path, so it lands under
  `~/.herdr/worktrees/<project>/<name>` and any other Herdr agent can attach to it.
- Provisioned lazily on first use, or up front with `--eager-worktree` (which requires
  `--trellage`). Eager provisioning runs this repo's `worktree_init.toml`, so it costs a `nub
install`.
- Mutating invocations against one repo are serialized by a per-worktree mutex; `readOnly: true`
  invocations may run concurrently.
- At run end a worktree with a clean tree and no commits ahead of its base is removed and reported
  as reclaimed, and its `rlm/<runId>` branch is deleted with it — `herdr worktree remove` leaves the
  branch behind, so every run would otherwise leak a ref. A worktree with changes is kept, along
  with its branch, and printed with its path, branch, and change summary. If its state cannot be
  read it is kept.

### How completion is detected

Herdr exposes agent _lifecycle_ state, which does not map onto turn boundaries, so three signals
are combined (see ADR 0011 for the full reasoning):

1. **The result file is the oracle.** The task is written to
   `.weavekit/rlm-trellage/<runId>/<callId>/task.md` inside the worktree and instructs the harness
   to write its complete answer to `result.md` beside it. That file's existence is what proves the
   turn finished; it is also the only complete transcript, since alt-screen TUIs lose their output
   to scrollback.
2. **A still screen means it is really waiting.** Herdr reports some harnesses as `idle` while they
   are still thinking, so the loop also requires three consecutive identical pane frames before it
   believes the harness is waiting on input.
3. **One Enter nudge before escalating.** Some harnesses hold a submitted prompt in their composer.
   Prompts are single-line for this reason, and the loop presses Enter once before concluding it is
   being asked a question.

`blocked` (structured dialog) is handled separately; `unknown` fails closed; a result file written
just before a timeout or exit still counts as success.

## Telemetry

Set Langfuse credentials or an OpenTelemetry exporter to emit spans. The validation script skips
starting telemetry when no exporter is explicitly configured. Before importing telemetry or the RLM
runtime, the CLI loads all values from `~/.env` without overriding existing process variables, then
runs Varlock against the dedicated `src/rlm-poc/.env.schema` to validate RLM settings and install
secret-redaction hooks. RLM console streaming and final output pass through Varlock redaction. The
dedicated schema avoids imposing unrelated Mastermind requirements on this CLI and marks the known
credentials commonly present in the shared home environment as sensitive. Shared telemetry
bootstrap keeps its existing environment-based exporter behavior for other entry points.

Custom Langfuse spans form the visual recursion spine:

```text
SUBMIND d0 · orchestration
└─ RLM #1 d1/3 · <profile>
   └─ RLM #2 d2/3 · <profile>
```

The Submind and `RLM #...` spans carry structured input/output. Recursive spans also include profile,
depth, call ordinal, budget, and the corresponding SDK tool-call ID. SDK-generated `rlm`,
`external_tool`, permission, agent, and model observations remain available as lower-level detail;
use the named custom spans for the high-level workflow. Content is redacted by default; set
`LANGFUSE_EXPORT_RAW=true` only for runs whose complete prompts and responses are safe to export.

## Known limitations

`invoke_trellage` requires a PTY: `trellage` asserts `[[ -t 0 && -t 1 ]]`, so there is no headless
path and no way to test it without the `TrellageBackend` fake. Container profiles pay Docker start
latency on every invocation (~40s observed for `copilot-hve` versus ~17s for native `cldx`), so
timeouts are generous and a slow boot must not be read as a stall. Detecting that a harness asked
something in prose is inherently heuristic — the result file plus screen quiescence is what makes it
reliable, and a harness that never writes the result file will time out rather than report a wrong
answer.

`ask_user` answerer sessions are separate model calls and are not counted as `rlm` calls in the shared
call budget. They are text-only, cannot discover config or skills, and have a one-minute timeout so
they do not consume the recursive worker's full turn timeout.
