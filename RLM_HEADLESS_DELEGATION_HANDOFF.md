# RLM headless delegation handoff — drop the pane, drop Herdr

Date: 2026-08-14
Status: proposed, not implemented
Owner: RLM-POC (`src/rlm-poc/trellage/`)
Related: [ADR 0010](docs/adr/0010-recursive-llm-tool-rlm.md),
[ADR 0011](docs/adr/0011-invoke-trellage.md),
`TRELLAGE_PROFILE_VALIDATION_HANDOFF.md`, `TRELLAGE_REMAINING_ISSUES_HANDOFF.md`,
`TRELLAGE_REVERIFICATION_RESPONSE.md`, `RLM_D0_CAPABILITY_HANDOFF.md`

---

## 1. Decision

Stop driving delegated harnesses through a Herdr-owned PTY. Run them headless
with `execFile` and `-p`, and read their structured JSON output.

Delete the drive loop, the screen classifier, and the Herdr backend. Keep the
worktree isolation, the catalog, the budget accounting, and the Langfuse spans.

Result: about **1,986 lines** removed, six of seven failure classes removed, and
new telemetry that the PTY path cannot produce at all.

---

## 2. The claim this overturns

`docs/adr/0011-invoke-trellage.md` states:

> Container mode **cannot** be driven by pipes or `execFile` at all. Only the
> non-interactive subcommands (`list`, `validate`, `lock`, `build`, `upgrade`,
> `ci-verify`) run headless.

This is wrong. The `trellage` launcher exempts prompt mode from its own TTY
assert. `/Users/smendenh/.local/bin/trellage`, lines 722-725:

```sh
if [[ "$mode" != prompt && "$mode" != stop && "$mode" != doctor && "$mode" != destroy \
  && "$mode" != memory-status && "$mode" != memory-sync ]]; then
  [[ -t 0 && -t 1 ]] || fail 'an interactive terminal is required'
fi
```

`trellage --profile X --prompt "..."` is headless-legal. So is every native
launcher. ADR 0010's original judgement — that Trellage is "headless-feasible
only in one-shot `-p` mode" — was correct. ADR 0011 overturned it on a false
premise.

---

## 3. Evidence log

Everything below was run on this machine on 2026-08-14. Commands and outputs are
verbatim.

### 3.1 Claude Code headless, streaming

```sh
cldx -p "Reply with exactly: A" --output-format stream-json --verbose
```

Emits a `system/init` event, then assistant events, then one terminal `result`
event:

```json
{
  "is_error": false,
  "subtype": "success",
  "result": "A",
  "session_id": "cd2b91f5-8484-4cf2-9454-2b258b73de28",
  "num_turns": 1,
  "duration_ms": 2204,
  "duration_api_ms": 1405,
  "ttft_ms": 1451,
  "total_cost_usd": 0.27919374999999996,
  "usage": { "input_tokens": 1240, "output_tokens": 3, "cache_creation_input_tokens": 43667 },
  "permission_denials": [],
  "terminal_reason": "completed",
  "type": "result"
}
```

The `system/init` event carries `cwd`, `session_id`, `tools[]`, `mcp_servers[]`,
`model`, `permissionMode`, `skills[]`, `agents[]`, `claude_code_version`.

### 3.2 Claude Code has no ask-user channel headless

The `tools[]` array from that same `init` event:

```
Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree,
ExitWorktree, ListAgents, ListMcpResourcesTool, Monitor, NotebookEdit,
PushNotification, Read, ReadMcpResourceDirTool, ReadMcpResourceTool,
ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskCreate, TaskGet,
TaskList, TaskOutput, TaskStop, TaskUpdate, WebFetch, WebSearch, Workflow,
Write, mcp__deja__*
```

**`AskUserQuestion` is absent.** Claude Code cannot ask a question in `-p` mode.
`permissionMode` was `bypassPermissions`, set by the `cldx` wrapper.

### 3.3 Claude Code headless resume

```sh
cldx -p "What letter did you just reply with? Answer with only that letter." \
     --resume cd2b91f5-8484-4cf2-9454-2b258b73de28 --output-format json
```

Returns `"result":"A"`. **The conversation carried. Headless is multi-turn.**

### 3.4 Copilot CLI headless, and its ask-user behaviour

```sh
cpx awesome -p "Use the ask_user tool to ask me: what is my favorite color? \
Then reply with the answer." --allow-all-tools --output-format json
```

The agent replied, verbatim:

> I don't have an "ask_user" tool available, and since I'm running
> non-interactively, I can't pause to ask you a question and wait for a reply.
> There's no way for me to learn your favorite color through this session.

It then called a `task_complete` tool and exited `0`:

```json
{"type":"session.task_complete","data":{
  "summary":"No `ask_user` tool exists in my available toolset, and this session
  runs non-interactively (autopilot mode), so I cannot pause and wait for you to
  answer a question. ...","success":true}}
```

```json
{
  "type": "result",
  "sessionId": "538549e0-25f8-421e-b876-3224fa84efc2",
  "exitCode": 0,
  "usage": {
    "premiumRequests": 1,
    "totalApiDurationMs": 3570,
    "sessionDurationMs": 4556,
    "codeChanges": { "linesAdded": 0, "linesRemoved": 0, "filesModified": [] }
  }
}
```

**Read `"success": true` carefully.** The turn completed. The goal did not. See
section 6.3 — this is the single most important detail in this document.

### 3.5 Copilot CLI headless resume

```sh
cpx awesome --resume 538549e0-25f8-421e-b876-3224fa84efc2 \
    -p "My favorite color is teal. Now reply with only my favorite color." \
    --allow-all-tools --output-format json
```

Returns `"summary":"Teal"`, same `sessionId`, `premiumRequests` now `2`.
**The conversation carried.**

### 3.6 Event types emitted by Copilot CLI

```
assistant.tool_call_delta, assistant.message, assistant.reasoning,
tool.execution_start, tool.execution_complete, session.task_complete,
assistant.turn_end, session.usage_checkpoint, assistant.idle, result
```

### 3.7 Container mode is blocked by a Trellage defect, not by headless mode

Reproduced twice earlier (profiles `claude-frontend-design`, `prime-agent`):
a successful image build is immediately followed by

```
trellage: profile image remains missing or stale after automatic build
```

Source: `/Users/smendenh/.local/bin/trellage` line 2293. The check is
mode-independent, so interactive launches hit it too. Headless does not fix it
and does not cause it. **Trellage must fix this.** Tracked in
`TRELLAGE_REMAINING_ISSUES_HANDOFF.md`.

---

## 4. What is wrong with the current path

### 4.1 Ten steps before the delegate sees the task

| #   | Step                                                       | Code                                                     | Observed failure class |
| --- | ---------------------------------------------------------- | -------------------------------------------------------- | ---------------------- |
| 1   | Herdr creates a pane                                       | `herdrBackend.ts:43` `scoped.createTab()`                | —                      |
| 2   | **Types** the command as keystrokes                        | `herdrBackend.ts:53` `scoped.launch({interactive:true})` | —                      |
| 3   | Polls up to 300 s for Herdr to classify an agent           | `herdrBackend.ts:110` `pollForAdoption`                  | **A** — 4 profiles     |
| 4   | Renames the agent, 10 retries                              | `herdrBackend.ts:177` `renameToScopedName`               | —                      |
| 5   | Sends empty keys until not `agent_not_ready`               | `herdrBackend.ts:143` `waitForActiveAgent`               | **E**                  |
| 6   | Classifies the startup screen, clears dialogs by arrow key | `driveLoop.ts:317` `settleStartup`                       | **B**, **G**           |
| 7   | Writes `task.md`, prompts one short pointer line           | `driveLoop.ts:114`                                       | **D** — composer stuck |
| 8   | Samples 3 identical 500 ms frames                          | `driveLoop.ts:231` `awaitQuiescence`                     | **D**                  |
| 9   | Regex-classifies the TUI as a menu or a question           | `screen.ts:37` `classifyScreen`                          | **C**, **G**           |
| 10  | Polls for `result.md` as the only proof of completion      | `result.ts` `readResult`                                 | —                      |

Failure classes A-G are defined in `TRELLAGE_REMAINING_ISSUES_HANDOFF.md`.

### 4.2 Measured outcome

22 profiles tested through `invoke_trellage`, each asked to reply
`HELLO FROM <profile>`:

- 6 passed — **27 %**
- 1 correctly rejected before launch
- 15 failed — **68 %**

Only 3 failures were genuine harness or environment defects
(`codex-superpowers` curl redirect, `omp/local` and `claude-qwen-local`
unprovisioned Qwen). **The rest were in the driving mechanism.**

### 4.3 The classifier is coupled to TUI cosmetics

`screen.ts:150` `isKnownUiChrome` hardcodes banner text:

```ts
/^copilot v[\d.]+\s+uses ai\.$/iu
/^check for mistakes\.$/iu
/^prefer a visual workspace\?/iu
/^session:\s*\d+\s+aic used$/iu
```

Every harness release can break these. This is unbounded maintenance against
software you do not control.

---

## 5. Proposed architecture

### 5.1 The whole drive loop

```ts
const { stdout } = await execFileAsync(
  "cldx",
  [
    "default",
    "-p",
    task,
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--session-id",
    sessionId,
  ],
  { cwd: worktreePath, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
);
const result = JSON.parse(stdout);
```

Container mode is the same shape:

```ts
execFileAsync("trellage", ["--profile", name, "--prompt", task], { cwd, timeout });
```

### 5.2 Mechanism by mechanism

| Today                                              | Headless                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `result.md` file contract                          | the `result` event's `result` / `summary` field                       |
| `task.md` pointer (composer-collapse workaround)   | `-p "<full task>"` — argv has no composer                             |
| Enter nudge, up to 3 presses                       | deleted — no composer exists                                          |
| Quiescence, 3 frames of 500 ms                     | deleted — process exit is the signal                                  |
| `classifyScreen` + `keysToChoose` on trust dialogs | `--permission-mode bypassPermissions` / `--allow-all-tools` at launch |
| `isLikelyQuestion` regex                           | deleted — see section 6                                               |
| `pollForAdoption`, up to 300 s                     | deleted — you hold the PID                                            |
| Close a Herdr tab to kill                          | `child.kill()` / `AbortSignal`                                        |
| Wall-clock deadline inside the loop                | `execFile`'s own `timeout` option                                     |
| Herdr lifecycle states                             | process exit code                                                     |

### 5.3 New telemetry, free

The PTY path cannot produce any of this:

| Field             | Claude                                      | Copilot                                   | Use                                       |
| ----------------- | ------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| Cost              | `total_cost_usd`                            | `usage.premiumRequests`                   | Per-call cost on the Langfuse span        |
| Outcome           | `is_error`, `subtype`                       | `session.task_complete.success`           | Real success signal                       |
| Blocked tools     | `permission_denials[]`                      | —                                         | Actionable, names the exact tool          |
| Turns             | `num_turns`                                 | `turnId`                                  | Span attribute                            |
| Duration          | `duration_ms`, `duration_api_ms`, `ttft_ms` | `sessionDurationMs`, `totalApiDurationMs` | Span attribute                            |
| Tokens            | `usage`, `modelUsage`                       | `outputTokens`                            | Cost attribution                          |
| **Files changed** | —                                           | `usage.codeChanges.filesModified[]`       | Verify what the delegate actually touched |
| Session           | `session_id`                                | `sessionId`                               | Resume handle                             |

### 5.4 The tool no longer needs Herdr

`src/rlm-poc/trellage/integration.ts:70`:

```ts
if (!isHerdrEnvironment()) return undefined;
```

Delete this gate. `invoke_trellage` becomes usable from any shell, from CI, and
from a cron job.

---

## 6. Question handling — the core design

This is the part that needs the most care. It is also simpler than it looks,
because of one finding.

### 6.1 The finding

**Neither harness can ask a question in headless mode.**

- Claude Code: `AskUserQuestion` is not in the tool list. Verified, section 3.2.
- Copilot CLI: `ask_user` is not in the toolset in `-p` mode. Verified,
  section 3.4, stated by the agent itself.

So the design problem is **not** "detect a question and answer it". There is no
question to detect. The correct framing is:

> The run ends. Work out whether it achieved the goal. If it did not, work out
> what it lacked, supply that, and resume the same session.

This is a better problem. The signal is a structured field, not a terminal
screen.

### 6.2 What we give up, honestly

Today `handleBlocked` catches a TUI question and `createTrellageAnswerer`
(`integration.ts:143`) answers it mid-run.

But look at what that answerer is. It spins a **fresh Copilot session** grounded
in a snapshot of the root conversation, and answers on the root's behalf. It is
an LLM answering an LLM. It is not the operator.

So we lose an in-turn LLM round trip. We do not lose a human decision. And
`--resume` recovers the capability across turns instead of within one.

### 6.3 The trap — `success: true` does not mean the goal was met

From section 3.4:

```json
"success": true,
"summary": "No `ask_user` tool exists ... I'm unable to determine your favorite
            colour without such a tool."
```

The harness reports **"I completed my turn"**, not **"I achieved your goal"**.
Claude behaves the same way: `subtype: "success"` with `is_error: false` on a
turn that gave up.

**Any classifier that trusts the boolean alone is wrong.** This is the single
highest-risk assumption in the migration. Test it first, and test it hardest.

### 6.4 The three tiers

**Tier 1 — front-load. Do this always.**

Put everything the delegate could need into the task brief before launch. This
is already what `task.md` does today. Keep the discipline, drop the file.

Add one explicit instruction to every delegated brief:

> You cannot ask questions. You have no interactive channel. If you lack
> information you need, do not guess and do not stop silently. State exactly what
> you need in your final summary, prefixed with `NEEDS:`, and finish your turn.

This turns an implicit failure into an explicit, greppable one. It costs
nothing.

**Tier 2 — classify, answer, resume. This is the mechanism to build.**

```
delegate(profile, brief, budget):
  sessionId  = uuid()
  attempt    = 1
  history    = []

  loop:
    budget.consume()                       # a resume costs the same as a call
    raw     = run(profile, prompt, sessionId, resume = attempt > 1)
    history.push(raw)
    outcome = classifyStructured(raw)      # exit code + terminal event only

    if outcome is COMPLETED_CLEAN:      return success(raw)
    if outcome is PROCESS_FAILURE:      return failure(outcome, raw)
    if attempt >= maxAttempts:          return failure(TURN_LIMIT, history)

    need = diagnose(raw)                   # reads NEEDS:, then the summary text
    if need is NONE:                    return failure(UNCLASSIFIABLE, history)

    prompt  = orchestratorAnswer(need)     # reuse createTrellageAnswerer as is
    attempt += 1
```

Three properties matter:

1. Each attempt consumes one unit of the **existing shared call budget**. The
   resume loop is a new way to spend money. It must be bounded by the same
   budget that bounds recursion. Do not give it a separate allowance.
2. `classifyStructured` uses **only** the exit code and the terminal event. It
   is pure, deterministic, and fully unit-testable against recorded JSONL.
3. `diagnose` is the only place an LLM is involved. It reads a structured
   summary paragraph. It never reads a terminal screen.

**Tier 3 — bidirectional control protocol. Do not build this yet.**

Claude Code has `--input-format stream-json`, described as "realtime streaming
input", plus `--replay-user-messages` for acknowledgement. This is the channel
the Claude Agent SDK's `canUseTool` callback uses. It would give a genuine
in-turn question channel over stdin, with no PTY.

**I did not verify this.** Copilot CLI has no equivalent flag. Treat Tier 3 as a
future option for Claude only, and only if Tier 2 proves insufficient in
practice.

### 6.5 Classification contract — Claude Code

Read the terminal `result` event.

| Condition                                         | Outcome                                  |
| ------------------------------------------------- | ---------------------------------------- |
| exit `0`, `is_error: false`, `subtype: "success"` | `COMPLETED_CLEAN` — then run `diagnose`  |
| `subtype: "error_max_turns"`                      | `TURN_LIMIT`                             |
| `subtype: "error_during_execution"`               | `HARNESS_ERROR`                          |
| `permission_denials.length > 0`                   | `BLOCKED_ON_PERMISSION` — names the tool |
| exit non-zero                                     | `PROCESS_FAILURE`                        |
| no `result` event before stream end               | `ABNORMAL_END`                           |
| `execFile` timeout fired                          | `TIMEOUT`                                |

Final text is `result.result`.

### 6.6 Classification contract — Copilot CLI

Read the last `session.task_complete` event and the terminal `result` event.

| Condition                                  | Outcome                                      |
| ------------------------------------------ | -------------------------------------------- |
| exit `0`, `task_complete.success: true`    | `COMPLETED_CLEAN` — then run `diagnose`      |
| exit `0`, `task_complete.success: false`   | `SELF_REPORTED_FAILURE` — `summary` says why |
| no `session.task_complete` before `result` | `ABNORMAL_END`                               |
| `result.exitCode` non-zero                 | `PROCESS_FAILURE`                            |
| `execFile` timeout fired                   | `TIMEOUT`                                    |

Final text is `task_complete.summary`, or the last `assistant.message.content`.
Files touched are `result.usage.codeChanges.filesModified[]`.

### 6.7 `diagnose` — the only LLM step

Input: the final text, plus `filesModified` when available.
Output, typed:

```ts
type Diagnosis =
  | { kind: "achieved" }
  | { kind: "needs-information"; need: string }
  | { kind: "blocked"; obstacle: string }
  | { kind: "refused"; reason: string };
```

Rules:

1. If the text contains a `NEEDS:` prefix (Tier 1), take it directly. **Skip the
   LLM call entirely.** This is the cheap path and it should be the common one.
2. Otherwise ask the classifier one question: did this turn achieve the stated
   goal, and if not, what did it lack?
3. `achieved` ends the loop. Everything else feeds `orchestratorAnswer`.

### 6.8 Reuse, do not rewrite, the answerer

`createTrellageAnswerer` in `integration.ts:143` already does the right thing:
it snapshots the root conversation, answers definitively, and prefers letting
the agent proceed. Keep it.

Keep its repeated-question guard too (`findRepeatedQuestion`,
`isReportPermissionQuestion`). That guard exists because of failure class **C** —
`copilot/superpowers` looped on "may I report this?" until the turn limit. The
resume loop can produce the same loop shape. The guard is still needed.

---

## 7. Deletion scope

Measured with `wc -l` on 2026-08-14.

### Delete outright

| File                                          | Lines     |
| --------------------------------------------- | --------- |
| `src/rlm-poc/trellage/driveLoop.ts`           | 465       |
| `src/rlm-poc/trellage/herdrBackend.ts`        | 236       |
| `src/rlm-poc/trellage/screen.ts`              | 165       |
| **Source total**                              | **866**   |
| `tests/rlm-poc/trellage/driveLoop.test.ts`    | 688       |
| `tests/rlm-poc/trellage/screen.test.ts`       | 230       |
| `tests/rlm-poc/trellage/herdrBackend.test.ts` | 202       |
| **Test total**                                | **1,120** |
| **Combined**                                  | **1,986** |

### Shrink

- `src/rlm-poc/trellage/backend.ts` (55) — the `TrellageBackend` PTY seam
  becomes a small process-runner seam. **Keep the seam.** It is what makes the
  swap contained and the new path testable without spawning real harnesses.
- `src/rlm-poc/trellage/result.ts` (118) — the `result.md` contract is replaced
  by the terminal event. Keep only `toSingleLine` if still used.
- `src/rlm-poc/trellage/tool.ts` (360) — drops its Herdr import; core logic
  stays.
- `src/rlm-poc/trellage/integration.ts` (330) — drops the `isHerdrEnvironment`
  gate; the answerer stays.

### Add

- A per-harness result adapter. Two shapes today (Claude, Copilot). This is real
  new code, but it is pure parsing of a versioned JSON contract, not regex
  against a repainting TUI.

### Keep untouched

- `src/rlm-poc/trellage/catalog.ts` (251) — already uses `execFile`. It never
  needed a PTY.
- `src/rlm-poc/trellage/worktrees.ts` (228) — worktree isolation is orthogonal.
- `src/rlm-poc/trellage/contracts.ts` (271), `telemetry.ts` (72).
- `src/herdr/provision.ts` (371) — still used for worktree provisioning.
- `src/herdr/scope.ts` (482), `socket.ts` (377), `client.ts` (90) — **not
  deleted.** `src/submind-poc/` still uses them. Herdr keeps the job ADR 0010
  gave it: human-attachable, multi-turn `mastermind-submind` sessions.

---

## 8. Test plan

The operator's requirement: _"this needs to be well tested through."_ The
headless path is far more testable than the PTY path, because the input is a
recorded JSON stream instead of a live terminal.

### 8.1 Fixtures — do this first

Capture real JSONL from every launcher and commit it under
`tests/rlm-poc/trellage/fixtures/headless/`. One file per scenario, per harness.

Capture with:

```sh
cldx -p "<prompt>" --output-format stream-json --verbose > fixture.jsonl
cpx <profile> -p "<prompt>" --allow-all-tools --output-format json > fixture.jsonl
```

This replaces the recorded-screen fixtures the current `screen.test.ts` uses.

### 8.2 Unit — `classifyStructured`, pure

Deterministic. No network. No process spawn. One test per row of the tables in
sections 6.5 and 6.6.

Must cover:

- clean success, both harnesses
- `error_max_turns`
- `error_during_execution`
- non-empty `permission_denials`
- non-zero exit code
- missing terminal event (truncated stream)
- **malformed JSON on one line** — must not throw; skip the line and continue
- **no output at all**
- interleaved stderr in the stream

### 8.3 Unit — `diagnose`, the highest-risk component

**The `success: true` trap from section 6.3 is the priority test.**

Use the verbatim Copilot fixture from section 3.4: `success: true` with a
summary that says the goal was not achieved. Assert the diagnosis is
`needs-information`, **not** `achieved`.

Then cover:

| Fixture                                                          | Expected                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `NEEDS: the database connection string`                          | `needs-information`, need extracted, **no LLM call**          |
| `success: true`, summary says goal met                           | `achieved`                                                    |
| `success: true`, summary says "I could not find X"               | `needs-information`                                           |
| `success: true`, summary says "I chose not to do this because Y" | `refused`                                                     |
| `success: false` with a summary                                  | `blocked`                                                     |
| Empty summary                                                    | `blocked`, obstacle = "no summary produced"                   |
| Summary is only a file path                                      | `achieved` if the file exists in the worktree, else `blocked` |

Assert the `NEEDS:` path makes **zero** model calls. That is a cost regression
test, not only a correctness test.

### 8.4 Unit — the resume loop

With a fake runner, assert:

- Resume passes the **same** `sessionId`.
- Attempt 1 does not pass `--resume`; attempt 2 onwards does.
- Every attempt consumes exactly one budget unit.
- The loop stops at `maxAttempts` and reports `TURN_LIMIT`.
- The loop stops immediately on `PROCESS_FAILURE`, and does not resume.
- The repeated-question guard fires when two consecutive diagnoses match.
- Every attempt's raw output is retained in `history` for the failure report.

### 8.5 Contract tests — live, one per launcher

These catch harness upgrades. Run them on demand, not on every commit.

For each of `cldx`, `cpx`, `cdx`, `grx`, `jcx`, `prx`, `omp`, and
`trellage --profile`:

1. `-p "Reply with exactly: HELLO FROM <launcher>"` returns that string.
2. The output parses as the expected event shape.
3. A terminal event exists.
4. `--resume` with the returned session ID carries context.
5. Exit code is `0`.

**Status today:** `cldx` and `cpx` pass 1-5, verified. The other five are
**unverified**. `trellage --profile` is blocked by the image defect in
section 3.7.

### 8.6 Integration

- One real delegation completes and returns its text.
- One real delegation that lacks information resumes once and then completes.
  Construct it deterministically: give a task that needs a value that is not in
  the brief, and hold that value in the root conversation snapshot.
- A delegation that writes files reports them in `filesModified`, and those
  files exist in the worktree.
- Timeout: give a 2 s timeout to a task that takes longer; assert `TIMEOUT` and
  assert the child process is dead.
- Cancellation: abort mid-run; assert no orphan process remains.

### 8.7 Regression

- All Langfuse spans still nest under `SUBMIND d0 · <mode>`.
- Depth and budget accounting unchanged.
- Worktree provisioning and finalisation unchanged.
- Baseline suite: **219 of 220 passing**. The known failure is
  `tests/rlm-poc/runtime.test.ts:338`, which asserts `gemini-3.6-flash` while
  the live catalog serves `gemini-3.7-flash`. Unrelated to this work.

### 8.8 Re-run the profile validation

Re-run the 22-profile sweep from `TRELLAGE_PROFILE_VALIDATION_HANDOFF.md`
through the headless path and compare.

**Prediction to check honestly:** failure classes A, B, C, D, E, G disappear,
because all six are in the driving mechanism. Class F (repo-context role
confusion) stays — it is a prompt problem. The three genuine harness defects
stay. If the pass rate does not move well above 27 %, this migration has not
delivered and the result must be reported as such.

---

## 9. Migration phases

Each phase leaves the tree green and shippable.

1. **Add the runner behind the seam.** New `execFile` runner implementing a
   process-runner interface. Do not delete anything. Put it behind a flag.
2. **Add the adapters and the classifier.** Fixtures first, then
   `classifyStructured`, then `diagnose`. All unit-tested, nothing wired.
3. **Wire the resume loop.** Budget accounting included from the start.
4. **Switch the default** from the Herdr backend to the headless runner.
5. **Re-run the 22-profile sweep.** Compare against section 8.8. Report the real
   number.
6. **Delete** `driveLoop.ts`, `screen.ts`, `herdrBackend.ts` and their tests.
   Only after phase 5 shows the improvement.
7. **Amend ADR 0011.** Correct the false premise in section 2, and record the
   headless design.

Do not delete before phase 5. The old path is the control group.

---

## 10. Risks and unknowns

### Verified — no risk

- Claude headless one-shot, streaming, and resume.
- Copilot headless one-shot and resume.
- Neither harness has an ask-user channel headless.
- `trellage --prompt` is exempt from the TTY assert (code read).

### Unverified — resolve before relying on them

| Item                                                 | Impact if wrong                                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `cdx`, `grx`, `jcx`, `prx`, `omp` headless behaviour | Those profiles stay broken. Five contract tests will tell you.                                             |
| `trellage --profile X --prompt` end to end           | All container profiles stay blocked. Blocked by the Trellage image defect, not by us.                      |
| Claude `--input-format stream-json` control protocol | Only affects Tier 3, which is deferred.                                                                    |
| Claude `--json-schema` structured output             | Would let a delegate return a typed `RlmWorkerReport` directly. A large win if true. Worth one experiment. |
| Claude `--max-budget-usd`                            | Would give a hard dollar cap per delegated call. Worth one experiment.                                     |

### Real risks

| Risk                                                             | Mitigation                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **`success: true` on an unachieved goal** — the section 6.3 trap | Highest-priority test, 8.3. Never trust the boolean alone.                                                                                     |
| Each harness has a different result shape                        | One adapter each. Far less code than screen classification, but not zero. Contract tests pin each shape.                                       |
| A harness upgrade changes its JSON                               | Contract tests, 8.5. This is a versioned contract, unlike TUI cosmetics.                                                                       |
| `ARG_MAX` — a long brief may exceed the argv limit               | Two candidate fixes, **both unverified**: pipe the brief on stdin, or keep a `task.md` pointer for oversized briefs. Test with a 200 KB brief. |
| Output exceeds `maxBuffer` and `execFile` throws                 | Set `maxBuffer` to 64 MB, and stream to a file for `stream-json`.                                                                              |
| Orphan processes on cancel                                       | Explicit `child.kill()` on abort, plus test 8.6.                                                                                               |
| Losing the operator's ability to attach and steer                | Accepted, deliberately. See section 11.                                                                                                        |

---

## 11. What we deliberately give up

The one capability lost is **typing into a running turn**.

Watching is **not** lost. `--output-format stream-json` emits every assistant
message and tool call as it happens. Tail the file, or attach a monitor.

| Capability                   | PTY              | Headless + stream-json               |
| ---------------------------- | ---------------- | ------------------------------------ |
| See progress live            | yes              | **yes**                              |
| Read the final result        | scrape a screen  | structured field                     |
| Know if it failed            | guess            | `is_error` / `success`               |
| Know the cost                | no               | `total_cost_usd` / `premiumRequests` |
| Know which files changed     | no               | `codeChanges.filesModified`          |
| Send a follow-up turn        | type in the pane | `--resume`                           |
| **Type into a running turn** | **yes**          | **no**                               |

When you genuinely need to steer one run, launch that one profile in a terminal
by hand. The orchestrator does not need to own a PTY so that you can
occasionally rescue a run.

Herdr keeps the job ADR 0010 scoped for it: human-attachable, multi-turn
sessions in `mastermind-submind`.

---

## 12. Acceptance criteria

- [ ] Fixtures captured for every reachable launcher.
- [ ] `classifyStructured` pure and fully unit-tested, both harnesses.
- [ ] `diagnose` passes the `success: true` trap test with the verbatim
      section 3.4 fixture.
- [ ] `NEEDS:` path makes zero model calls.
- [ ] Resume loop consumes the shared call budget, one unit per attempt.
- [ ] Contract tests pass for `cldx` and `cpx`; the other five are run and their
      real status recorded.
- [ ] 22-profile sweep re-run, pass rate reported honestly against the 27 %
      baseline.
- [ ] `driveLoop.ts`, `screen.ts`, `herdrBackend.ts` and their tests deleted.
- [ ] `isHerdrEnvironment` gate removed from `integration.ts`.
- [ ] `src/rlm-poc/` no longer imports `src/herdr/scope.ts` or
      `src/herdr/socket.ts`.
- [ ] ADR 0011 amended, with the false premise corrected.
- [ ] Suite at or above the 219/220 baseline.
