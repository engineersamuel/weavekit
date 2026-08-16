# 0011 — `invoke_trellage`: recursive Trellage harness delegation

Status: accepted (prototype scope only). Amended: execution is exec-only and the Herdr PTY backend
is retired — see the exec-only addendum, which supersedes the container/PTY claims in the Decision
section.

Amends: [ADR 0010](0010-recursive-llm-tool-rlm.md)

## Context

ADR 0010 built `rlm`, a tool that recursively spins up new Copilot SDK sessions in-process. It
explicitly deferred a second tool, `invoke_harness`, for delegating to _other_ harnesses, and
recorded a specific finding that ruled Trellage out at the time:

> **Trellage container profiles.** Investigated and found headless-feasible only in one-shot `-p`
> mode (spawn, capture stdout + exit code, no PTY) with no structured idle/blocked/ask-user signal
> and no follow-up-prompt injection.

That conclusion was correct about Trellage as it then behaved, but drew the wrong boundary. This
ADR originally answered it with Herdr: **Herdr already owns a PTY and already derives the lifecycle
signal**, and weavekit already speaks Herdr's socket API in `src/submind-poc/`, so driving Trellage
_through Herdr_ would supply the structured signal and follow-up-prompt injection ADR 0010 found
absent.

That answer worked but was not the right one. The installed launcher exempts `--output-format
jsonl` from its interactive-terminal assertion and emits the harness's own structured stream, so a
plain child process supplies the same signal with none of the PTY machinery. Herdr is now an
optional interactive surface, not an execution dependency. The exec-only addendum records the
evidence; the Decision section below is annotated where it is superseded.

This ADR resumes that work, renames the tool, and records what a live spike proved.

## Decision

Build `invoke_trellage` in `src/rlm-poc/trellage/`, registered alongside `rlm` on the root Submind
session **and** on recursive `rlm` sessions.

### Naming

The tool is `invoke_trellage`, not ADR 0010's `invoke_harness`. It delegates to Trellage
specifically — container profiles via `trellage --profile <name>` and native profiles via the
launchers returned by `trx list --json`. A broader `invoke_harness` over vendor SDKs
(Claude Agent SDK, Pi SDK) or `@ai-sdk/harness` remains deferred and would be a different tool with
different mechanics; naming this one for what it actually does keeps that door open.

Note the resulting three-way namespace, all using the word "profile":

- an **`rlm` profile** — a local config bundle (model, system message, tools, skill bundle);
- a **Trellage container profile** — `claude-council`, `copilot-hve`, …;
- a **Trellage native profile** — `<launcher> <profile>`, e.g. `grx superpowers`.

`invoke_trellage` takes `{ prompt, harness, profile, model? }`, where `harness` selects the
container mode or a native launcher. `rlm` keeps its own separate `profile` parameter. The optional
model is accepted only for native Copilot (`cpx`) profiles and must be a tool-capable model from
the run's validated `~/.copilot/models.json` snapshot; it is forwarded as `--model <id>`.
Container, Claude, Codex, Grok, Jcode, Prime, and OMP profiles own their model configuration, so a
model override for those harnesses fails explicitly before launch.

Discovery uses the canonical live inventories: `trellage list --json` for container profiles and
`trx list --json` for native launchers. Their normalized `sandbox` metadata is included in the tool
description. Selection remains capability-first, then safety-first among equally suitable profiles:
sandboxed native launcher, container profile, unsandboxed native launcher. The final tier is
deliberately allowed because distinctive harnesses such as Prime may justify host access.
If the installed `trx` cannot aggregate a newer launcher catalog, discovery falls back to each
known launcher's own `list --json`; one incompatible launcher does not suppress the others.

### Headless adapters

The old conclusion that all Trellage delegation needs a TTY was too broad. The verified native
`cldx`, `cpx`, and `omp`/`copilot` launcher paths, **and the Claude container path**, emit
structured headless JSONL and can resume a session. They run through a process-runner seam with
pure per-harness adapters. A profile must explicitly advertise structured events, resume support,
and question-tool denial before it can use this path; every other launcher and container runtime is
withheld from the RLM rather than falling back to a PTY.

For RLM-owned native calls only, Claude receives `--disallowedTools AskUserQuestion` and Copilot
receives `--no-ask-user`. A container's harness flags come from its own profile definition and
cannot be injected by the caller, so the same gate is met structurally instead — see the exec-only
addendum. Manual launcher and container invocations are unchanged. The delegated prompt defines a
portable, versioned clarification envelope:

```text
<trellage_questions version="1">
{"questions":[{"id":"q1","text":"Which database?","choices":["Postgres","SQLite"]}]}
</trellage_questions>
```

The envelope parser runs before semantic diagnosis. It validates JSON, IDs, versions, and mixed
completion/question output deterministically. Valid questions go to the root-grounded answerer,
then RLM resumes the **same** session with ID-preserving answers. A repeated unresolved question
fails closed. A terminal success flag does not prove task success: BAML diagnoses the original goal
after deterministic parsing. There is no heuristic success fallback.

Execution is exec-only. Herdr is not an execution dependency for any profile the RLM can select,
and RLM provisions its isolated Git worktree directly. The Herdr PTY backend code is retained for
now but is unreachable from the production integration, which hard-selects the direct path.

> **Superseded.** This section originally stated that the TTY conclusion "remains true for container
> profiles", that container mode "**cannot** be driven by pipes or `execFile` at all", that "a PTY
> is mandatory for containers", and that Herdr "remains the PTY execution backend and control
> group". All four claims are false against the installed launcher and are disproven by live
> evidence in the exec-only addendum below.

### The result file was the PTY completion oracle

This section records why the PTY path was retired. It is history, not current behavior: the exec
path reads a terminal `result` event and needs no completion oracle.

A live spike against both `cldx default` and `trellage --profile claude-council` established that
**Herdr's lifecycle state cannot, by itself, tell you a delegated turn finished**:

- Herdr's `blocked` fires only for _structured_ UI (permission dialogs, question widgets). When
  Claude Code asked a question **in prose**, Herdr reported `idle` — indistinguishable from
  completion.
- `agent.prompt --wait` returned `done` in 6–9s in cases where the agent had more to do. Herdr
  documents this: the wait tracks **lifecycle state, not turns**, and an already-`working` agent's
  current turn can satisfy it.

So the PTY drive loop treated lifecycle state as a _hint about when to look_, and the
**result file as the authority on whether the work is done**:

1. Wait for a settled state (`idle`/`done`/`blocked`).
2. If `blocked` → classify the screen: permission prompt → approve; question → answer.
3. If settled and the **result file exists** → terminal success.
4. If settled and the result file is **absent** → the agent is waiting on something it asked for in
   prose. Read the screen, answer via the root-Submind answerer, re-prompt, and loop.
5. Bound the loop by a turn cap and a wall-clock timeout; `unknown` fails closed.

Every delegated prompt therefore carries a result contract: write the complete final answer as
Markdown to a given path, then reply with only that path.

### The terminal only ever received a single line

Also PTY history, and part of why that path was retired. Live runs exposed a failure the lifecycle
model cannot see. Copilot CLI collapses multi-line input
into a `[Paste #1 - 14 lines]` block that needs a **second** Enter it does not reliably accept, so
the 14-line delegated prompt sat unsubmitted in the composer. The harness stayed `idle` on a static
screen, which is exactly the signature of a prose question — so the drive loop "answered" it, and
each answer appended to the same unsent block. The turn never started.

So the task is handed over as a **file**, not as terminal input. The tool writes the full contract
to `<result dir>/task.md` and prompts with one short line pointing at it; answers typed later are
flattened to a single line for the same reason. This also sidesteps harnesses that bind Enter to
"newline" inside a multi-line buffer.

As a backstop, when a settled harness has produced no result the loop presses Enter **once** before
concluding it is being asked something. On a harness idling with an empty composer that is a no-op;
on one holding an unsubmitted buffer it starts the turn.

### Settled is not the same as finished: wait for a still screen

Herdr reports Claude Code as `idle` while it is still thinking. Combined with the rule above —
settled plus no result file means "it asked us something" — that made the loop interrupt turns that
were still running, typing answers into a working agent.

Lifecycle state alone is therefore insufficient in both directions. The loop additionally requires
the **screen to stop changing**: it samples the pane every 500ms and only treats the harness as
waiting after three consecutive identical frames. A repainting screen — spinners, elapsed-time
counters, streaming text — is direct proof the harness is busy, and it is the one signal that
generalizes across harnesses. Sampling is capped so a permanent animation degrades to the old
behavior instead of hanging. The same check gates the startup handshake, so a prompt is never sent
into a harness that is still painting its banner.

### Result paths are worktree-relative

The spike confirmed the Trellage container bind-mounts the worktree at `/mounts/<name>`, so the
agent's absolute paths are **not** the host's. It resolves
`worktree="$(git -C "$PWD" rev-parse --show-toplevel)"` and mounts both the worktree and the repo's
`git_common_dir` — the latter being what makes a _linked_ git worktree work inside the container.

The result contract therefore uses a **worktree-relative** path, which the host resolves against
the worktree checkout. Verified end to end: a container write to
`.weavekit/rlm-trellage/<…>/result.md` appeared on the host at the worktree path.

`.weavekit/` is already gitignored, so result files do not dirty the worktree and do not disturb
the "was this worktree touched?" check below.

### Mutating work happens in a dedicated worktree

Every repository the run touches gets **one** isolated Git worktree, and every Trellage agent for
that repo is launched inside it. RLM provisions that worktree directly with Git. The Herdr
provisioning path described in the next two bullets applied only to the retired PTY backend.

- Provisioned **proactively** at run start for the root repo (on first touch for any other repo).
- Worktrees are always cut from the repository's **main** working tree, not from `cwd`'s. Herdr
  rejects `worktree create` from a linked worktree (`linked_worktree_source`: "New and open worktree
  actions start from the repo parent workspace"), and an RLM run is itself routinely started inside
  a Herdr worktree, so the registry resolves the main checkout via `git worktree list --porcelain`
  first. The direct path keeps that resolution because linked worktrees must still branch from the
  main checkout.
- Because recursive `rlm` sessions may also call `invoke_trellage`, concurrent agents could target
  one worktree and corrupt each other's edits. The registry holds a **per-worktree mutex**;
  read-only invocations may run concurrently.
- At run end: a worktree with a clean tree and no commits ahead of its base is removed with
  `git worktree remove --force` plus a branch delete; anything with changes is **kept** and
  reported to the user with its path and branch.

### Blocked-state policy

Permission prompts are **approved**, matching the `approveAll` convention ADR 0010 already adopted
for unattended nested sessions. Questions are answered by the existing
`createSubmindUserInputHandler` mechanism: a fresh isolated session grounded in a snapshot of the
root Submind's conversation, which avoids re-entering the live root session mid-turn.

This is what makes the loop single-call. A Copilot SDK tool handler cannot hand control back to the
outer LLM mid-call, so ADR 0010 anticipated needing a two-call
`invoke_harness`/`harness_respond` protocol. Answering in-handler removes that need. The two-call
pattern remains deferred.

### Bounds

One `invoke_trellage` call is one depth hop. Each process attempt, including every same-session
resume, consumes one unit of the shared `RlmExecutionBudget`. The spawned harness is a **leaf**: it
cannot call back into weavekit's `rlm`. A separate global concurrent-agent cap applies because
container slots and harness rate limits are finite.

## Consequences

- ADR 0010's "Trellage container profiles" exclusion is superseded. Its reasoning stands for the
  container behavior that existed then; the installed launcher now exempts JSONL mode from its
  interactive-terminal assertion, which supplies the structured signal and follow-up-prompt
  injection ADR 0010 found absent. Herdr is not what closed that gap.
- `src/submind-poc/`'s `socket.ts`, `scope.ts`, and `provision.ts` move to `src/herdr/` and are
  re-exported from their old locations, so `submind-poc` behavior is unchanged. Two orchestration
  paths now share one Herdr client rather than forking it.
- No profile the RLM can select requires a running Herdr server. Every selectable profile runs as a
  direct child process, preserves Git worktree isolation, and retains raw attempt evidence for
  failures.
- Several Trellage profiles (`claude-council`, `claude-research`, `claude-frontend-design`) overlap
  with `rlm` profiles (`council`, `research`, `design`) that approximate them via skill bundles on
  Copilot models. The Submind prompt must state the tradeoff explicitly — `invoke_trellage` runs
  the real harness at higher startup cost; `rlm` is cheaper and in-process — or the model faces two
  undifferentiated options.
- Container startup latency (Docker + harness boot, plus an automatic image rebuild when the
  profile image is stale) sits in front of every container invocation, so timeouts are generous and
  a slow boot must not be mistaken for a stall.
- Container argv is now ordinary argv, so it is unit-tested like every other launcher. Live
  verification remains a separate manual step because it costs real harness tokens.

### Addendum: model/effort overrides for native Claude (`cldx`)

The original decision restricted model overrides to native Copilot (`cpx`) because every other
harness "owns its model configuration." Native Claude (`cldx`) is an exception worth carving out:
Claude Code's own CLI accepts `--model <id>` and `--effort <level>` (e.g.
`claude --model claude-opus-5 --effort xhigh`), and Claude Code's own dynamic-workflow feature
(subagents orchestrated from a script it writes, not one conversational turn at a time) is exactly
the kind of long-horizon, high-stakes delegation that benefits from an explicit high-reasoning
model and effort level. `invoke_trellage` now accepts `model` for `cldx` profiles (the harness's
own model ID, not validated against the Copilot catalog) and an `effort` argument, forwarded as
`--effort <value>`, valid only for `cldx` profiles. The Submind system prompt was updated with
explicit guidance: when an implementation is sufficiently complex and a good fit for Claude Code's
workflow model, call `invoke_trellage` with `harness: "claude"`, `model: "claude-opus-5"`,
`effort: "xhigh"`, and a prompt phrased as `"Create a workflow to <context>"` so Claude Code
orchestrates the work as a rerunnable script rather than a single inline turn.

### Addendum: Copilot CLI autopilot + fleet mode for native Copilot (`cpx`)

Native Copilot CLI has two features of its own worth exposing the same way: autopilot mode, which
lets a session work through a task end-to-end without pausing for approval
(`copilot --autopilot --allow-all --max-autopilot-continues <n>`), and `/fleet` mode, a slash
command that decomposes a complex prompt into independent subtasks a session runs across parallel
subagents rather than one sequential turn (see GitHub's `/fleet` and autopilot documentation).
`invoke_trellage` now accepts `autopilot` (boolean, forwarded as `--autopilot --allow-all`),
`maxAutopilotContinues` (forwarded as `--max-autopilot-continues <n>`, defaulted when `autopilot`
is set without one so a long task cannot run away unbounded), and `fleet` (boolean, prefixes the
delegated one-line launch prompt with `/fleet ` so the session decomposes the referenced task
instead of performing it as a single turn) — all three valid only for native Copilot (`cpx`)
profiles, rejected elsewhere by the same `TrellageAutopilotOverrideError` pattern as the `cldx`
model/effort overrides. The Submind system prompt gained a parallel "Delegate to Copilot CLI
Autopilot + Fleet Mode" section: reach for `harness: "copilot"` + `autopilot: true` + `fleet: true`
when the implementation is complex _and_ decomposes into genuinely independent subtasks, and
prefer the Claude Code workflow path instead when the work is better served by a single
rerunnable orchestration script (e.g. cross-checked research/plans, or a large sequenced
migration) rather than parallel subagents.

### Addendum: exec-only execution — Herdr is not an execution dependency

This addendum reverses the container/PTY claims above and retires the Herdr execution backend.

#### What the launcher actually asserts

The interactive-terminal assertion is guarded, not unconditional:

```sh
if [[ "$mode" != prompt && "$mode" != stop && "$mode" != doctor && "$mode" != destroy \
  && ! ( "$mode" == resume && "$prompt_argument_set" == true ) \
  && "$output_format" != jsonl ]]; then
  [[ -t 0 && -t 1 ]] || fail 'an interactive terminal is required'
fi
```

`--prompt`, `resume` with `--prompt`, and `--output-format jsonl` are all exempt. The same flag
also strips `--interactive --tty` from the launcher's `docker container exec`, so no PTY is
allocated anywhere in the chain. The container's Claude runtime entry reads the format from the
environment and appends the harness's own flags:

```sh
managed_args=(--dangerously-skip-permissions --settings "$default_settings")
if [[ "$output_format" == jsonl ]]; then
  managed_args+=(--output-format stream-json --verbose)
fi
```

#### Proven

Verified live against `claude-council` with stdin closed, both streams redirected to files, and no
TTY — the exact shape `execFile`/`spawn` produces:

- `trellage --profile claude-council --output-format jsonl --prompt "…"` exits 0 and emits Claude
  Code stream-json, ending in a `result`/`success` event carrying `session_id`, `num_turns`, and
  `total_cost_usd`.
- `trellage resume --profile claude-council <session-id> --output-format jsonl --prompt "…"` exits
  0 and returns the **same** `session_id`, with the prior turn in context.
- The `system`/`init` event lists the available tools under `permissionMode: "bypassPermissions"`.
  **`AskUserQuestion` is absent**, so `denyQuestionTool` holds structurally in `-p` mode without
  passing `--disallowedTools` — which the caller could not pass anyway, because a container's
  harness args come from its profile definition.
- A stale profile image rebuilds automatically before the run, so no manual build step is needed.

An independent proof run against `claude-social-media` reproduced all of the above, including a
question envelope, a root-grounded answer, and an exact final result across a resume.

Container capabilities therefore equal native `cldx`:
`{structuredEvents, resume, denyQuestionTool, cost}` true, `changedFiles` false. The container
emits the same stream, so `claudeHeadlessAdapter` is reused unchanged.

#### Unproven, and how it fails

- **Only the Claude container runtime has a JSONL branch.** Copilot, Codex, Prime, and Pi container
  runtimes have none. `CONTAINER_HEADLESS_RUNTIMES` therefore admits `claude` only, and every other
  runtime is withheld from the RLM.
- **The runtime is inferred from the profile-name prefix.** `trellage list --json` returns only
  `{name, description, sandbox}`, and `trellage validate <profile>` prints a path, so there is no
  non-interactive way to query a container's harness kind. Trellage names container profiles
  `<harness kind>-<suite>` and derives the container name from the same kind, so the prefix is the
  available signal. A wrong guess fails closed: a runtime with no JSONL branch emits prose, and the
  adapter reports a malformed terminal contract rather than inventing success.
- **Container stdout carries non-JSON noise.** Plugin/marketplace install lines appear on every
  run, and OCI build output appears when the image is stale. `parseJsonLines` already tolerates
  these as `parseWarnings`. This is a Trellage stdout-routing defect — lifecycle and build output
  belong on stderr under `--output-format jsonl` — and is tracked separately in
  `TRELLAGE_JSONL_STDOUT_CONTAMINATION_HANDOFF.md`. It is not a Herdr dependency.
- **No live container contract test runs in CI.** Argv construction, capability gating, and adapter
  routing are unit-tested; the live run costs real harness tokens and stays manual.

#### Consequences of this addendum

- Herdr is an optional interactive surface, not an execution dependency, at both layers: the RLM's
  Trellage delegation and Mastermind's launch of the RLM submind.
- `src/rlm-poc/trellage/herdrBackend.ts`, `backend.ts`, `driveLoop.ts`, and `screen.ts` are retained
  but unreachable from the production integration, which hard-selects the direct path. They should
  be deleted once no rollback to the PTY path is wanted.
