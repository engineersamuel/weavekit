# Proof: Trellage works through direct exec without Herdr

## Claim

Trellage native harnesses and Trellage sandbox containers can be launched,
observed, and resumed through normal operating-system child processes.

They do not require:

- a Herdr workspace;
- a Herdr pane;
- a Herdr agent;
- terminal screen scraping;
- a PTY.

Herdr can still be used as an optional interactive user interface, but it is not
an execution dependency.

## What "direct exec" means

The RLM process runner starts an executable with an argument array:

```ts
spawn(command, args, {
  cwd,
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
});
```

The runner:

- does not use a shell;
- does not allocate a PTY;
- captures stdout and stderr separately;
- reads structured JSON or JSONL;
- sends `SIGTERM`, then bounded `SIGKILL`, on timeout or cancellation;
- resumes sessions by starting another process with the saved session ID.

This is implemented in:

```text
src/rlm-poc/trellage/headlessRunner.ts
src/rlm-poc/trellage/headlessLoop.ts
```

## Native harness proof

### Claude Code through `cldx`

Direct command shape:

```bash
cldx <profile> \
  -p "<prompt>" \
  --output-format stream-json \
  --verbose \
  --permission-mode bypassPermissions \
  --disallowedTools AskUserQuestion
```

Observed behavior:

- structured stream JSON;
- authoritative session ID;
- terminal result;
- question-envelope output;
- exact same-session resume;
- multi-question clarification completed successfully.

Evidence:

```text
/Users/smendenh/.copilot/session-state/0310a5f7-d334-4189-a031-75456e0713ea/files/rlm-live-claude-multi-question.log
```

### Copilot CLI through `cpx`

Direct command shape:

```bash
cpx <profile> \
  -p "<prompt>" \
  --output-format json \
  --allow-all \
  --no-ask-user
```

Observed behavior:

- structured JSON events;
- session ID capture;
- question-envelope extraction;
- root-grounded answer;
- same-session resume;
- completed final result.

Evidence:

```text
/Users/smendenh/.copilot/session-state/0310a5f7-d334-4189-a031-75456e0713ea/files/rlm-live-single-question-final.log
```

### Oh My Pi through `omp copilot`

Direct command shape:

```bash
omp copilot \
  -p "<prompt>" \
  --mode=json \
  --approval-mode=yolo
```

Resume shape:

```bash
omp copilot \
  --resume=<session-id> \
  -p "<continuation>" \
  --mode=json \
  --approval-mode=yolo
```

Live validation:

1. OMP asked `What is my favorite color?`.
2. The root RLM answered exactly `RED`.
3. OMP resumed the same session.
4. OMP returned exactly `RED`.
5. The result reported `turns: 2` and `outcome: completed`.

Evidence:

```text
/Users/smendenh/.copilot/session-state/0310a5f7-d334-4189-a031-75456e0713ea/files/rlm-live-omp-red-fixed.log
/Users/smendenh/.copilot/session-state/0310a5f7-d334-4189-a031-75456e0713ea/files/omp-copilot-question.jsonl
/Users/smendenh/.copilot/session-state/0310a5f7-d334-4189-a031-75456e0713ea/files/omp-copilot-question-resume.jsonl
```

## Trellage container proof

Profile:

```text
claude-social-media
```

Initial direct command:

```bash
trellage --profile claude-social-media \
  --output-format jsonl \
  --prompt "<question prompt>"
```

Observed initial result:

- no TTY;
- Claude stream JSON;
- exact question envelope;
- session ID `ae844449-15a0-4475-9af7-08add4b5220b`.

Direct resume command:

```bash
trellage --profile claude-social-media \
  resume ae844449-15a0-4475-9af7-08add4b5220b \
  --output-format jsonl \
  --prompt "<answer RED and continue>"
```

Observed resume result:

- no TTY;
- same session ID;
- zero non-JSON lines in resume stdout;
- final result exactly `RED`;
- exit status `0`.

Evidence:

```text
/Users/smendenh/.copilot/session-state/0310a5f7-d334-4189-a031-75456e0713ea/files/trellage-claude-social-jsonl-question.jsonl
/Users/smendenh/.copilot/session-state/0310a5f7-d334-4189-a031-75456e0713ea/files/trellage-claude-social-jsonl-resume.jsonl
```

This proves that Docker isolation, persistent container state, session resume,
and structured harness output do not depend on Herdr.

## Worktree isolation without Herdr

RLM creates sibling Git worktrees directly:

```bash
git worktree add --no-checkout -b <branch> <path> HEAD
git checkout <branch>
```

It removes unchanged worktrees directly:

```bash
git worktree remove --force <path>
git branch --delete --force <branch>
```

Production integration always enables this direct path. Tests assert that no
`herdr` command is issued.

Relevant files:

```text
src/rlm-poc/trellage/integration.ts
src/rlm-poc/trellage/worktrees.ts
tests/rlm-poc/trellage/worktrees.test.ts
```

## Deterministic verification

The focused Trellage suite passed:

```text
12 test files
117 tests
```

Additional checks passed:

```text
tsc --noEmit
oxlint --deny-warnings .
oxfmt --check
```

The process-runner test also proves that a launcher which ignores `SIGTERM` is
terminated without a pane or terminal.

## Remaining issue is not a Herdr dependency

On a cold `claude-social-media` launch, automatic image rebuilding wrote 33
human build-progress lines to stdout before the valid JSONL events.

This is a stdout-routing defect in Trellage's automatic build path. It does not
require Herdr to solve. The fix is to route lifecycle and build output to
stderr when `--output-format jsonl` is active.

Handoff:

```text
TRELLAGE_JSONL_STDOUT_CONTAMINATION_HANDOFF.md
```

## Conclusion

The live evidence proves:

| Capability                    | Native harnesses | Trellage container |
| ----------------------------- | ---------------- | ------------------ |
| Direct child-process launch   | Yes              | Yes                |
| No PTY                        | Yes              | Yes                |
| Structured output             | Yes              | Yes                |
| Session ID capture            | Yes              | Yes                |
| Same-session resume           | Yes              | Yes                |
| Question and root answer flow | Yes              | Yes                |
| Exact final `RED` result      | Yes              | Yes                |
| Herdr required                | No               | No                 |

Herdr is an optional interactive orchestration surface. Direct exec, structured
events, direct Git worktrees, and native session resume are sufficient for the
RLM workflow.
