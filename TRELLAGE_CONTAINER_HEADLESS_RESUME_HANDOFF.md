# Trellage container headless resume handoff

## Decision

**Yes. This is a Trellage issue.**

The `claude-social-media` container and Claude Code can create and resume saved
sessions. Trellage currently exposes those capabilities through two separate,
incompatible interfaces:

- `--prompt` is non-interactive, but starts a new session and returns plain text.
- `resume [SESSION_ID]` uses the interactive TUI, requires a TTY, and cannot
  accept `--prompt`.

This prevents an orchestration client from receiving a question, obtaining an
answer elsewhere, and resuming the same container session headlessly.

## Reproduced behavior

### Headless prompt works

```bash
trellage --profile claude-social-media \
  --prompt "Return exactly: TRELLAGE SOCIAL PROBE"
```

Result:

```text
TRELLAGE SOCIAL PROBE
```

Exit status: `0`.

### Structured question text works

The same command can return the required clarification envelope:

```xml
<trellage_questions version="1">{"questions":[{"id":"favorite-color","text":"What is my favorite color?","choices":["RED","BLUE"]}]}</trellage_questions>
```

The Claude session is persisted in the Trellage state volume.

### Headless resume does not work

```bash
printf 'RED\n' |
  trellage --profile claude-social-media \
    resume c742c8d4-fc3b-4f08-8631-7f93163cb650
```

Result:

```text
trellage: an interactive terminal is required
```

Exit status: `1`.

The host parser also explicitly rejects:

```bash
trellage --profile claude-social-media \
  resume <session-id> \
  --prompt RED
```

with:

```text
trellage: --prompt cannot be combined with positional arguments
```

## Current implementation constraints

The relevant code is under `prototypes/trellage/`.

1. `trellage` parses `--prompt` as a dedicated `prompt` mode and rejects every
   positional command when it is present.
2. `resume` accepts an optional session UUID but always follows the interactive
   attachment path with Docker `--interactive --tty`.
3. Prompt mode does not set `TRELLAGE_RESUME_PROFILE`, so
   `runtime-claude-entry.sh` does not print its existing resume hint.
4. `runtime-claude-entry.sh` already maps exact session IDs to Claude's native
   `--resume <session-id>`, but its `resume` mode does not accept a new prompt.
5. Portable prompt mode uses Claude `-p` but does not request
   `--output-format stream-json`, so stdout has no stable machine-readable
   session or terminal-result contract.
6. Existing host contract tests require `resume -p hello` to fail. That
   requirement must change for the new supported mode.

## Required CLI contract

Preserve all current interactive commands. Add a non-interactive
resume-with-prompt form:

```bash
trellage --profile <profile> \
  resume <session-id> \
  --prompt "<continuation>"
```

Add an explicit machine-output option:

```bash
trellage --profile <profile> \
  --output-format jsonl \
  --prompt "<initial prompt>"

trellage --profile <profile> \
  --output-format jsonl \
  resume <session-id> \
  --prompt "<continuation>"
```

`--output-format jsonl` must:

- run without a TTY;
- write only JSONL protocol events to stdout;
- write authentication checks, image pulls, warnings, and diagnostics to
  stderr;
- expose the native session ID;
- expose the final assistant text;
- preserve the native harness exit status;
- identify terminal success or failure;
- preserve usage, model, cost, and changed-file data when the harness supplies
  them.

For the first implementation, supporting Claude container profiles is
sufficient. The host contract must remain capability-based so Copilot, Codex,
Pi/OMP, and Prime containers can add mappings later.

## Recommended Claude implementation

### Host launcher

In `prototypes/trellage/trellage`:

1. Parse `--output-format text|jsonl`. Default to `text`.
2. Allow `resume [SESSION_ID]` together with `--prompt`.
3. Select a new internal mode such as `resume-prompt`.
4. Validate the UUID with the existing resume validation.
5. Use the detached/non-TTY supervised attachment path for `prompt` and
   `resume-prompt` when JSONL output is requested.
6. Pass `TRELLAGE_RESUME_SESSION_ID` for exact resume.
7. Do not append the human-readable resume hint to JSONL stdout.

Do not infer a session by scanning the state volume in the orchestration client.
The runtime must emit the authoritative session ID.

### Claude runtime entry

In `prototypes/trellage/runtime-claude-entry.sh`, add a mode that maps:

```text
resume-prompt <claude-command> [managed args] -- <prompt>
```

to the native Claude command:

```bash
claude \
  --dangerously-skip-permissions \
  --settings <managed-settings> \
  --resume <session-id> \
  -p "<prompt>" \
  --output-format stream-json \
  --verbose
```

Initial JSONL prompt mode must use:

```bash
claude \
  --dangerously-skip-permissions \
  --settings <managed-settings> \
  -p "<prompt>" \
  --output-format stream-json \
  --verbose
```

Keep arguments in arrays. Do not use shell evaluation or reconstruct commands
from strings.

Claude's native stream JSON already supplies the session ID and structured
terminal events. Trellage should pass those events through unchanged for the
Claude-first implementation. This lets clients reuse their existing Claude
JSONL adapters.

## Optional normalized Trellage envelope

Native JSONL passthrough is the smallest safe implementation. If Trellage later
needs one cross-harness protocol, use versioned events such as:

```json
{"schemaVersion":1,"type":"session","profile":"claude-social-media","harness":"claude","sessionId":"..."}
{"schemaVersion":1,"type":"result","outcome":"completed","finalText":"RED","model":"...","usage":{}}
```

Do not remove native evidence that cannot yet be normalized. Either include it
under a typed `native` field or provide a documented native-passthrough mode.

## Question-tool control

The resume fix must not make manual Trellage launches less capable.
Question-tool denial must be contextual to an orchestration-owned invocation.

For Claude profiles, a later capability flag can map to:

```bash
--disallowedTools AskUserQuestion
```

Until that flag exists, an orchestration client can instruct Claude to emit a
versioned question envelope and not invoke the interactive question tool.

## Required tests

Update `prototypes/trellage/tests/host_command_contract.sh`:

- accept `resume <uuid> --prompt <text>`;
- reject resume-prompt without a prompt or with a malformed UUID;
- prove prompt text remains one literal argument;
- prove the mode does not allocate Docker `--tty`;
- prove the exact session ID is passed through the environment;
- prove stdout is not contaminated by launcher diagnostics in JSONL mode;
- preserve current interactive `resume` behavior when no prompt is supplied.

Update `prototypes/trellage/tests/claude_entry_contract.sh`:

- initial JSONL prompt maps to Claude `-p`, `--output-format stream-json`, and
  `--verbose`;
- resume-prompt maps to the exact native `--resume <uuid>` session;
- the continuation prompt is passed literally;
- native non-zero exit status is preserved;
- missing or malformed session IDs fail closed.

Add an end-to-end container test:

1. Start `claude-social-media` in JSONL prompt mode.
2. Require one `trellage_questions` envelope.
3. Read the session ID from stdout.
4. Resume that exact ID with `RED`.
5. Require final assistant text to equal `RED`.
6. Require both commands to run without a TTY.

## Acceptance criteria

The change is ready when this flow succeeds:

```bash
trellage --profile claude-social-media \
  --output-format jsonl \
  --prompt "<ask favorite-color question>"

trellage --profile claude-social-media \
  --output-format jsonl \
  resume <session-id-from-first-command> \
  --prompt '<trellage_answers version="1">...</trellage_answers>'
```

Evidence must show:

- exact same session ID on both attempts;
- no interactive terminal or PTY;
- valid JSONL on stdout;
- exact final result `RED`;
- terminal success event and exit status `0`;
- no secret values in stdout, stderr, or saved fixtures;
- existing interactive Trellage behavior remains unchanged.

## Weavekit follow-up

After Trellage ships this contract:

1. Capture initial, clarification, resume, failure, and malformed JSONL
   fixtures from `claude-social-media`.
2. Add a container capability entry instead of enabling all container
   profiles.
3. Route Claude container output through the existing Claude adapter when
   Trellage uses native JSONL passthrough.
4. Run the exact `RED` question/resume validation through
   `mise run rlm`.
5. Enable only the verified container profile until other profiles pass the
   same contract tests.
