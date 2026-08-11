# Durable Sub-Mind POC Handoff

Date: 2026-08-10

## Objective

Implement `nub scripts/submind-poc.ts` as a proof of concept that creates a Herdr worktree beneath an existing Trellage workspace, starts Copilot as an orchestrator, and lets that orchestrator create and converse with Copilot, Grok, Codex, and Trellage Claude Council workers through a run-scoped Herdr socket helper.

The design follows Loopcraft-style patterns: skill-driven orchestration, bounded state transitions, separate agents, append-only events, durable receipts, reconciliation after interruption, and manifest-based completion. Herdr lifecycle status alone never counts as success.

## Current implementation

All implementation is isolated from the existing Mastermind/Submind work:

- `scripts/submind-poc.ts`: CLI with `start`, `status`, `wait`, and internal `helper` commands.
- `src/submind-poc/contracts.ts`: Zod schemas for state, events, snapshots, workers, and final manifests.
- `src/submind-poc/controller.ts`: start/status/wait state machine, durable mutation intent, reconciliation, transcript state, and orchestrator prompt construction.
- `src/submind-poc/helper.ts`: run-scoped helper operations, exact worker launch allowlist, automatic intent/receipt recording, and manifest validation.
- `src/submind-poc/provision.ts`: canonical repository matching, Herdr workspace resolution, worktree creation/adoption, and root-pane resolution.
- `src/submind-poc/runtime.ts`: default Herdr runtime, interactive-shell alias preflight, orchestrator launch/adoption, prompt dispatch, and live inspection.
- `src/submind-poc/scope.ts`: workspace/pane/agent guardrails and normalized `session.snapshot` access.
- `src/submind-poc/socket.ts`: correlated NDJSON Unix-socket client, timeouts, safe reconnect behavior, event waits, installed-schema loading, and socket spans.
- `src/submind-poc/store.ts`: atomic JSON state/manifest writes, locked append-only JSONL events, and truncated-tail repair.
- `src/submind-poc/skill.ts`: generated `submind-poc` Copilot skill staged into the created worktree.
- `src/submind-poc/telemetry.ts`: nonfatal telemetry shutdown handling.
- `src/submind-poc/index.ts`: exports.

Tests exist under `tests/submind-poc/` for contracts, controller behavior, helper receipts, provisioning, runtime validation, scope guardrails, socket behavior, storage, and telemetry.

## CLI contract

```bash
nub scripts/submind-poc.ts start --cwd <repository> [--detach]
nub scripts/submind-poc.ts status --run <run-id>
nub scripts/submind-poc.ts wait --run <run-id>
```

Run artifacts are stored in:

```text
.weavekit/submind-poc/<run-id>/
```

Generated branches use:

```text
submind/poc-<run-id>
```

The workflow deliberately leaves the worktree, panes, and agents open after completion or failure.

## Implemented behavior

- Persists run intent before Herdr mutations.
- Resolves source workspace by canonical repository path and rejects ambiguity.
- Creates or adopts a matching Herdr worktree from `HEAD`.
- Runs `copilot`, `grx`, `codx`, and `trellage` preflight inside the Herdr interactive shell.
- Stages `.github/skills/submind-poc/SKILL.md` into the generated checkout.
- Launches the orchestrator with `copilot --autopilot --allow-all --no-ask-user`.
- Restricts helper operations to snapshot, split, launch, rename, prompt, wait, read, event, and complete.
- Checks that panes belong to the run workspace and agent names use the run prefix.
- Allows only these worker launch forms:
  - interactive `copilot --autopilot --allow-all --no-ask-user`
  - `grx superpowers --permission-mode bypassPermissions`
  - interactive `codx`
  - interactive `trellage --profile claude-council`
- Records operation intents and receipts automatically; caller-created events cannot forge `source: "helper"`.
- Requires ordered per-worker receipts for launch/rename, question prompt/wait/read, answer prompt/wait/read.
- Requires five distinct live panes and agents, exact worker kinds, a Copilot orchestrator, exact commands, questions, answers, acknowledgements, and ordered timestamps before accepting successful completion.
- Reconciles ambiguous orchestrator launch/prompt delivery without blindly replaying mutations.
- Skips interactive-shell preflight during recovery once orchestrator launch intent exists, preventing shell input from being injected into a live Copilot pane.
- Reconciles a completed manifest before attempting provisioning recovery.
- Adds OpenTelemetry spans without recording prompt contents.

## 2026-08-10 live verification

- Run `bccad8cc` in workspace `w86` launched `trellage --profile claude-council` in its own tab. Herdr detected kind `claude`; Claude Code 2.1.226 reported Opus 5 and asked the requested programming-language question inside `/mounts/submind-poc-bccad8cc`.
- Direct `agent.start` for a Copilot worker populated its composer without submitting. Worker launch now uses interactive pane input, followed by detection and canonical rename.
- `agent.prompt` also populated an interactively launched Copilot worker's composer without submitting. Scoped Copilot prompts now use one atomic `pane.send_input` request containing the text and `Enter`; other harnesses retain `agent.prompt`.
- Run `f527f8b2` in workspace `w87` verified interactive Copilot starts with a clean composer and Trellage Claude Council starts correctly. Its Codex worker auto-updated from 0.146.1 to 0.147.0 and exited requesting restart, so this run is not completion evidence. Run `f877e24a` reproduced the independent worker-prompt submission bug and is also not completion evidence.
- Herdr 0.8 may leave `interactiveReady` false for usable Grok, Codex, and Claude TUIs. Only Copilot requires that field; aliases use correct detected kind plus live idle/done state.

## Review history

Multiple scoped code-review rounds found and drove fixes for:

- distinct agent/pane and exact worker-kind enforcement;
- `agent.wait` timeout handling;
- provisioning recovery and pane fallback;
- persisted wait timeout failure;
- unknown/blocked agent handling;
- event-waiter connection/disconnect behavior;
- helper receipt forgery and per-worker receipt ordering;
- snapshot normalization;
- concurrent JSONL append locking and truncated-tail repair;
- manifest timestamp and outcome constraints;
- orchestrator-kind validation;
- operation-specific pane/agent ID extraction;
- ambiguous orchestrator mutation reconciliation;
- active-tab fallback ambiguity;
- recovery preflight safety;
- nonfatal telemetry shutdown.

The last scoped review reported no remaining Critical or Important findings in those areas. This does not supersede the unresolved live Herdr schema issue below.

## Verification completed in the container

Native Node syntax checks pass for all new production and test TypeScript files:

```bash
for file_path in src/submind-poc/*.ts scripts/submind-poc.ts tests/submind-poc/*.ts; do
  node --experimental-strip-types --check "$file_path" || exit 1
done
```

Full verification could not run in the container:

- `nub run test`: `nub: command not found`
- `nub run typecheck`: `nub: command not found`
- `nub run lint`: `nub: command not found`
- `nub run fmt:check`: `nub: command not found`
- `mise run doctor`: container Mise binary requires unavailable GLIBC 2.38/2.39
- npm fallbacks fail because `node_modules/.nub/*` symlinks point to a host-only `/Users/smendenhall/.cache/nub/...` store.

The host session must run the full required suite after resolving the live issue:

```bash
nub run test
nub run typecheck
nub run lint
nub run fmt:check
mise run doctor
```

## Live host attempts and current blocker

First host invocation:

```bash
OTEL_SDK_DISABLED=true nub scripts/submind-poc.ts start --cwd ~/projects/personal/trellage
```

Initially failed because Herdr 0.8.0 does not accept `--json` on:

- `herdr workspace list`
- `herdr workspace get <id>`
- `herdr pane list`

Those flags were removed. Worktree commands retain `--json`, matching existing `src/submind/` integration.

Telemetry also attempted to export to an unavailable OTLP collector at `127.0.0.1:4318`. `shutdownTelemetry` now reports shutdown failure without replacing the command result. `OTEL_SDK_DISABLED=true` remains useful when no collector is running.

Second host invocation successfully provisioned Herdr resources, then failed with:

```text
Herdr method is absent from installed API schema: session.snapshot
```

Persisted run evidence:

```text
runId: 3340b502
workspaceId: w6B
rootPaneId: w6B:p1
branch: submind/poc-3340b502
worktree: /Users/smendenhall/.herdr/worktrees/trellage/submind-poc-3340b502
```

The failed run is stored at `.weavekit/submind-poc/3340b502/`. It reached worktree provisioning, then failed before orchestrator launch.

## Environment boundary

This Codex session runs in a containerized Linux sandbox:

```text
workspace: /mounts/worktree-lucky-forest-325c
PATH: /usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games
```

It cannot access the host macOS `/Users/smendenhall/...` filesystem, host PATH, Herdr binary, or Herdr socket. In-container checks confirm `herdr`, `nub`, and the Trellage host checkout are unavailable. Therefore no direct read-only verification of live Herdr workspaces or existing agent output was possible from this session.

The host has Herdr 0.8.0 and the Trellage checkout. Continue diagnosis in a host Codex session.

## Immediate host-session investigation

Run these read-only commands from the host Trellage checkout exactly as the POC expects:

```bash
cd ~/projects/personal/trellage
herdr --version
herdr api schema --json > /tmp/herdr-api-schema.json
herdr workspace list
herdr workspace get w6B
herdr pane list
herdr agent --help
```

Then determine whether `session.snapshot` is genuinely absent or whether `collectMethodNames()` in `src/submind-poc/socket.ts` does not understand the installed schema shape:

```bash
jq '.. | strings | select(contains("snapshot"))' /tmp/herdr-api-schema.json
jq 'keys' /tmp/herdr-api-schema.json
```

If `session.snapshot` exists in the schema, add a representative schema fixture and fix `collectMethodNames()` test-first. Its current collector recognizes:

- object keys containing dots;
- string values in fields named `method` or `name` when the value contains a dot.

It may miss a nested schema such as `session -> snapshot` or another Herdr 0.8.0 representation.

If `session.snapshot` is absent, inspect Herdr 0.8.0 read-only API methods and adapt snapshot acquisition to the installed authority. Preserve the POC requirement that all returned envelopes are Zod-validated and that scope checks use live workspace, pane, and agent identities. Do not bypass schema validation merely to make the call proceed.

After identifying the supported read methods, perform read-only verification of:

1. existing workspaces;
2. panes in workspace `w6B`;
3. existing agents and their kinds/statuses;
4. existing agent output using the supported Herdr read operation;
5. the Herdr socket path used by the SDK path.

Do not split panes, launch agents, send prompts, rename agents, or create more worktrees during this diagnostic step.

## Recommended next implementation steps

1. Capture Herdr 0.8.0 schema shape and add it as a focused test fixture.
2. Fix method extraction or snapshot method selection based on that evidence.
3. Add regression tests proving the installed schema exposes every method used by `ScopedHerdr`.
4. Run read-only live snapshot/workspace/agent-output verification.
5. Re-run the POC with a new run ID. Do not reuse failed run `3340b502` as success state.
6. Verify four visible agents, three questions, three answers, three acknowledgements, valid manifest, and successful attached exit.
7. Run the full project verification suite listed above.

## Worktree caution

The repository was already heavily dirty with unrelated Mastermind, generated BAML, configuration, and documentation changes before this work. Preserve them. The Sub-Mind POC files and this handoff are currently untracked; no commit was created.

Owned paths for this task:

```text
scripts/submind-poc.ts
src/submind-poc/
tests/submind-poc/
SUBMIND_POC_HANDOFF.md
```

## Suggested prompt for host Codex

```text
Read AGENTS.md and SUBMIND_POC_HANDOFF.md completely. Continue the Durable Sub-Mind POC from the current dirty worktree. First perform only read-only Herdr 0.8.0 verification from the host: inspect the installed API schema, existing workspaces, workspace w6B panes, existing agents, and existing agent output. Diagnose why session.snapshot is missing from the parsed method set. Add a failing fixture test before changing production code, preserve unrelated dirty work, then implement and run the full required verification suite. Do not create or mutate additional Herdr resources until the read-only diagnosis is complete.
```
