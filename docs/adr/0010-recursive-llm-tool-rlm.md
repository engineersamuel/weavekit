# 0010 — Recursive Copilot SDK tool (`rlm`) prototype

Status: accepted (prototype scope only)

## Context

Weavekit's existing cross-process delegation paths — `src/submind-poc/` and the
`mastermind-submind` skill — orchestrate other harnesses (Copilot, Grok, Codex, Trellage) through
Herdr-managed panes: separate OS processes, terminal panes, and Herdr's own TTY-scraping
idle/blocked/done heuristics. That mechanism is well suited to visual, human-attachable,
long-lived multi-agent sessions, but it carries pane/process/worktree overhead that is unnecessary
when the only goal is to let a running Copilot SDK session recursively delegate a bounded
sub-question to another Copilot SDK session, in-process.

This ADR captures a narrower, complementary prototype: a tool named `rlm` that a Copilot SDK
session can call, which spins up a _new_ Copilot SDK client/session — with `rlm` itself registered
on that new session, so it can recurse again — entirely inside the same Node process. No Herdr, no
subprocess, no pane.

During design, we surveyed a much larger space this could eventually grow into: a second tool,
`invoke_harness`, for delegating one-shot or bidirectional work to other harnesses' native SDKs
(Claude Agent SDK, Codex SDK, Pi SDK), Trellage container profiles, and Vercel's `@ai-sdk/harness`
meta-SDK as a possible unifying abstraction over several of those. All of that is real, useful
future-facing surface — and explicitly **not** part of this prototype. Scope was deliberately cut
back to the smallest thing that proves the recursion mechanism itself works.

## Decision

Build a single new tool, `rlm`, and nothing else, as `src/rlm-poc/` (mirroring the existing
`src/submind-poc/` isolation convention: own directory, own tests, own CLI entry point, own
handoff doc, not touching `src/mastermind/` or `src/submind/`).

- `rlm` is defined with the Copilot SDK's `defineTool` and registered on every session it
  participates in, including the sessions it spawns. A session that has `rlm` registered can call
  `rlm` again — this is the recursion.
- Calling `rlm` creates a brand-new `CopilotClient` + session in the same Node process. No
  subprocess, no Herdr, no pane. This is a deliberate contrast with `submind-poc`, which is
  necessarily subprocess/pane-based because it drives genuinely separate harness processes.
- Each nested session starts from a **clean conversation slate**. A general worker receives the
  immutable run brief, its delegated task, and only the completed typed reports explicitly named
  in `dependsOn`. It does not inherit the parent transcript or the complete run ledger. The narrow
  validation scenario keeps its existing raw prompt/result path. The brief's objective,
  constraints, acceptance criteria, and validation commands are derived once per run from the
  operator's raw prompt, and operator-supplied fields override the derived ones field by field.
  Derivation extracts only what the prompt states or clearly implies, leaving a list empty rather
  than inventing an entry, and fails open to an empty brief so a derivation error cannot abort the
  run. Binding the brief once gives every worker and reviewer the same enumerated acceptance
  contract instead of each retyping it free-form. When any descendant explicitly
  calls `ask_user`, an isolated answerer receives a point-in-time snapshot of the root Submind's
  application instructions and complete persisted conversation. Its answer is returned to the
  child, while the question/answer exchange is also included structurally in the `rlm` result
  returned to every ancestor. This preserves clean delegation while allowing the root Submind to
  answer context-dependent questions and synthesize all recursive results.
- Nested sessions use unattended permission handling. Implementation profiles retain the existing
  `approveAll` behavior, while skill-backed no-repository-write profiles wrap it with structural
  filesystem and shell checks: Research and Media may write only under their prepared cache
  workspace, and Council may read its prepared bundle/workspace and run read-only provider
  detection. Real bubbled/human-mediated permission flow is out of scope for this prototype.
- `rlm`'s signature is minimal:

  ```ts
  rlm({
    prompt: string;
    profile: string;
    model?: string;
    effort?: "low" | "medium" | "high" | "xhigh";
    dependsOn?: string[];
  })
    => {
      text: string;
      depthUsed: number;
      model: string;
      modelRationale: string;
      budget: { maxCalls: number; usedCalls: number; remainingCalls: number };
      runId?: string;
      callId?: string;
      parentCallId?: string;
      dependencyCallIds?: string[];
      report?: RlmWorkerReport;
      userInputs?: Array<{ question: string; answer: string }>;
    }
  ```

  Model selection uses one immutable snapshot of `~/.copilot/models.json` loaded at run start.
  Each profile declares preferred/fallback catalog groups, required capabilities/modalities, and
  soft vendor/family preferences. The root sees only current eligible candidates and may pass one
  exact ID; an omitted choice uses the highest-ranked candidate, while a stale or hallucinated ID
  falls back to policy. Canonical IDs always come from the validated offered set. The root itself
  is an intentional exception and remains operator-pinned to `mai-code-1.1-flash`; catalog
  capability disagreement is traced diagnostically rather than silently replacing that pin.
  Reasoning effort follows the same shape: the root may pass `effort` per call to match a task's
  difficulty, an omitted choice uses the profile's default, and a request above the profile's
  `maxReasoningEffort` is clamped down to that cap rather than rejected, because a rejected call
  still spends the shared budget.

  `profile` resolves to a local, versioned entity config (model, a `systemMessage` append-block,
  purpose/description, `availableTools`/`excludedTools`, and an optional lazy skill bundle) — not a Trellage
  profile and not any other harness's concept of a profile. The built-ins are:
  - `validation`: restricted `ask_user`/`rlm` proof worker;
  - `general`: general-purpose recursive execution with only the common `handoff` skill;
  - `superpowers`: design-first/TDD/debugging/review/verification skills from
    `obra/superpowers`;
  - `council`: a Copilot-adapted `/council` bundle from
    `0xNyk/council-of-high-intelligence`;
  - `research`: `/hyperresearch` plus `/last30days` from their latest upstream default branches;
  - `design`: frontier visual-design harness with a soft Claude/Opus preference, combining
    Anthropic frontend/canvas/theme skills,
    Owl designer skills, AntV infographic skills, Builder.io `visual-plan`, and `img2threejs`;
  - `media`: investigation-only video transcription and analysis through the `watch-video` skill
    from `coreyhaines31/makerskills`, supporting YouTube, Loom, Vimeo, meeting recordings, social
    video, local files, and transcript/visual/multimodal depth. Its normalized recursion-local copy
    replaces Gemini native-video upload with dense local frames sent as Anthropic image blocks
    through `copilot-proxy-rs`;
  - `review`: capability-restricted reviewer of supplied evidence, dynamically selected from
    current frontier reasoning/tool-capable models.
    Restricted profiles also constrain the profiles their recursively registered `rlm` tool may
    invoke, preventing a validation/review session from escalating into a full-tool profile.
    The root Submind is the application orchestrator, not a selectable profile. It performs routing,
    synthesis, and verification: its tools are `rlm`, optional `invoke_trellage`, discovered MCP,
    and read-only `view`/`glob`/`grep`/`bash`, with no root-local skills. It reads targeted files
    and search results to verify worker reports, and reruns the run brief's validation commands
    itself to confirm a worker's claim that they passed. It never writes or loads a skill pack.
    A root-only permission handler is the enforcement point rather than the tool list: it rejects
    every write, sandbox bypass, unparsed command, and non-read-only MCP tool, and approves shell
    only when every parsed command is read-only and there is no write redirection. Root shell
    exists for that one confirmation step; delegation stays the primary execution path for any
    check that must write, install, or mutate state.
    The headless root does not advertise native `ask_user` without a live callback; recursive worker
    questions still use the isolated root-conversation answerer. It does not directly implement,
    research, design, or review. Every recursive profile also loads Matt Pocock's upstream
    `handoff` skill;
    profile-specific bundles are added alongside it. Upstream repositories resolve their latest default-branch `HEAD`, cache
    that immutable commit under `.weavekit/rlm-profile-skills`, and pass only the applicable
    directories to the session. Each later use checks `HEAD` again and installs a new cache entry
    only when upstream changed; if the update check is unavailable, the last verified cached
    revision is used with a warning. This `latest` policy trades strict reproducibility for automatic
    updates and therefore trusts those upstream maintainers. Council is normalized from the upstream Codex distribution so its
    agents/configs remain adjacent to the skill. Hyperresearch is installed into an isolated
    isolated, commit-addressed Python virtual environment because its skill files are generated rather than committed
    as directly loadable `SKILL.md` files.
    The research child receives that environment's `bin` directory on `PATH`, runs from a stable
    ignored cache workspace for its persistent vault, and has a one-hour base turn timeout; Council
    has a 20-minute base timeout and its own cache workspace. Media likewise writes generated
    analysis only under its cache workspace. Permission handlers enforce these paths rather than
    relying only on prompt language. These no-repository-write profiles expose the minimum
    shell/read tools their installed workflows require. Enclosing session timeouts are derived recursively from every
    reachable child timeout plus a root setup margin, so a parent cannot abandon a longer-running
    child by default. External install commands have explicit bounds. The shared default
    recursion-tree budget is 12 calls so a small council can deliberate without silently exhausting
    the original four-call proof budget.
    Research additionally fails closed unless the child emits a `skill.invoked` event for
    `hyperresearch` or `last30days`; built-in web search alone does not satisfy the profile contract.
    Media similarly fails closed unless `watch-video` is invoked. It may write derived artifacts
    only to its prepared cache workspace and has no authority to modify repository files.
    The root Submind always considers the `design` profile for complex-topic visualization,
    comparisons, visual plans, infographics, summaries of completed work, and high-quality frontend
    HTML, but skips decorative visuals that would not improve human comprehension. A primarily
    visual deliverable, including DNS topology or resolution-flow work, must route through design.

- The SDK still runs with `enableConfigDiscovery: true` so workspace/host MCP configuration remains
  available. Skills use a stricter independent boundary. Before session creation, SDK discovery
  builds `disabledSkills` from every project, host, plugin, and builtin skill outside the selected
  profile's explicit name/path manifest. After fresh creation or root resume, the session skill
  listing is checked and execution fails before the first prompt if any enabled skill is outside
  that manifest/path. An allowed name discovered from both an explicit and an external path is
  rejected as ambiguous because `disabledSkills` is name-based.
  Profile preparation also reads each installed `SKILL.md` name and fails closed when an explicit
  profile manifest names a missing skill. Research includes the complete generated Hyperresearch
  entry/step pipeline plus `last30days`; Design names concrete `critique-*`, infographic companion,
  and referenced design-system skills rather than category directory names.

- Copilot Memory is disabled explicitly with `memory: { enabled: false }` on the root session,
  recursive workers, isolated `ask_user` answerers, and Trellage answerers. This is separate from
  SDK conversation persistence. Repository instructions and working-tree files remain intentional
  context through config discovery and the inherited working directory.

- One host-owned in-memory ledger is shared by the complete recursive tree. It owns the immutable
  `RlmRunBrief`, stable `<run-id>:call-<number>` IDs, parent links, dependency IDs, and running,
  succeeded, or failed lifecycle transitions. Mutations are synchronous, so parallel siblings
  cannot allocate the same ID or consume incomplete sibling output. Only succeeded calls whose
  typed report outcome is `COMPLETED` can be resolved through `dependsOn`; missing, duplicate,
  running, failed, and non-completed dependencies fail before client creation or call-budget use.
  Failed attempts remain visible as failed ledger records.

- General workers use BAML as the typed boundary. Weavekit renders the brief, delegated task,
  selected dependency reports, and `ctx.output_format`, sends that prompt through the Copilot SDK,
  and parses the same response as `RlmWorkerReport`. It does not make a second normalization model
  call. Invalid output fails the call; there is no success-shaped freeform fallback. Shared
  `vision.md`, `goals.md`, and `progress.md` memory files are not used.

- Every recursive worker receives a generated execution envelope distinct from the d0 Submind
  prompt. It states profile, authority, repository write permission, remaining recursion depth and
  shared call budget, allowed child profiles, and the worker's accountability for integrated,
  verified output. A worker may recursively delegate narrower work within its child-profile
  allowlist, but delegation does not transfer ownership of the bounded task.

- `remainingDepth` is threaded and decremented by the `rlm` tool implementation itself on every
  recursive hop, never by the LLM. It defaults to a configured maximum on the first, top-level
  call. A worker at the last permitted depth does not receive another `rlm` tool. Exceeding the
  max fails closed: `rlm` returns a structured failure to the calling session rather than silently
  truncating or looping.
- One shared total-call budget is also created at the root and synchronously consumed by every
  sibling and descendant invocation. Depth bounds path length; the shared budget bounds breadth and
  recursive `rlm` session cost. Neither is exposed as an LLM-controlled tool argument.
- Every `rlm` invocation gets one Langfuse span named
  `RLM #<call-number> d<depth>/<max> · <profile>` with structured input/output, run/call/parent
  IDs, selected dependency IDs, state revision, execution status, worker outcome, model,
  call-budget state, and SDK tool-call correlation. These nest beneath `SUBMIND d0 · <mode>`,
  forming a directly readable visual recursion spine independent of the lower-level SDK-generated
  spans.

### Prototype validation scenario

The submind is prompted to obtain three answers — favorite movie, favorite book, favorite color —
and, for each one, issues a separate `rlm` call. The validation prompt explicitly tells each
restricted `validation` session to use native `ask_user`; an isolated answerer answers from a snapshot
of the root Submind's full conversation, and the explicit question/answer exchange returns in the
`rlm` tool result. The submind then reports the three pairs back. This exercises multiple sibling
recursive calls from one parent turn, clean child-session isolation, parent-context question
answering, structural result reintegration, and the depth-accounting/Langfuse-span mechanism end to
end without cross-harness work.

### General Submind runtime

`runRlmSubmind(prompt, options)` is a separate reusable path that applies the adapted recursive
Submind orchestration prompt. Its configured-profile inventory is generated from the same registry
used by `rlm`, review is conditional on material changes/risk and remaining budget, and review calls
use the restricted `review` profile. The existing `runRlmPrototype()` and no-argument CLI remain
the narrow three-question validation proof; `scripts/rlm-poc.ts -p "<prompt>"` opts into the general
Submind orchestration path without making the validation proof depend on repository tools or
mandatory review.

Successful general Submind turns expose the root Copilot SDK session ID as the conversation ID.
The headless CLI can continue that conversation with
`--resume <uuid> --prompt "<follow-up>"`; the terminal receipt also links the invocation's
Langfuse trace. Resume delegates persistence to the SDK's durable on-disk session store and calls
`resumeSession`; weavekit does not mirror or replay conversation events through a separate JSONL.
Current tools, permissions, and RLM profile configuration are registered again on resume, while
the runtime scans persisted top-level `rlm` tool-result events for the latest versioned state
checkpoint. It validates and hydrates the immutable brief, stable run ID, completed reports, and
next call sequence before sending the follow-up prompt. Calls that were running in the checkpoint
are marked as interrupted failures. If an older conversation has no checkpoint, its first
persisted user prompt becomes the original objective. Recursion depth and total-call budgets are
fresh for each CLI invocation. Unknown conversations and malformed versioned checkpoints fail
closed instead of silently creating a new conversation. The no-argument validation scenario is
not advertised as resumable.

The root prompt also exposes the loopback `copilot-proxy-rs` service as an optional compatibility
bridge when a third-party dependency requires conventional OpenAI Chat Completions/Responses or
Anthropic Messages APIs. Callers check `/health`, discover live Copilot-hosted model IDs through
`/v1/models`, and keep the proxy loopback-only. This does not replace normal Copilot SDK or `rlm`
execution.

The isolated `ask_user` and Trellage answerers are routed independently to the current
`fast-efficient` group. Their latency-oriented model is not inherited from either the pinned root
or the delegated worker. Catalog path, generation time, candidate IDs, selected model, rationale,
fallback, and root capability mismatch are recorded on Langfuse spans. Malformed or unavailable
catalogs use a small explicit emergency catalog and retain the failure reason in telemetry.

As a bounded recovery exception, a root that remains completely stuck after troubleshooting,
verification, child `ask_user`, and appropriate recursive specialization delegates one bounded
`general` worker to choose one path: send one compact Telegram blocking question when the bot
variables are configured, or invoke the loaded `handoff` skill and pass its redacted temporary
document to at most one new Herdr-managed agent in the same worktree. The d0 root does not perform
shell, file, network, or agent-lifecycle actions itself. This is not a general delegation path and
cannot be used to bypass RLM depth or call budgets.

## Explicitly out of scope for this prototype

These are real, considered directions — not rejected, just deferred until `rlm` itself is proven:

- **A weavekit-owned durable RLM state file.** The SDK root conversation is the canonical resume
  source. Add a separate file or event log only if recovery must work without that conversation
  store or must preserve in-flight work.
- **`invoke_harness`** — a second tool for delegating to other harnesses' own SDKs
  (`@anthropic-ai/claude-agent-sdk`, `@earendil-works/pi-coding-agent`; explicitly not
  `@openai/codex-sdk`, which lacks mid-session question/answer and custom tool registration and was
  deprioritized) or, potentially, Vercel's `@ai-sdk/harness` meta-SDK
  (`@ai-sdk/harness-claude-code`, `@ai-sdk/harness-pi`, `@ai-sdk/harness-opencode`), which already
  normalizes session lifecycle and tool-approval callbacks across several of those backends and may
  turn out to be a better foundation than hand-rolled per-vendor adapters.
- **The two-call bidirectional pattern** (`invoke_harness` returns `{status: "blocked_on_question",
handle, question}`; a second tool `harness_respond(handle, answer)` resumes it) needed because a
  Copilot SDK tool handler cannot hand control back to the outer LLM mid-call — required only once
  a harness with genuine mid-session pause/ask semantics (confirmed so far: Claude Agent SDK's
  `AskUserQuestion` via `canUseTool`) is actually wired in.
- **Trellage container profiles.** _(Superseded by [ADR 0011](0011-invoke-trellage.md).)_
  Investigated and found headless-feasible only in one-shot `-p`
  mode (spawn, capture stdout + exit code, no PTY) with no structured idle/blocked/ask-user signal
  and no follow-up-prompt injection — Herdr's idle/blocked/done detection is Herdr's own TTY
  heuristic, not anything Trellage emits. Multi-turn/interactive Trellage delegation remains
  Herdr's job (`mastermind-submind`), not a recursive `rlm` profile's or a future
  `invoke_harness`'s. The root's one-attempt stuck-recovery handoff is a narrow operational
  exception, not a Trellage integration.
  ADR 0011 revisits this: the reasoning holds for driving Trellage _directly_, but not for driving
  it _through Herdr_, which supplies the missing PTY, lifecycle signal, and prompt injection. The
  `invoke_trellage` tool does exactly that.
- **A raw pty/tmux-driven harness adapter**, for any future harness that has no SDK at all. Not
  needed today because every harness we currently intend to support (Copilot, and later Claude
  Agent SDK, Pi SDK) has one.
- **Local vs. cloud sandbox requirements** for `@ai-sdk/harness` adapters (only confirmed local-only
  for Pi so far) — unverified, and irrelevant until `invoke_harness` work resumes.

## Consequences

`src/rlm-poc/` is additive and isolated, like `src/submind-poc/`: it does not change
`src/mastermind/`, `src/submind/`, or any existing Herdr/Trellage delegation path. It does add a new
runtime pattern — a tool that recursively spins up new Copilot SDK sessions with itself registered
— that must be depth/budget-bounded and Langfuse-observable from its first commit, per this
decision, to avoid silent runaway recursion or unaccounted cost. Future work resuming
`invoke_harness` or cross-harness delegation should revisit this ADR rather than starting a third,
unrelated orchestration mechanism.
