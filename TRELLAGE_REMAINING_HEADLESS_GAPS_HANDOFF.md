# Trellage remaining headless gaps handoff

## Scope

This handoff contains only gaps that can be fixed in the Trellage repository.

It excludes Weavekit/RLM work such as:

- RLM profile selection and feature gates;
- RLM JSONL parser policy;
- RLM process buffering and UTF-8 decoding;
- RLM worktree behavior;
- RLM timeout values;
- RLM documentation updates.

## Current status

Trellage commit `2b35397` added non-interactive container resume and JSONL
output. Commit `fd0fbb6` then isolated lifecycle, image-build, and GitHub
authentication output from JSONL stdout.

Claude container validation now proves:

- non-TTY initial prompt;
- native Claude stream JSON;
- authoritative session ID;
- non-TTY resume with a prompt;
- exact same-session continuation;
- exact final result `RED`.

The remaining Trellage gaps concern capability correctness and portable
orchestration contracts across other native and container harnesses.

## Gap 1: JSONL and resume flags are not capability-checked

### Problem

The Trellage host CLI accepts:

```bash
--output-format jsonl
resume <session-id> --prompt <continuation>
```

for agent launches without first checking whether the selected harness runtime
implements those features.

The Claude runtime implements:

- `TRELLAGE_OUTPUT_FORMAT=jsonl`;
- Claude `--output-format stream-json --verbose`;
- `resume-prompt`;
- exact native `--resume <session-id>`.

The current Copilot, Pi/OMP, and Prime container runtime entry scripts do not
expose equivalent `jsonl` or `resume-prompt` handling. The generic Codex
runtime also needs explicit verification.

This creates a false portable contract: the host parser accepts the command,
but the selected runtime can reject it, ignore JSONL mode, or return
unstructured output.

### Required fix

Add runtime capability declarations to compiled profile metadata. At minimum:

```json
{
  "headless": {
    "prompt": true,
    "outputFormats": ["text", "jsonl"],
    "sessionId": true,
    "resume": true,
    "resumeWithPrompt": true
  }
}
```

Before container creation or mutation, the host launcher must fail closed when
the requested feature is unsupported:

```text
trellage: profile <name> does not support JSONL output
trellage: profile <name> does not support non-interactive resume with prompt
```

Do not silently downgrade JSONL to text and do not start an interactive resume.

### Implementation options

1. **Short term:** declare Claude container runtimes as the only runtimes with
   JSONL and resume-with-prompt support.
2. **Long term:** add explicit adapters for Codex, Copilot, Pi/OMP, and Prime.
3. Keep capability declarations near each runtime adapter, not in a
   profile-name allowlist.

### Acceptance criteria

- Unsupported profile requests fail before Docker launch.
- Failure output goes to stderr.
- Exit status is non-zero.
- Stdout is empty for rejected JSONL requests.
- Supported Claude behavior remains unchanged.

## Gap 2: Public inventories do not publish headless capabilities

### Problem

`trellage list --json` currently returns only:

```json
{
  "name": "...",
  "description": "...",
  "sandbox": true
}
```

`trx list --json` provides launcher, harness, description, sandbox status, and
Herdr compatibility, but no machine-readable headless execution contract.

Consumers must hard-code assumptions about:

- structured output;
- JSON or JSONL format;
- session ID availability;
- same-session resume;
- resume with a prompt;
- question-tool control;
- changed-file evidence;
- usage and cost data;
- model and effort override support.

Those assumptions drift when a launcher or harness version changes.

### Required fix

Add a versioned capability object to the full Trellage and TRX inventories.
Keep existing schema fields compatible.

Recommended shape:

```json
{
  "headless": {
    "prompt": true,
    "outputFormats": ["jsonl"],
    "eventContract": "claude-stream-json-v1",
    "sessionId": "native",
    "resume": true,
    "resumeWithPrompt": true,
    "questionToolControl": "hard-deny",
    "changedFiles": "none",
    "usage": true,
    "cost": true,
    "modelOverride": true,
    "effortOverride": false
  }
}
```

Use explicit values instead of ambiguous booleans where the enforcement level
matters:

```text
questionToolControl:
  hard-deny
  prompt-only
  none

changedFiles:
  native
  git-diff
  none

sessionId:
  native
  trellage
  none
```

### Source of truth

- Container capabilities should come from the compiled runtime adapter.
- Native capabilities should come from each owned launcher catalog.
- `trx` should merge and expose the launcher declarations without inferring
  them from launcher names.
- Inventory must not report a capability until a contract test proves it.

### Acceptance criteria

- `trellage list --json --full` exposes container headless capabilities.
- `trx list --json` exposes native headless capabilities.
- Capability schema has tests for exact keys and allowed values.
- Unsupported and unhealthy profiles remain discoverable but accurately state
  unavailable capabilities.

## Gap 3: OMP has no enforceable question-tool denial

### Problem

The OMP launcher accepts direct JSON mode and same-session resume, but the
installed OMP CLI rejects:

```bash
--exclude-tools=ask_question
```

The successful question flow relied on prompt instructions:

```text
Do not use an interactive question tool.
Return a trellage_questions envelope.
```

Prompt compliance is useful but is not equivalent to hard tool denial. A model
can still invoke `ask_question`, which is unsuitable for a non-interactive
process with closed stdin.

`cldx` and `cpx` already provide hard controls:

- Claude: `--disallowedTools AskUserQuestion`;
- Copilot: `--no-ask-user`.

OMP needs a comparable Trellage-owned contract.

### Required fix

Add an orchestration-only policy option to the Trellage OMP launcher. Example:

```bash
omp copilot --headless-policy no-user-input ...
```

The policy must:

- disable `ask_question`;
- preserve unrelated OMP tools;
- apply only to the invocation that requests the policy;
- leave normal interactive `omp copilot` behavior unchanged;
- fail closed if the installed OMP version cannot enforce the policy.

### Implementation choices

Preferred order:

1. Use an upstream OMP tool-deny feature when available.
2. Generate a temporary OMP configuration overlay that disables only
   `ask_question`.
3. Use a verified dynamic allowlist derived from the installed tool inventory.

Do not use a fixed, hand-maintained allowlist unless OMP provides no better
option. A fixed allowlist will silently remove future tools.

If hard denial cannot be implemented, advertise:

```json
{
  "questionToolControl": "prompt-only"
}
```

Do not advertise hard denial.

### Required tests

- The orchestration policy removes `ask_question`.
- Other representative tools remain available.
- Interactive launches still expose `ask_question`.
- Unsupported OMP versions fail with a clear diagnostic.
- A non-interactive prompt cannot block waiting for question input.

## Gap 4: No portable terminal evidence event

### Problem

JSONL mode currently exposes native harness events. This is useful and should
remain available, but terminal evidence varies by harness:

- session ID field names differ;
- success and failure event shapes differ;
- usage and cost fields differ;
- changed-file evidence may be absent;
- the profile and runtime contract version are not uniformly represented.

Every consumer must build and maintain a separate adapter.

### Required fix

Add optional, namespaced Trellage metadata events around native JSONL. Do not
replace or rewrite native events.

Recommended initial event:

```json
{
  "type": "trellage.session",
  "schemaVersion": 1,
  "profile": "claude-social-media",
  "harness": "claude",
  "runtime": "claude",
  "eventContract": "claude-stream-json-v1",
  "sessionId": "..."
}
```

Recommended terminal event:

```json
{
  "type": "trellage.result",
  "schemaVersion": 1,
  "outcome": "completed",
  "sessionId": "...",
  "finalText": "RED",
  "model": "...",
  "usage": {},
  "costUsd": 0.0,
  "changedFiles": []
}
```

Unknown data must not be replaced with false empty values. Use `null` or omit
the field when evidence is unavailable.

### Changed-file evidence

For sandbox profiles, Trellage can optionally record Git state before and
after the harness process and emit:

```json
{
  "changedFiles": ["src/example.ts"],
  "changedFilesSource": "git-diff"
}
```

Requirements:

- include tracked and untracked paths;
- do not infer semantic success from file changes;
- do not delete or modify files while collecting evidence;
- mark evidence unavailable when the worktree is not a Git repository;
- preserve native changed-file evidence when it is stronger.

### Acceptance criteria

- Trellage metadata events are valid JSONL.
- Native events remain byte-for-byte available.
- Session ID is consistent across initial and resumed processes.
- Terminal failure is represented even when the harness exits non-zero.
- Usage, cost, and changed-file fields are evidence-based.

## Gap 5: Runtime contract coverage is incomplete

### Problem

Claude container question/resume is live-verified. Other container runtime
families and many native launchers do not have the same headless contract
evidence.

Profile discovery alone is not proof of headless compatibility.

### Required verification matrix

For each runtime family that advertises headless support, test:

1. clean non-TTY completion;
2. valid JSON or JSONL only on stdout;
3. authoritative session ID;
4. same-session resume with a new prompt;
5. malformed output;
6. non-zero harness exit;
7. timeout or cancellation cleanup;
8. question-tool policy;
9. usage and cost fields;
10. changed-file evidence when advertised.

Run these tests once per runtime adapter, then add profile-specific smoke tests
where profile configuration changes the harness contract.

### Publication gate

A profile or launcher must not advertise a capability until:

- deterministic adapter tests pass;
- a live contract test passes;
- the tested harness version is recorded;
- the event-contract version is published.

## Recommended implementation order

1. Add runtime capability declarations and fail-closed validation.
2. Publish capabilities in `trellage list --json --full` and `trx list --json`.
3. Add enforceable OMP no-user-input policy or declare it prompt-only.
4. Add optional namespaced session and terminal evidence events.
5. Complete the runtime-family contract matrix.

## Definition of done

The Trellage side is ready when an external orchestrator can:

1. discover a profile;
2. inspect its headless capabilities;
3. reject unsupported operations before launch;
4. start it without a TTY;
5. parse machine-only stdout;
6. obtain an authoritative session ID;
7. resume the exact session with a prompt;
8. enforce or accurately classify question-tool behavior;
9. receive evidence-based terminal metadata;
10. do all of this without Herdr.
