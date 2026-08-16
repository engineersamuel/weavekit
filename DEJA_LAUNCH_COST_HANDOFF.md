# Handoff: the 12-second `deja` step in every Trellage launch

Written 2026-08-14 from measurements on this machine. Purpose: give you the facts needed to decide
whether to prune, fix, disable, or remove deja.

## Summary

Every Trellage native launch runs `deja-memory prepare` before the harness starts and
`deja-memory finalize` after it exits. Measured today: **15.3 s + 14.2 s = ~29.5 s per session**.

Almost none of that is deja's own work. The `deja` binary does its four jobs in ~1.6 s. The rest is
the bash wrapper `deja-memory`, which **forks one `jq` process per JSON line** to validate the memory
exchange. The exchange holds 2411 lines, and 2411 × 5.0 ms ≈ 12.1 s.

The exchange is never pruned. Its cost grew from ~6.5 s to ~12.1 s in 92 minutes of use today.

## Measurements

### Where the time goes

`deja-memory` operations, `copilot/hve` profile home:

| operation                    | time    |
| ---------------------------- | ------- |
| `status`                     | 0.19 s  |
| `prepare` (1st)              | 15.30 s |
| `prepare` (2nd, nothing new) | 15.28 s |
| `finalize`                   | 14.19 s |

The `deja` binary sub-commands that `prepare`/`finalize` actually call:

| sub-command                      | time   |
| -------------------------------- | ------ |
| `deja sync import <stage>`       | 0.05 s |
| `deja index`                     | 1.41 s |
| `deja install --auto --no-index` | 0.04 s |
| `deja sync export <stage>`       | 0.14 s |

So ~13.7 s of a 15.3 s `prepare` is wrapper overhead, not deja.

### Cause

`/Users/smendenh/.local/share/trellage/deja/deja-memory`:

- `collect_valid_batches()` (line 252) calls `validate_jsonl()` on every batch file in the exchange.
- `validate_jsonl()` (line 204) reads the file line by line and calls `json_line_is_valid()` per line.
- `json_line_is_valid()` (line 169) pipes that single line into a **new `jq` process**.

Measured fork cost: 200 `jq` invocations = 1.01 s, i.e. **5.0 ms per line**.

Exchange today: 36 files, 4.3 MB, **2411 lines**. 2411 × 5.0 ms = **12.1 s**. This matches the gap
between the 15.3 s wrapper and the 1.6 s of real work.

`finalize` pays it again, plus validation of the export stage, hence ~14 s.

### Growth is unbounded

Nothing removes batches from the exchange:

- `stage_import_batches()` (line 270) hard-links batches into a temp stage with `ln`; the originals stay.
- `publish_batch()` (line 488) only adds, or de-duplicates by SHA-256 digest.

Cumulative lines by file mtime, and the `prepare` cost each level implies at 5.0 ms/line:

```
08:15   1296 lines   ~6.5 s
08:17   1624 lines   ~8.1 s
08:24   1991 lines  ~10.0 s
08:42   2159 lines  ~10.8 s
09:07   2403 lines  ~12.0 s
09:47   2411 lines  ~12.1 s
```

That is **about +3.6 s of launch cost per hour of use**, and it does not come back down.

### Blast radius

Launchers that run the deja wrapper: `cpx`, `cldx`, `grx`, `jcx`, `omp`, `prx`. `trx` does not.

All six honour `TRELLAGE_MEMORY=off`, which makes `run_with_deja` `exec` the harness immediately
(`cpx` lines 67-119; `grx` uses the POSIX `[ "$memory_mode" = off ]` form).

A `prepare` failure is **not** fatal — the launcher prints
`Deja prepare failed; continuing without synchronized memory` and starts the harness anyway.

## Why this matters to weavekit/rlm

Each `invoke_trellage` call is a fresh launch, so it pays the full ~29.5 s. With
`DEFAULT_TRELLAGE_MAX_CONCURRENT = 2`, a multi-call run pays it repeatedly.

This window is also what exposed the `copilot/hve` adoption bug: during the ~12 s when only the
launcher is running, Herdr reports a fallback-classified `copilot`/`idle` agent that cannot accept
input. That bug is fixed (`src/rlm-poc/trellage/herdrBackend.ts`, `waitForActiveAgent`), so RLM is
now correct regardless of how long the pre-harness step takes. **The 12 s is now a latency problem
only, not a correctness problem.**

## Options

| #   | Action                                                                                  | Saves                     | Keeps                                    | Cost                                                        |
| --- | --------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| A   | Do nothing                                                                              | 0                         | everything                               | grows ~3.6 s/hour, forever                                  |
| B   | Batch the validation in `deja-memory` (one `jq`/`python3` pass instead of one per line) | ~12 s of 15.3 s           | everything                               | edit to Trellage-owned script; likely upstream fix          |
| C   | Prune the exchange                                                                      | proportional              | everything                               | need to know what is safe to delete                         |
| D   | `TRELLAGE_MEMORY=off`                                                                   | ~29.5 s                   | local index and recall already installed | no cross-profile memory sync                                |
| E   | Remove deja completely                                                                  | ~29.5 s + recall overhead | nothing                                  | loses recall, `/deja`, `deja-history` skill, session search |

B is the real fix: the validation is O(lines) process forks where one pass would do. It changes no
behaviour. It is not weavekit code — it lives in
`/Users/smendenh/.local/share/trellage/deja/deja-memory`, rewritten Aug 14 08:13.

C is the immediate mitigation and needs no code change.

D is a clean, supported switch if you want the cost gone today. Note it also stops `deja index` and
`deja install --auto` from running at launch, so see open question 1.

## Open questions to investigate

1. **Does recall survive `TRELLAGE_MEMORY=off`?** `deja install --auto` installs the recall hooks and
   the `deja-history` skill into each isolated profile home, and it runs **only inside `prepare`**.
   Existing profiles keep what was installed at their last launch, but the index stops refreshing at
   launch and new profiles never get set up. Test before you rely on it.
2. **Is anything meant to prune the exchange?** Nothing in `deja-memory` does. Check whether deja
   itself, a Trellage update step, or a cron is supposed to.
3. **Why does `finalize` cost ~14 s at exit?** It re-validates the whole exchange before exporting,
   and `publish_batch` validates each destination file a second time.
4. **Is the re-import doing useful work?** `deja sync import` on 4.3 MB of already-imported batches
   takes 0.05 s, which suggests it is mostly a no-op after the first run. If so, the 12 s of
   validation guards a step that does nothing on most launches.
5. **Value side.** Measure how often recall changes an outcome before removing it. Deja's own
   `deja view` and `deja friction` can show usage.

## Reproduction

Time the wrapper against a profile home:

```bash
H=~/.local/share/trellage/deja/deja-memory
PH=~/.local/share/trellage/profiles/copilot/hve/home
time env TRELLAGE_MEMORY=deja DEJA_RECALL=safe TRELLAGE_REAL_HOME=$HOME HOME=$PH "$H" prepare
```

Time the binary's real work:

```bash
DB=~/.local/share/trellage/deja/0.17.0/darwin_arm64/deja
STAGE=$(mktemp -d)
time env TRELLAGE_REAL_HOME=$HOME HOME=$PH "$DB" index
```

Size the exchange and project the cost:

```bash
cat ~/.local/state/trellage/deja/exchange/*.jsonl | wc -l   # × 5.0 ms = prepare overhead
du -sh ~/.local/state/trellage/deja/exchange
```

Confirm the off switch:

```bash
time env TRELLAGE_MEMORY=off cpx hve   # should reach the harness with no deja delay
```

## Key paths

- Wrapper: `/Users/smendenh/.local/share/trellage/deja/deja-memory` (687 lines of bash, v0.17.0)
- Binary: `/Users/smendenh/.local/share/trellage/deja/0.17.0/darwin_arm64/deja` (10.8 MB)
- Exchange: `~/.local/state/trellage/deja/exchange/` (36 files, 4.3 MB, 2411 lines)
- Per-profile index: `<profile home>/.cache/deja/index.db/` (5.5 MB for `copilot/hve`)
- Launcher integration: `/Users/smendenh/.local/share/trellage/cpx/bin/cpx` lines 52 (`run_deja_helper`),
  67 (`run_with_deja`), 83 (`prepare`), 113 (`finalize`)
