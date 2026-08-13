# 0011 — `invoke_trellage`: recursive Trellage harness delegation

Status: accepted (prototype scope only)

Amends: [ADR 0010](0010-recursive-llm-tool-rlm.md)

## Context

ADR 0010 built `rlm`, a tool that recursively spins up new Copilot SDK sessions in-process. It
explicitly deferred a second tool, `invoke_harness`, for delegating to _other_ harnesses, and
recorded a specific finding that ruled Trellage out at the time:

> **Trellage container profiles.** Investigated and found headless-feasible only in one-shot `-p`
> mode (spawn, capture stdout + exit code, no PTY) with no structured idle/blocked/ask-user signal
> and no follow-up-prompt injection.

That conclusion was correct about Trellage in isolation but drew the wrong boundary. The missing
piece is not a Trellage feature — it is that **Herdr already owns a PTY and already derives the
lifecycle signal**, and weavekit already speaks Herdr's socket API in `src/submind-poc/`. Driving
Trellage _through Herdr_ supplies exactly the structured signal and follow-up-prompt injection ADR
0010 found absent.

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

### Herdr as the execution backend

Delegation runs through Herdr's socket API, behind a `TrellageBackend` seam so a future node-pty
backend can replace it for headless CI. Herdr is a hard dependency of the default backend:
`invoke_trellage` is **not registered at all** unless `HERDR_ENV=1` and the socket resolves, so the
model never sees a tool it cannot use.

This is not merely convenient. The Trellage launcher asserts:

```sh
[[ -t 0 && -t 1 ]] || fail 'an interactive terminal is required'
```

Container mode **cannot** be driven by pipes or `execFile` at all. Only the non-interactive
subcommands (`list`, `validate`, `lock`, `build`, `upgrade`, `ci-verify`) run headless — which is
all catalog discovery needs. A PTY is mandatory, and Herdr already owns one with lifecycle
detection and readable screen output attached. Native launchers use the same PTY path even when
their binary could technically run headlessly, so question handling and completion semantics stay
uniform across both inventories.

### The result file is the completion oracle

This is the central correctness decision, and it reverses the obvious design.

A live spike against both `cldx default` and `trellage --profile claude-council` established that
**Herdr's lifecycle state cannot, by itself, tell you a delegated turn finished**:

- Herdr's `blocked` fires only for _structured_ UI (permission dialogs, question widgets). When
  Claude Code asked a question **in prose**, Herdr reported `idle` — indistinguishable from
  completion.
- `agent.prompt --wait` returned `done` in 6–9s in cases where the agent had more to do. Herdr
  documents this: the wait tracks **lifecycle state, not turns**, and an already-`working` agent's
  current turn can satisfy it.

So the drive loop treats lifecycle state as a _hint about when to look_, and the **result file as
the authority on whether the work is done**:

1. Wait for a settled state (`idle`/`done`/`blocked`).
2. If `blocked` → classify the screen: permission prompt → approve; question → answer.
3. If settled and the **result file exists** → terminal success.
4. If settled and the result file is **absent** → the agent is waiting on something it asked for in
   prose. Read the screen, answer via the root-Submind answerer, re-prompt, and loop.
5. Bound the loop by a turn cap and a wall-clock timeout; `unknown` fails closed.

Every delegated prompt therefore carries a result contract: write the complete final answer as
Markdown to a given path, then reply with only that path.

### The terminal only ever receives a single line

Live runs exposed a failure the lifecycle model cannot see. Copilot CLI collapses multi-line input
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

### Mutating work happens in a dedicated Herdr worktree

Every repository the run touches gets **one** Herdr-managed git worktree, and every Trellage agent
for that repo is launched inside it.

- Provisioned **proactively** at run start for the root repo (on first touch for any other repo)
  by reusing `provisionHerdrWorktree()`, which already implements exactly this.
- Worktrees are always cut from the repository's **main** working tree, not from `cwd`'s. Herdr
  rejects `worktree create` from a linked worktree (`linked_worktree_source`: "New and open worktree
  actions start from the repo parent workspace"), and an RLM run is itself routinely started inside
  a Herdr worktree, so the registry resolves the main checkout via `git worktree list --porcelain`
  before asking Herdr for anything.
- Herdr owns the path: we pass `--branch`/`--base`/`--label` and never `--path`, so the checkout
  lands under Herdr's own `~/.herdr/worktrees/<project>/<name>` convention and is a first-class
  worktree workspace any other Herdr agent can attach to.
- Because recursive `rlm` sessions may also call `invoke_trellage`, concurrent agents could target
  one worktree and corrupt each other's edits. The registry holds a **per-worktree mutex**;
  read-only invocations may run concurrently.
- At run end: a worktree with a clean tree and no commits ahead of its base is removed; anything
  with changes is **kept** and reported to the user with path, branch, and workspace ID.

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

One `invoke_trellage` call is one depth hop and consumes one unit of the shared
`RlmExecutionBudget`. The spawned harness is a **leaf**: it cannot call back into weavekit's `rlm`.
A separate global concurrent-agent cap applies because panes are scarce and user-visible.

## Consequences

- ADR 0010's "Trellage container profiles" exclusion is superseded. Its reasoning stands for
  Trellage driven _directly_; it does not hold for Trellage driven _through Herdr_.
- `src/submind-poc/`'s `socket.ts`, `scope.ts`, and `provision.ts` move to `src/herdr/` and are
  re-exported from their old locations, so `submind-poc` behavior is unchanged. Two orchestration
  paths now share one Herdr client rather than forking it.
- The prototype gains a dependency on a running Herdr server for this tool only. `rlm` itself
  remains pure in-process Copilot SDK recursion with no Herdr dependency.
- Several Trellage profiles (`claude-council`, `claude-research`, `claude-frontend-design`) overlap
  with `rlm` profiles (`council`, `research`, `design`) that approximate them via skill bundles on
  Copilot models. The Submind prompt must state the tradeoff explicitly — `invoke_trellage` runs
  the real harness at higher startup cost; `rlm` is cheaper and in-process — or the model faces two
  undifferentiated options.
- Container startup latency (Docker + harness boot) sits in front of every container invocation, so
  timeouts are generous and the drive loop must not mistake a slow boot for a stall.
- Because container mode requires a TTY, it cannot be exercised in unit tests; the `TrellageBackend`
  seam exists so tests drive a fake and live verification is a separate manual step.

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
