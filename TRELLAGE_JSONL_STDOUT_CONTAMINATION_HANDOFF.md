# Trellage JSONL stdout contamination handoff

## Decision

The new headless container resume contract works, but `--output-format jsonl`
does not yet guarantee machine-only stdout when Trellage automatically builds
or refreshes a profile image.

This is a Trellage launcher issue. The Claude runtime JSONL is valid. Output
from the host-side build lifecycle is written to the same stdout stream before
the runtime starts.

## Verified behavior

Tested against Trellage commit:

```text
2b35397 feat(sandbox): add headless container resume and JSONL output (#93)
```

Command:

```bash
trellage --profile claude-social-media \
  --output-format jsonl \
  --prompt '<question protocol prompt>'
```

The first launch detected a stale or missing profile image and rebuilt it. The
captured stdout contained:

- 33 non-JSON lines from image construction and import;
- then valid Claude stream JSON events;
- session ID `ae844449-15a0-4475-9af7-08add4b5220b`;
- the exact `trellage_questions` result.

The subsequent headless resume succeeded:

```bash
trellage --profile claude-social-media \
  resume ae844449-15a0-4475-9af7-08add4b5220b \
  --output-format jsonl \
  --prompt '<trellage_answers ... RED ...>'
```

Resume evidence:

- stdout contained zero non-JSON lines;
- the same session ID was reported;
- final result was exactly `RED`;
- exit status was `0`.

The remaining failure is therefore limited to host lifecycle output before the
harness process starts.

## Example contaminating stdout

The non-JSON lines included messages such as:

```text
Adding marketplace...
Installing plugin ...
wrote OCI image layout to /src/oci
manifest: sha256:...
Getting image source signatures
Copying blob sha256:...
Writing manifest to image destination
built: trellage-profile-claude-social-media-linux-arm64:locked (...)
```

These lines are valid human build progress, but they make the stream invalid
JSONL.

## Root cause

### Automatic profile build

In `prototypes/trellage/trellage`, the automatic image path runs:

```bash
node "$compiler" build --locked "$profile_path"
```

and can fall back to:

```bash
node "$compiler" build "$profile_path"
```

Both commands inherit the launcher's stdout.

The stale-lock refresh path also runs:

```bash
node "$compiler" build "$profile_path"
```

with inherited stdout.

### Compiler bootstrap

`ensure_profile_compiler` can run:

```bash
npm run build
```

This also inherits stdout and can contaminate a JSONL launch when the local
compiler is stale.

### Profile compiler

In `packages/trellage-cli/src/application.ts`, image construction runs child
commands with:

```ts
{
  stdio: "inherit";
}
```

This applies to:

- `mise oci build`;
- Skopeo's OCI-to-Docker import.

In `packages/trellage-cli/src/cli.ts`, the build command also prints:

```ts
Console.log(`built: ${result.image} (${result.digest})`);
```

Changing only this final message is insufficient because the inherited child
commands produce most of the contamination.

## Required invariant

For every successful or failed invocation with:

```bash
--output-format jsonl
```

Trellage must enforce:

- stdout contains only complete JSON values, one per line;
- all lifecycle, compiler, build, image-copy, authentication, warning, and
  progress output goes to stderr;
- the native harness exit status is preserved;
- build failure diagnostics remain visible on stderr;
- text and interactive modes keep their current human-readable output.

This invariant must hold on a cold first run, not only when the image and
compiler are already current.

## Recommended fix

Fix this at the host launcher boundary. Do not add JSON awareness to every
builder subprocess.

Add a helper in `prototypes/trellage/trellage` that redirects child stdout to
stderr only for JSONL agent launches:

```bash
run_lifecycle_command() {
  if [[ "$output_format" == jsonl ]]; then
    "$@" 1>&2
  else
    "$@"
  fi
}
```

Use the helper for all host-side commands that can run before the harness owns
stdout:

1. `npm run build` in `ensure_profile_compiler`;
2. automatic stale-lock profile refresh;
3. automatic locked profile image build;
4. non-locked fallback profile image build;
5. any synchronous dependency bootstrap that can write to inherited stdout;
6. future image pull, migration, or materialization commands in the agent
   launch path.

Commands that intentionally capture output for internal parsing must continue
to use command substitution or explicit capture. Do not redirect those blindly.

The existing environment-array calls must remain arrays. One safe pattern is:

```bash
if [[ "$output_format" == jsonl ]]; then
  "${clean_child_environment[@]}" "DOCKER_HOST=$docker_endpoint" \
    node "$compiler" build --locked "$profile_path" 1>&2
else
  "${clean_child_environment[@]}" "DOCKER_HOST=$docker_endpoint" \
    node "$compiler" build --locked "$profile_path"
fi
```

A small helper is preferable if it can preserve the existing environment-array
shape and command status without `eval`.

## Do not use these fixes

- Do not make clients discard arbitrary non-JSON lines. That hides protocol
  violations and can hide real failures.
- Do not wrap build logs in fake harness JSON events. They are launcher
  diagnostics, not model events.
- Do not suppress build output with `/dev/null`. Operators still need it on
  stderr.
- Do not merge stderr into stdout in JSONL mode.
- Do not change normal `trellage build` output. The invariant applies to agent
  launches that request JSONL.

## Required tests

### Host contract test

Extend `prototypes/trellage/tests/host_command_contract.sh` with a cold JSONL
launch fixture:

1. Mark the profile compiler stale.
2. Mark the profile lock or image stale.
3. Make fake `npm`, compiler, builder, and image-copy commands write distinct
   markers to both stdout and stderr.
4. Run a non-TTY prompt with `--output-format jsonl`.
5. Assert every lifecycle marker is present on stderr.
6. Assert no lifecycle marker is present on stdout.
7. Assert the harness JSONL fixture remains unchanged on stdout.
8. Assert the harness exit status is preserved.

Cover both:

- successful automatic build;
- failed automatic build.

For failure, stdout must still contain no build prose. Stderr must contain the
underlying build diagnostics and Trellage's failure message.

### Real compiler test

Add an integration test that exercises the real profile compiler with a local
fixture image or mocked Docker target. Ensure output from both inherited
commands in `application.ts` is redirected by the launcher.

### JSONL syntax assertion

Validate every non-empty stdout line:

```bash
while IFS= read -r line; do
  jq -e . >/dev/null <<<"$line"
done <stdout.log
```

Do not use `grep '^{'` in the acceptance test because it would ignore the
defect.

### Regression coverage

Retain tests proving:

- text prompt mode still shows human build progress;
- explicit `trellage build` still writes its normal output;
- interactive launches are unchanged;
- JSONL resume remains clean;
- exact session ID and native exit status are unchanged.

## Acceptance test

Force a cold/stale `claude-social-media` launch, then run:

```bash
trellage --profile claude-social-media \
  --output-format jsonl \
  --prompt 'Return exactly: JSONL COLD START' \
  >stdout.jsonl \
  2>stderr.log
```

Required evidence:

```bash
test -s stdout.jsonl
while IFS= read -r line; do
  jq -e . >/dev/null <<<"$line"
done <stdout.jsonl

grep -F 'building automatically' stderr.log
grep -F 'built:' stderr.log
```

Then run a question/resume flow:

1. Initial stdout is valid JSONL.
2. Read the session ID from the Claude `system/init` event.
3. Resume that exact ID non-interactively.
4. Require the final result to equal `RED`.
5. Require both stdout files to contain zero non-JSON lines.

## Weavekit impact

Do not enable Trellage container profiles in production RLM selection until
this cold-start invariant passes. The current Claude adapter can parse the
native stream JSON, but accepting contaminated stdout would weaken the process
contract and make failures dependent on local image-cache state.
