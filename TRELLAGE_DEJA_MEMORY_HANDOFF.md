# Trellage Deja global-memory handoff

Date: 2026-08-13  
Target repository: `engineersamuel/trellage`  
Required working directory: a writable, isolated Trellage worktree

## Objective

Make Deja `0.17.0` a Trellage-managed, user-global memory capability enabled by default for both
Trellage Sandbox and Trellage Native (`trx`). Each profile must retain its isolated `HOME`, notes,
harness configuration, and rebuildable Deja index. Cross-profile and cross-project memory moves
only through Deja's redacted append-only sync batches in a Trellage-owned exchange directory.

This is orchestration and distribution work. Do not build a second memory engine, parse memory
semantics in Trellage, or share live Deja databases between profiles.

## Non-negotiable architecture

- Pin Deja `0.17.0`; never resolve an ambient `deja` from `PATH`.
- Install the Linux artifact into every sandbox image and a Trellage-owned platform artifact for
  native launchers.
- Keep every profile's notes and live index under that profile's existing isolated `HOME`.
- Exchange only completed `deja-sync-*.jsonl` batches under:

  ```text
  ${XDG_DATA_HOME:-$HOME/.local/share}/trellage/deja-sync/v1
  ```

- Create the exchange and its parents with owner-only permissions. Reject symlinks and non-regular
  batch files at every trust boundary.
- Export into a per-run staging directory, validate the completed output, then publish by atomic
  rename. Concurrent exporters must not truncate, overwrite, or expose partial batches.
- Keep v1 append-only. Deja-imported records must not be re-exported, preventing replication loops.
- Containers transfer batches through writable `/tmp` plus `docker cp`. Do not add a fifth mount.
- Preserve the current exact four-mount contract: worktree, Git common directory, profile state
  volume, and read-only Copilot model catalog.
- Do not share harness homes, Docker state volumes, live indexes, or repository-local `.weavekit`
  directories.
- Do not migrate `.weavekit/deja-shared` canaries into global memory. Preserve them only as prior
  test evidence.

## Expected user experience

Memory defaults to enabled:

```text
TRELLAGE_MEMORY=deja   # default
TRELLAGE_MEMORY=off
trellage --no-memory ...
trx --no-memory ...
```

Add these diagnostics and explicit refresh commands:

```text
trellage memory status [--profile NAME]
trellage memory sync --profile NAME
trx memory status
trx memory sync
```

`trellage memory status` must report the managed binary version, exchange health, last import and
export timestamps, and batch counts without printing memory content. `memory sync` refreshes an
existing container for the current worktree and reports clearly when none exists; it must not
silently create a container.

`trx memory status` covers every installed native profile. `trx memory sync` refreshes installed
profiles serially so diagnostics are deterministic and resource usage remains bounded.

The environment variable is the common policy boundary. A CLI `--no-memory` flag overrides the
default for that invocation without mutating profile configuration.

## Session lifecycle

Use one focused memory helper from both sandbox and native launchers. Keep policy and filesystem
validation in that helper; launcher-specific code should provide only execution and transport.

Before every harness launch:

1. Run `deja index` against the history visible in the isolated profile home.
2. Import every validated batch currently present in the global exchange.
3. Idempotently run `deja install --auto --no-index` against the isolated harness configuration.
4. Launch the harness with `DEJA_RECALL=safe`.

After the harness exits:

1. Refresh the local index.
2. Export only new local records into a private staging directory.
3. Validate each regular `deja-sync-*.jsonl` output.
4. Atomically publish complete batches to the global exchange.
5. Record content-free import/export status for diagnostics.

Use shell traps or `try/finally` so post-session publication runs after normal exits and interrupt
handling where possible. Preserve the harness's exit status. Index, import, installation, export,
and publication failures warn and continue; memory must never prevent the harness from launching
or change an otherwise successful harness result into failure.

When `TRELLAGE_MEMORY=off` or `--no-memory` is active, perform no Deja binary lookup, index,
installation, import, export, Docker copy, or exchange-directory mutation.

## Repository integration points

Confirm exact placement against current Trellage structure before editing. Likely touch points are:

- `prototypes/trellage/trellage`: sandbox argument parsing, lifecycle hooks, `memory` subcommands,
  container lookup, `docker cp`, doctor output, image-label validation, and the four-mount guard.
- `prototypes/trellage/runtime-*-entry.sh`: invoke the shared helper around the actual harness only
  if the host launcher cannot perform a lifecycle phase directly.
- `prototypes/trellage-router/bin/trx`: aggregate native `memory status` and serial `memory sync`,
  plus router-level `--no-memory` forwarding.
- `prototypes/trellage-*-profiles/bin/*`: native launch lifecycle and owned binary selection.
- `prototypes/trellage-*-profiles/install.sh`: install or link the Trellage-owned Deja runtime in a
  stable location available to every installed launcher.
- Sandbox Dockerfiles and profile compiler inputs: install the pinned Linux artifact and attach an
  image label containing the exact managed Deja version.
- Profile lock/compiler code: carry platform URL, SHA-256, byte size, and version deterministically
  into generated locks and image builds.
- Existing shell contract suites under `prototypes/trellage/tests/`,
  `prototypes/trellage-router/tests/`, and each native profile's `tests/contract.sh`.
- Root/profile matrix tests and `scripts/verify-agent-profiles` for exact installed runtime and
  lifecycle validation.
- `README.md` and an appropriate document under `docs/` for behavior, privacy, and v1 limits.

Prefer a new narrowly scoped helper such as `scripts/deja-memory` or a library under
`prototypes/trellage/lib/` that exposes explicit operations for `prepare`, `finalize`, `status`, and
container transfer. Do not duplicate a long shell sequence across seven native launchers and the
sandbox launcher.

## Managed binary contract

Resolve official Deja `0.17.0` release artifacts for every supported host platform and Linux image
platform before implementation. Record literal URL, SHA-256, and byte size in the same lock path
used for other deterministic artifacts. Tests must fail if any field is absent or if the downloaded
artifact does not match both size and checksum.

Native execution must use a path derived from the Trellage installation, never `command -v deja`.
Sandbox execution must use the fixed image path. `doctor` must verify:

- the selected path is Trellage-owned;
- it is a regular executable file, not a symlink escape;
- `deja --version` reports `0.17.0`;
- the sandbox image label reports the same version;
- an ambient fake `deja` earlier on `PATH` is ignored.

Do not put an unverified downloaded executable in a user-writable profile directory and then trust
it on later launches.

## Exchange safety contract

The shared helper must make these properties observable and contract-tested:

- Every exchange path component is the expected owner, is not a symlink, and is not writable by
  group or other users.
- Exchange and staging directories use mode `0700`; batch and status files use `0600`.
- Imported inputs are regular files named exactly `deja-sync-*.jsonl`.
- Incomplete temporary files are ignored and never imported.
- Publication is an atomic rename within the exchange filesystem.
- A collision cannot overwrite an existing batch. Treat identical content as already published;
  choose a new safe name or fail that batch with a warning for a true collision.
- Multiple exporters can publish concurrently without lost files.
- Re-importing the same batch is idempotent.
- A malformed or unsafe batch warns and is skipped without blocking other valid batches.
- Status metadata contains timestamps, counts, versions, and outcomes only—never note text.

Use content digests or Deja's stable batch identity for deduplication rather than filenames alone.
Keep v1 batches indefinitely; garbage collection is explicitly out of scope.

## Container flow

Do not weaken `container_mount_state` or its exact count check. A sandbox sync should follow this
shape:

1. Validate the existing current-worktree container, image labels, state volume, and four mounts.
2. Create private host and container staging directories.
3. Copy validated exchange batches into container `/tmp` with `docker cp`.
4. Run the managed in-container helper against the isolated `/home/agent` state.
5. Export into container `/tmp`, then copy completed outputs back to host staging.
6. Validate again on the host and atomically publish to the exchange.
7. Remove staging paths best-effort without modifying the user-owned worktree.

Normal session startup and shutdown should reuse the same operations. Manual sync must refuse
containers with stale labels, unexpected mounts, foreign ownership, or mismatched managed Deja
versions.

## Recall semantics

- Explicit/manual MCP recall searches imported memory from all projects.
- Automatic SessionStart recall remains current-project-only and uses `DEJA_RECALL=safe`.
- Test both behaviors. A successful cross-project MCP recall is not proof that safe automatic
  recall is scoped correctly.

Do not add Trellage-side semantic filtering that Deja or the harness already provides.

## Recommended TDD sequence

Work in small red-green slices; do not begin with the live matrix.

1. **Binary lock and resolution**
   - Failing contracts for exact version, URL/checksum/size, owned native path, image label, and no
     ambient fallback.
   - Implement deterministic resolution and image installation.
2. **Exchange filesystem helper**
   - Failing contracts for permissions, symlinks, regular-file validation, incomplete files,
     atomic publication, collisions, concurrency, and deduplication.
   - Implement pure host-side prepare/import/export/status operations using fake Deja fixtures.
3. **Native lifecycle**
   - Failing launcher contracts for ordering, `DEJA_RECALL=safe`, trap/finally behavior, preserved
     exit status, warning-only failures, and zero work when disabled.
   - Integrate the common helper into each launcher without forking policy.
4. **Sandbox lifecycle and transfer**
   - Failing Docker-fake contracts for `docker cp` sequencing, `/tmp` staging, no extra mount,
     current-container validation, and warning-only failures.
   - Integrate startup, shutdown, doctor, status, and manual sync.
5. **Public CLI**
   - Failing contracts for environment defaults, both `--no-memory` flags, content-free status,
     missing-container output, and serial native sync.
6. **Isolated-home acceptance**
   - Two fresh homes: create a canary in A, export, import into B, rebuild B's index, and recall it
     through MCP.
   - Prove imported records are not re-exported.
7. **Live matrix**
   - Two unrelated Git repositories.
   - Two sandbox profiles.
   - Native TRX to sandbox.
   - Sandbox to native TRX.
   - Safe automatic recall excludes unrelated-project memory while explicit MCP recall finds it.

All unit/contract tests should use fake binaries and temporary homes. Live model calls and Docker
images belong only in explicitly named opt-in acceptance tasks.

## Required verification

Follow the Trellage `AGENTS.md` commands and use fresh output before claiming completion:

```sh
mise trust
make test
make profile-compiler
make profile-matrix-test
make profile-matrix
cd packages/trellage-cli && npm run lint
cd packages/trellage-cli && npm run format:check
cd packages/trellage-cli && npm run check
cd packages/trellage-cli && npm run build
```

Also run the new focused Deja contracts directly while iterating. After compiler, launcher, and
image changes, refresh installed artifacts and images as directed by the repository guide:

```sh
mise run rebuild-profiles
```

Run paid/live profile probes only with explicit authorization. The final verification report must
separate deterministic contract results from live Docker/harness results.

## Weavekit follow-up

Do not add a memory transport to weavekit's `invoke_trellage`. Trellage owns memory setup and
publication around the delegated harness lifecycle.

After the Trellage implementation is available, make a small change in the weavekit repository:

- Add an integration test proving `invoke_trellage` launches the selected Trellage/TRX profile
  normally and does not inject a second memory transport or force `--no-memory`.
- Document in `RLM_POC_HANDOFF.md` and/or ADR 0011 that delegated harness memory is supplied by
  Trellage according to its profile/session policy.
- Run `nub run test -- tests/rlm-poc`, `nub run typecheck`, `nub run lint`, `nub run fmt:check`, and
  `mise run doctor`.

The current weavekit worktree contains substantial unrelated in-progress changes. Preserve them
and avoid broad formatting or generated-code churn.

## Documentation requirements

Document these limitations plainly:

- Global means one OS user account. Multi-machine propagation remains Deja's SSH sync feature.
- Consistency occurs at session boundaries unless the user invokes manual sync.
- Sync batches are redacted but may still contain sensitive prose and are owner-readable only.
- Deja forget/tombstone behavior remains local in v1. Global revocation is not implemented.
- Batch garbage collection is not implemented in v1.
- Existing worktree-local Deja stores are not migrated or deleted automatically.

## Completion checklist

- [ ] Deja `0.17.0` is locked with platform URL, checksum, and size.
- [ ] Native and sandbox execution use only Trellage-owned binaries.
- [ ] Images carry and doctor validates the managed Deja version label.
- [ ] The exchange is owner-only, symlink-safe, append-only, and atomically published.
- [ ] Every profile keeps its isolated home, notes, and live index.
- [ ] Containers use `/tmp` plus `docker cp`; the four-mount contract is unchanged.
- [ ] One shared helper owns memory policy for sandbox and native launchers.
- [ ] Lifecycle ordering and warning-only failure behavior are contract-tested.
- [ ] `TRELLAGE_MEMORY=off` and both `--no-memory` paths perform no Deja work.
- [ ] Status output contains no memory content.
- [ ] Manual sandbox sync refuses a missing or unsafe current-worktree container clearly.
- [ ] Native sync is serial across installed profiles.
- [ ] Cross-project and cross-mode recall acceptance tests pass.
- [ ] Safe automatic recall remains current-project-only.
- [ ] Imported records are not re-exported.
- [ ] No shared home, index, Docker volume, repository-local exchange, or extra mount exists.
- [ ] Trellage's deterministic full suite passes.
- [ ] Live results, if authorized, are recorded separately.
- [ ] The weavekit integration test and documentation follow-up are complete.
