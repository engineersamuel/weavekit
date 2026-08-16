# Trellage profile validation handoff

Date: 2026-08-12
Scope: every profile from `trx list --json` (12 native launcher profiles) and `trellage list
--json` (10 container profiles) — 22 total — invoked once each through `invoke_trellage` via
`mise run rlm "..."`, asking the delegated harness to reply with exactly `HELLO FROM <profile>`.

## Method

For each profile, ran:

```sh
mise run rlm 'Call the invoke_trellage tool exactly once with harness="<h>" and profile="<p>" and
readOnly=true and prompt: Reply with exactly this text and nothing else: HELLO FROM <h>/<p>. Then
report back the exact text the harness returned, verbatim.'
```

`readOnly=true` was used throughout so runs could be issued back-to-back without the per-worktree
mutating mutex. Each run's full transcript is under `/tmp/trellage-profile-tests/<id>.log` (local
machine only, not part of this repo). Live-stalled runs were inspected directly via
`herdr agent list` / `herdr agent read <pane>` and killed manually once the failure mode was
confirmed, rather than waiting out the full 45-minute `invoke_trellage` timeout each time.

## Result summary

**6 of 22 profiles (27%) genuinely worked end-to-end** — the delegated harness launched, read
`task.md`, replied with the exact requested text, and `invoke_trellage` returned that text to the
root Submind. **1 profile** was correctly rejected pre-launch by the existing readiness preflight
(working as designed). **15 profiles (68%) failed**, spanning at least 7 distinct root causes
below.

| #   | Source   | harness/profile                  | Result                 | Notes                                                  |
| --- | -------- | -------------------------------- | ---------------------- | ------------------------------------------------------ |
| 1   | trx      | claude/default                   | ✅ passed              | 60s                                                    |
| 2   | trx      | oh-my-pi/copilot                 | ✅ passed              | 38s                                                    |
| 3   | trellage | container/claude-research        | ✅ passed              | 28s                                                    |
| 4   | trellage | container/claude-social-media    | ✅ passed              | 24s                                                    |
| 5   | trellage | container/copilot-hve            | ✅ passed              | 90s                                                    |
| 6   | trellage | container/pi-oh-my-pi            | ✅ passed              | 26s                                                    |
| 7   | trx      | copilot/hve                      | ⚪ unhealthy (correct) | preflight refused to launch                            |
| 8   | trx      | copilot/awesome                  | ❌ bug                 | repo-context role confusion, never finished            |
| 9   | trx      | copilot/superpowers              | ❌ bug                 | correct answer, but turn_limit before result.md        |
| 10  | trx      | codex/hve                        | ❌ bug                 | stuck on unrecognized hooks-trust dialog               |
| 11  | trx      | codex/superpowers                | ❌ bug                 | agent-detection timeout (300s)                         |
| 12  | trx      | grok/hve                         | ❌ bug                 | "Agent is outside run scope"                           |
| 13  | trx      | grok/superpowers                 | ❌ bug                 | stuck on unrecognized first-run consent dialog         |
| 14  | trx      | jcode/default                    | ❌ bug                 | agent-detection timeout (300s)                         |
| 15  | trx      | oh-my-pi/local                   | ❌ bug/config          | no model configured + answerer returned empty response |
| 16  | trx      | prime/default                    | ❌ bug                 | "agent_not_ready: not an active named agent"           |
| 17  | trellage | container/claude-blog            | ❌ bug                 | prompt stuck unsubmitted in composer                   |
| 18  | trellage | container/claude-council         | ❌ bug                 | agent-detection timeout (300s)                         |
| 19  | trellage | container/claude-frontend-design | ❌ bug                 | prompt stuck unsubmitted in composer                   |
| 20  | trellage | container/claude-qwen-local      | ❌ bug/config          | model_not_supported (HTTP 400) from proxy              |
| 21  | trellage | container/codex-superpowers      | ❌ bug/config          | missing `codex-code-mode-host` binary in image         |
| 22  | trellage | container/prime-agent            | ❌ bug                 | agent-detection timeout (300s)                         |

## Root-cause categories (for Trellage to prioritize)

### A. Agent-detection timeout — 4 profiles (codex/superpowers, jcode/default,

container/claude-council, container/prime-agent)

`invoke_trellage` failed with, e.g.:

```
Timed out after 300000ms waiting for Herdr to detect a Trellage agent in pane w8:p17.
```

No pane ever showed up in `herdr agent list` for these calls. This is a clean, structured failure
(no hang beyond the 300s detection window), but it means 4 of 22 profiles **cannot be driven at
all** in this environment today. Suspect Herdr's agent-detection heuristics don't recognize these
specific launchers' TUI signature, or the launcher failed silently before ever presenting a
detectable prompt. Recommend: run each of these 4 launchers manually inside a Herdr pane and
check `herdr agent explain` against that pane to see why detection never fires.

### B. Unrecognized permission/consent dialogs stall indefinitely — 3 profiles (codex/hve,

grok/superpowers, container/claude-blog & claude-frontend-design composer-stuck, see D)

- `codex/hve`: stuck on a Codex CLI hooks-trust screen (`Press t to trust all; enter to review
hooks; esc to close`) for 8+ minutes with zero progress.
- `grok/superpowers`: stuck on Grok Build's first-run "Help improve Grok" data-retention
  opt-in/out screen with an empty prompt box, for 10+ minutes.

Both are first-run onboarding/consent screens the drive loop's "unambiguous permission dialogs are
approved automatically" logic doesn't recognize. Every fresh profile home (not just these two) is
at risk of hitting an unrecognized first-run screen the very first time it's launched from a given
profile.

### C. Correct answer produced, but call still fails — 1 profile (copilot/superpowers)

The harness printed the exact right text almost immediately, but then got stuck in a **repeated
approval loop**: it kept re-asking (in slightly different phrasing) "may I report this result?",
and the isolated Submind answerer kept re-approving the same request without the harness ever
progressing to actually write `result.md`. This burned all `DEFAULT_TRELLAGE_MAX_TURNS=12` turns
and returned `outcome=turn_limit` — a **false failure** despite the correct answer having been
visible on screen for most of the run. This looks like a `driveLoop` question-detection bug:
repetitive "may I proceed" prose should be recognized as no-progress and handled differently (e.g.
one hard nudge to "just write the file", then fail fast) rather than treated as a fresh question
every turn.

### D. Prompt never submitted from the composer — 2 profiles (container/claude-blog,

container/claude-frontend-design)

Both containers booted cleanly (Docker start, GitHub auth, Claude Code v2.1.228 splash, all
in ~40s) and the correct task prompt (referencing `task.md`) appeared in the input composer — but
it was never actually submitted. The screen stayed byte-for-byte static for 5+ minutes each time.
ADR 0011 documents a one-Enter-press nudge for exactly this scenario ("some harnesses hold a
submitted prompt in their composer"); it did not fire, or did not work, for the Claude Code
container TUI. Given both `claude-blog` and `claude-frontend-design` hit this identically, this
looks systemic to the Claude Code container family rather than a one-off. Notably,
`container/claude-qwen-local` (also Claude Code, different model) **did** get its prompt
submitted, so the nudge is not universally broken — something about these two container profiles'
screen state specifically evades the "3 identical frames then Enter" detector.

### E. Scope / readiness resolution errors — 2 profiles (grok/hve, prime/default)

- `grok/hve`: `Agent is outside run scope: w8:p18` — Herdr spawned the pane, but
  `ScopedHerdr`/`createHerdrTrellageBackend` didn't recognize it as belonging to the current run.
- `prime/default`: `agent_not_ready: agent w8:p1D is not an active named agent` — the pane never
  transitioned to a state the tool treats as ready.

Both fail fast and cleanly (14–32s), so they're at least not costly, but both native profiles are
completely unusable today.

### F. Repo-context role confusion — 1 profile (copilot/awesome)

Delegating to `cpx copilot/awesome` **in the same repository worktree** as the orchestrating
Submind caused it to auto-load this repo's own instructions (`AGENTS.md`, README, and the
`invoke_trellage`-heavy custom instructions), which describe the `invoke_trellage` orchestration
system in detail. The delegated harness then concluded **it** was supposed to find/call
`invoke_trellage`, searched for the binary, read `trellage`'s own source, and reported itself
"genuinely blocked" rather than simply completing the one-line task in `task.md`. This is not a
missing-capability bug (delegated harnesses correctly never get `invoke_trellage`) — it's context
pollution: when the delegate's cwd is the same repo that documents this very orchestration system,
the delegate can mistake itself for the orchestrator. Consider either (a) not relying on the
delegate reading repo-root docs at all for simple/short tasks, or (b) having `task.md` explicitly
state "you are not the orchestrator and have no `invoke_trellage` tool" when the target repo's own
docs mention it.

### G. Profile/environment misconfiguration (not an orchestration bug per se) — 3 profiles

- `trx copilot/hve`: `inventory --json` correctly reports `readiness: "unhealthy"`, and
  `invoke_trellage` correctly refused to launch it — **this one is the tool working as intended.**
  The underlying `cpx hve` native profile itself needs repair.
- `trx oh-my-pi/local`: the keyless local-Qwen route has "No model selected" (no API key /
  `agent.db` provisioned for `omp/local`). Compounding bug: instead of surfacing that harness error
  text, `invoke_trellage` reported `"The submind answerer returned an empty response."` — the
  driveLoop misrouted the harness's error screen to the isolated `ask_user` answerer, which
  returned nothing, masking the real, more actionable error.
- `trellage container/claude-qwen-local`: prompt submitted fine, but hit
  `API Error: 400 Copilot request failed with HTTP 400: model_not_supported` for
  `qwen3.6-35b-a3b-local` via `copilot-proxy-rs`, then sat idle with no `result.md`.
- `trellage container/codex-superpowers`: prompt submitted fine, but the Superpowers skill workflow
  immediately self-blocked: `codex-code-mode-host` is missing from the container image
  (`/mise/installs/http-codex/0.147.0/codex-code-mode-host: No such file or directory`), so it
  refused to even read `task.md`.

## Recommendations for Trellage

1. **Fix agent-detection for codex/superpowers, jcode/default, container/claude-council,
   container/prime-agent** — 4 profiles are completely unusable until Herdr can detect their
   panes at all.
2. **Handle first-run onboarding/consent screens** (Codex hooks-trust, Grok data-retention
   opt-in) as recognized dialogs to auto-approve, the same way other permission prompts are
   handled — otherwise every profile risks a stall the very first time its profile home is used.
3. **Fix the composer-stuck nudge for Claude Code containers** — `claude-blog` and
   `claude-frontend-design` never got their prompt submitted despite the documented Enter-nudge;
   `claude-qwen-local` did, so there's a fixable inconsistency here.
4. **Fix the repeated-approval loop for `copilot/superpowers`** — the correct answer was already
   on screen; the call still failed via `turn_limit` because the same "may I proceed" question kept
   getting re-approved without forward progress.
5. **Surface the harness's real error instead of "submind answerer returned an empty response"**
   when the delegated harness is displaying a config/model error rather than asking a real
   question (`oh-my-pi/local`).
6. **Repair broken profile environments directly**: `cpx hve` (unhealthy per `inventory --json`),
   `omp/local` (no model configured), `claude-qwen-local` (model rejected by the proxy), and the
   `codex-superpowers` container image (missing `codex-code-mode-host`).
7. **Fix scope/readiness resolution** for `grx hve` ("outside run scope") and `prx default`
   ("not an active named agent") so both native profiles can be driven at all.
8. Consider whether native profiles delegated **within the orchestrator's own repository/worktree**
   should be told explicitly in `task.md` that they are not the orchestrator and have no
   `invoke_trellage` tool, to avoid the `copilot/awesome`-style role confusion when the target repo's
   own docs describe this very system.

## Raw evidence

Full transcripts for every run are on the local machine under
`/tmp/trellage-profile-tests/<profile-id>.log` (one file per profile tested). Key excerpts are
quoted inline above; ask if the raw logs need to be attached separately.
