# Herdr re-verification response (2026-08-13)

## Context

Per your hand-off (2026-08-12), two profiles were marked `untested` after fixes:
`cpx hve` (repaired plugin) and `codex-superpowers` container (packaged
`codex-code-mode-host` companion binary). We re-ran both end-to-end through
`mise run rlm` / `invoke_trellage`. **Neither currently completes a round
trip.** Two new, distinct, reproducible issues were found — one is ours, one
is yours.

## 1. `cpx hve` — plugin repair confirmed good; new failure is on our side

`cpx inventory hve --json` now reports `readiness: "healthy"` with the
`hve-core-all@hve-core` plugin present — your repair worked as described.

However, the live `invoke_trellage` call still failed:

```
<- invoke_trellage done (The submind answerer returned an empty response.)
```

Root cause: Copilot launched cleanly and showed only its normal startup/tip
screen (no real question was asked). Our own question-detection heuristic
(Herdr + RLM-POC integration) misclassified that startup screen as "the
harness is asking something," routed it to the isolated answerer, which had
nothing real to answer and returned empty text, which we then throw as an
error (`src/rlm-poc/trellage/integration.ts:167`).

**Action: none needed from Trellage.** This is filed on our side as an
RLM-POC/Herdr bug (fragile startup-screen vs. real-question detection). We'll
update the ledger to `verified` for `cpx hve` once we've fixed our own
detection heuristic and re-run.

## 2. `codex-superpowers` container — your fix (PR #80) has a bug

The intent of PR #80 (locking + installing the `codex-code-mode-host`
companion binary) is correct, and the lockfile
(`profiles/codex-superpowers/profile.linux-arm64.lock.toml`) is correctly
updated. But the actual image build fails, and we root-caused why.

**Bug:** `builderScript()` in `packages/trellage-cli/src/application.ts`
(~line 245) downloads the companion binary with:

```sh
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --output "$codeModeHostArchive" "$codeModeHostArtifact.url"
```

This is missing `--location`/`-L`. GitHub release-asset URLs return an HTTP
302 redirect to `release-assets.githubusercontent.com`. Without `-L`, `curl
--fail` treats the redirect response as terminal: **it exits 0 but writes a
0-byte file** (curl does not consider a bodyless redirect response an
"error" in this case, so `--fail` doesn't trigger). The subsequent size check

```sh
[ "$(wc -c < "$codeModeHostArchive")" -eq "$codeModeHostArtifact.size" ]
```

then fails (0 != 17260137) and `mise oci build` aborts. The wrapping
`ApplicationError` in `application.ts` discards the underlying stderr/cause,
so this surfaces to a caller only as the opaque:

```
trellage profile: command failed: docker
```

**Reproduction** (run directly in a matching `alpine:3.20`/`linux-arm64`
container, no Trellage code involved):

```sh
$ curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --output /tmp/x.tar.gz \
    'https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz'
$ echo $?      # 0
$ wc -c /tmp/x.tar.gz   # 0 /tmp/x.tar.gz
```

Adding `-L`/`--location` to the same command downloads the file correctly
(confirmed 17,260,137 bytes, matching the locked `size`/`integrity`).

**Suggested fix:** add `--location` (or `-L`) to the `curl` invocation at
`application.ts` line ~245 (the `codex-code-mode-host` download). Worth
auditing the other `curl --fail ... --output` call at line ~356 (Prime
harness release tarball) for the same gap, since it uses an identical
flag set against what may also be a redirecting release-asset URL.

**Secondary/minor:** consider not swallowing the underlying `cause` in the
`ApplicationError({ message: "command failed: ${command}", cause })` wrapper
(or at minimum printing `cause` to stderr before exiting) — this failure mode
would have been immediately diagnosable from the CLI's own output instead of
requiring us to bisect the builder script by hand.

## Operational note (not a bug, just a heads-up)

While re-testing we hit `trellage: profile container is stale but has an
active session` — a container from the earlier broken build was still
running and blocked a fresh launch attempt until we manually
`docker stop`/`docker rm`'d it. Once the curl fix above lands and a clean
image builds, this shouldn't recur for this profile, but it's worth
confirming your stale-session detection reliably surfaces (and ideally
auto-recovers from) builds that failed mid-way rather than requiring manual
Docker cleanup.

## Ledger status after this re-verification

- `cpx hve`: remains `untested` for the full round trip (plugin fix
  confirmed good; blocked on an RLM-POC-side detection bug, not
  Trellage's). We'll flip to `verified` once our fix lands.
- `codex-superpowers` container: still `known-issue`, but the issue has
  moved from "binary missing at runtime" (fixed) to "build-time curl bug
  silently produces a 0-byte binary, aborting the build" (new, in PR #80's
  own fix). Recommend keeping `known-issue` until the `--location` fix is
  applied, rebuilt, and re-verified.
