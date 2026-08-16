# RLM POC Herdr removal handoff

## Outcome

Production `rlm-poc` Trellage delegation no longer creates or drives Herdr
workspaces, panes, or agents.

Delegation now uses:

- direct Git worktrees for isolation;
- direct child-process execution;
- structured JSONL adapters;
- bounded timeout, cancellation, and process-group cleanup.

## Main changes

### Direct worktree provisioning

`src/rlm-poc/trellage/integration.ts` constructs
`TrellageWorktreeRegistry` with:

```ts
direct: true;
```

`src/rlm-poc/trellage/worktrees.ts` then uses
`provisionNativeTrellageWorktree`, which runs:

```bash
git worktree add --no-checkout -b <branch> <path> HEAD
git checkout <branch>
```

Unchanged, empty worktrees are reclaimed with:

```bash
git worktree remove --force <path>
git branch --delete --force <branch>
```

No `herdr worktree`, pane, or agent command is used by the production headless
path.

### Direct process execution

`src/rlm-poc/trellage/headlessRunner.ts` replaces terminal driving with
`spawn(command, argv)`:

- no shell;
- no PTY;
- stdin ignored;
- stdout and stderr captured separately;
- detached Unix process group;
- `SIGTERM`, then bounded `SIGKILL`;
- explicit timeout and cancellation results.

`src/rlm-poc/trellage/headlessLoop.ts` owns command construction, attempts,
question parsing, root-grounded answers, same-session resume, budget charging,
and terminal diagnosis.

## Verification

Regression coverage in `tests/rlm-poc/trellage/worktrees.test.ts` proves direct
provisioning issues Git commands and no `herdr` command.

Live validation showed worktrees under direct sibling paths such as:

```text
/Users/smendenh/projects/weavekit-rlm-*
```

They were reclaimed after runs with no changes. No Herdr panes or agents were
created.

The focused Trellage suite passed:

```text
12 test files
117 tests
```

Typecheck, oxlint, and formatting also passed.

## Important boundary

Herdr has not been deleted from every source file.

The old PTY/control implementation and compatibility types remain for
comparison and possible current-worktree reuse. `worktrees.ts` still supports a
non-production `direct: false` branch, and legacy tests still cover it.

The production RLM integration always sets `direct: true`, so those paths are
not used during normal headless delegation.

## Optional final cleanup

After all required native and container profiles pass headless contract tests:

1. delete the legacy PTY drive loop and Herdr backend;
2. remove the `direct: false` worktree branch;
3. replace remaining Herdr-derived worktree types with RLM-owned types;
4. remove Herdr-specific tests and imports;
5. rerun the full profile comparison before deleting the control path.
