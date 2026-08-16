# Herdr → Trellage handoff: remaining profile-validation issues (2026-08-13)

## Purpose

This is a debugging handoff for the Trellage team covering every issue still
open after the first round of validation (`TRELLAGE_PROFILE_VALIDATION_HANDOFF.md`,
2026-08-12) and the subsequent re-verification of your two fixes
(`TRELLAGE_REVERIFICATION_RESPONSE.md`, 2026-08-13). It exists so you don't
have to re-derive root causes we've already isolated. For each issue we state:
**who owns the fix** (Trellage vs. Herdr/RLM-POC), **exact repro steps**, and
**suggested fix**, so you can immediately tell which items are actionable in
your repo vs. which are already filed against us and need no action from you.

Read `docs/herdr-compatibility.json` alongside this doc — every profile below
maps to one entry there.

---

## Issues that are Trellage's to fix

### 1. `codex-superpowers` container — build-time `curl` redirect bug (blocks the profile entirely)

**Status:** was `untested` after your PR #80 fix; re-verification shows the
fix does not work — the image build itself now fails.

**Root cause:** `packages/trellage-cli/src/application.ts`, `builderScript()`,
around line 245 — the `curl` call that downloads the `codex-code-mode-host`
companion binary is missing `--location`/`-L`:

```sh
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --output "$codeModeHostArchive" "$codeModeHostArtifact.url"
```

GitHub release-asset URLs (`github.com/.../releases/download/...`) respond
with an HTTP 302 redirect to `release-assets.githubusercontent.com`. Without
`-L`, `curl --fail` does **not** treat this redirect as an error — it exits
`0` but writes a **0-byte file**. Your subsequent size check then fails
silently inside the build:

```sh
[ "$(wc -c < "$codeModeHostArchive")" -eq "$codeModeHostArtifact.size" ]   # 0 -ne 17260137
```

...and the whole `mise oci build` aborts. The failure never reaches the
terminal in a diagnosable form because `application.ts`'s `run()` wrapper
discards the underlying `cause` when constructing `ApplicationError`, so the
CLI only ever prints:

```
trellage profile: command failed: docker
```

**Reproduction (standalone, no Trellage code, just Docker):**

```sh
docker run --rm --platform linux/arm64 alpine:3.20 sh -c \
  "apk add --no-cache curl >/dev/null 2>&1; \
   curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
     --output /tmp/x.tar.gz \
     'https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz'; \
   echo EXIT=\$?; wc -c /tmp/x.tar.gz"
# => EXIT=0
# => 0 /tmp/x.tar.gz
```

Adding `-L`/`--location` to the same command downloads the file correctly
(confirmed 17,260,137 bytes matching the locked `size`/`integrity` in
`profiles/codex-superpowers/profile.linux-arm64.lock.toml`).

**Suggested fix:**

- Add `--location` to the `curl` invocation at `application.ts` line ~245.
- Audit the structurally identical `curl --fail ... --output` call at
  line ~356 (Prime harness release tarball download) — same flag set, and if
  that URL is also a redirecting release asset, it has the same latent bug
  even if it hasn't been hit yet.
- Consider not swallowing `cause` in the `ApplicationError({ message:
"command failed: ${command}", cause })` wrapper (or print `cause` to
  stderr before exit) — this would have made the real failure (a failed size
  check inside the container's shell script) visible immediately instead of
  requiring us to bisect `builderScript()` by hand.

**Verification once fixed:** rebuild with `trellage build --locked
profiles/codex-superpowers/profile.toml`, confirm the image contains a
non-empty, executable `codex-code-mode-host` on `PATH` next to `codex`, then
we will re-run the same `invoke_trellage` smoke test used throughout this
validation (`harness="container"`, `profile="codex-superpowers"`, prompt
`"Reply with exactly this string and nothing else: HELLO FROM
codex-superpowers"`).

---

### 2. `omp/local` — no model provisioned (environment/profile setup, not a code defect)

**Status:** unresolved, not attempted by Trellage yet.

The `oh-my-pi/local` profile (keyless local Qwen route) reports "No model
selected" — its profile home has no configured API key or `agent.db`. This
looks like a provisioning gap rather than a bug: the profile needs either a
model registered, or should be marked `not-setup` in the ledger until that
infrastructure exists.

**Action for Trellage:** confirm whether `omp/local` is meant to be usable
today. If yes, document/provision what `agent.db` or API key it expects. If
it's intentionally a stub/future profile, mark it `not-setup` (not
`known-issue`) in `docs/herdr-compatibility.json` so callers don't keep
hitting a real failure for an intentionally-incomplete profile.

### 3. `claude-qwen-local` container — same underlying local-Qwen gap

**Status:** unresolved, not attempted by Trellage yet.

Prompt submission works fine on this profile (unlike claude-blog/
claude-frontend-design, see below), but the harness then gets `HTTP 400
model_not_supported` for `qwen3.6-35b-a3b-local` from `copilot-proxy-rs`. Same
root cause as `omp/local` above — no local Qwen backend registered with the
proxy. Not fixable via a Trellage code change without changing the profile's
intended (offline/local) purpose.

**Action for Trellage:** same recommendation as above — either provision the
model or mark `not-setup` until it's available.

---

## Issues already known to be Herdr's responsibility (informational — no action needed from Trellage)

These live in Herdr's `driveLoop`/agent-detection/consent-dialog/question-
detection logic (a separate codebase from Trellage), so they cannot be fixed
by changing profile definitions or the `trellage`/`trx` CLIs. Listed here only
so you have the full picture and don't duplicate investigation if you see
these profiles still failing in your own testing.

| #       | Category                                        | Profiles affected                                                                                                 | Symptom                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A       | Agent-detection timeout                         | `codex/superpowers`, `jcode/default`, `container/claude-council`, `container/prime-agent`                         | `Timed out after 300000ms waiting for Herdr to detect a Trellage agent`; no pane ever registers in `herdr agent list`.                                                                                                                                                                                                                                                                                                     |
| B       | Unrecognized first-run consent dialogs          | `codex/hve` (hooks-trust screen), `grok/superpowers` (data-retention opt-in)                                      | Stalls indefinitely; not one of the dialogs Herdr auto-approves.                                                                                                                                                                                                                                                                                                                                                           |
| C       | Repeated-question / no-progress detection       | `copilot/superpowers`                                                                                             | Correct answer appears almost immediately, but harness is repeatedly asked "may I report this?" by the isolated answerer, which keeps re-approving without progress until `DEFAULT_TRELLAGE_MAX_TURNS=12` is exhausted → false `turn_limit` failure.                                                                                                                                                                       |
| D       | Composer-stuck (prompt loaded, never submitted) | `container/claude-blog`, `container/claude-frontend-design`                                                       | Container boots cleanly, correct prompt appears in Claude Code's input composer, but the documented "3 identical frames → 1 Enter nudge" mechanism never fires; screen stays static for 5+ min. Notably `container/claude-qwen-local` (same Claude Code harness) _does_ get its prompt submitted, so this isn't universal — something about these two profiles' screen state specifically evades the stuck-frame detector. |
| E       | Scope/readiness resolution errors               | `grok/hve` ("Agent is outside run scope: w8:p18"), `prime/default` ("agent_not_ready: not an active named agent") | Fail fast (14–32s) before any drive loop begins; `ScopedHerdr`/`createHerdrTrellageBackend` doesn't recognize these panes as ready/in-scope.                                                                                                                                                                                                                                                                               |
| F       | Repo-context role confusion                     | `copilot/awesome`                                                                                                 | Delegating within the orchestrator's own worktree causes the delegate to read the repo's own `invoke_trellage`-describing docs and mistake itself for the orchestrator. This is an orchestration-prompt design issue in the calling tool (`task.md` doesn't state "you have no `invoke_trellage` tool"), not a Trellage profile defect.                                                                                    |
| G (new) | Startup-screen misdetected as a question        | `cpx hve` (re-verified 2026-08-13)                                                                                | Plugin repair confirmed working (`readiness: healthy`), but Copilot's plain startup/tip screen was misclassified as a real question by Herdr's detection heuristic, producing `"The submind answerer returned an empty response."`                                                                                                                                                                                         |
| G (new) | Harness error screen misrouted as a question    | `oh-my-pi/local`                                                                                                  | Separately from the missing-model provisioning issue (#2 above), the tool also misreports OMP's own displayed error text ("No model selected. Use /login...") as `"The submind answerer returned an empty response."` instead of surfacing the harness's actual, more actionable error.                                                                                                                                    |

---

## Summary checklist for Trellage

- [ ] Fix: add `--location` to the `curl` call in `builderScript()` for
      `codex-code-mode-host` (`application.ts` ~line 245); audit the Prime
      release-tarball `curl` call (~line 356) for the same gap.
- [ ] Consider: stop discarding `cause` in `ApplicationError` for shelled-out
      commands, so build failures are diagnosable from CLI output alone.
- [ ] Decide/provision: `omp/local` and `container/claude-qwen-local` local
      Qwen model routing — either provision a backend or mark `not-setup`.
- [ ] No action needed on categories A–F and the two new "G" items — these
      are tracked on the Herdr/RLM-POC side.

Once the `curl -L` fix lands and `codex-superpowers` is rebuilt, ping us and
we'll re-run the same one-line `HELLO FROM codex-superpowers` smoke test used
throughout this validation to close the loop.
