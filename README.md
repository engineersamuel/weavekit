# Weavekit

Weavekit is a TypeScript-first orchestration layer for explicit, typed agent workflows.

It now has two runtime boundaries:

- bounded in-process workflows under `src/macro-workflow/`;
- the durable **weavekit-mastermind** control plane under `src/mastermind/`.

Mastermind receives Linear webhooks, owns ticket state in SQLite, uses BAML for typed ticket review
and next-action recommendations, and uses XState for deterministic transitions. `src/submind/`
defines bounded executor contracts. Explicitly opted-in `IMPLEMENT_DIRECTLY` actions run through
durable fenced Herdr/Copilot attempts; other actions remain plan-only.

The v0 workflow is a Design Council. It selects a compact, task-appropriate persona subset each round from repo-local entity manifests, normalizes critiques through BAML, asks a Judge reducer whether to continue, and writes:

- `DecisionCouncilReport.md`
- `DecisionCouncilRunState.json`
- raw transcript debug files

## Initial prompt router

Weavekit now includes a lightweight front-door router that classifies an incoming prompt before the main harness runs. The default scorer is heuristic and intentionally cheap: it scores planning, research, decision-council, elicitation, and direct routes so a prompt can be routed to the most suitable next step without replacing the underlying agent harness.

```ts
import { createInitialWorkflowRouter } from "weavekit";

const router = createInitialWorkflowRouter();
const decision = await router.route({
  prompt: "Create a rollout plan for the new router and break it into milestones.",
});

console.log(decision.route);
```

This layer is designed to be extended with additional routes or a faster LLM/BAML scorer later, while keeping the initial classification cheap and deterministic.

## Setup

```bash
mise install
nub install
nub run baml-generate
```

## Mastermind

### One-command live Linear smoke

Create a Linear personal API key with workspace-admin access, then run:

```toml
# ~/.weavekit/config.toml
LINEAR_API_KEY = "lin_api_..."
LINEAR_WEBHOOK_SECRET = "persistent-webhook-signing-secret"

[mastermind]
public_webhook_url = "https://mastermind.example.com/channels/linear/webhook"
linear_webhook_id = "linear-webhook-id"
cloudflare_tunnel = "weavekit-mastermind"
cloudflare_tunnel_config = "~/.cloudflared/weavekit-mastermind.yml"
```

```bash
mise run mastermind:live
```

The config loader injects the key into `LINEAR_API_KEY`, then Varlock validates it against the
checked-in `.env.schema` and marks it sensitive for runtime redaction.

With the persistent settings above, the task starts the named Cloudflare Tunnel, reuses the Linear
webhook and signing secret, reviews the selected ticket, and leaves the webhook in place on exit.
If those settings are absent, the task falls back to development setup:

1. verifies the local Copilot model proxy;
2. discovers Linear teams and recent tickets;
3. creates the reviewed, ready, needs-input, and review-failed labels when needed;
4. starts a temporary Cloudflare Quick Tunnel;
5. creates a temporary Linear Issue webhook and prints its public URL and ID;
6. asks you to copy the webhook signing secret from Linear API settings;
7. starts a read-only frontier harness, synthesizes a governed patch, and reviews the selected
   first ticket; and
8. keeps serving later ticket updates until `Ctrl-C`, then deletes the temporary webhook.

Persistent setup requires one initial human step because Linear exposes a webhook signing secret
only on its detail page. Create a named Cloudflare Tunnel and DNS route, configure its ingress to
the Mastermind origin, create one Linear Issue webhook for the public URL, then save its ID and
secret above. Example Cloudflare ingress:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /Users/<user>/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: mastermind.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Selection can be non-interactive:

```bash
export MASTERMIND_LINEAR_TEAM="Platform"
export MASTERMIND_LINEAR_ISSUE="WK-123"
export MASTERMIND_PROJECT_ID="weavekit"
mise run mastermind:live
```

Quick Tunnels are for development testing and receive a new `trycloudflare.com` URL each run. A
temporary Linear webhook therefore has a new signing secret every run and cannot reuse a saved
secret.

### Long-running daemon

Configure `~/.weavekit/config.toml`:

```toml
LINEAR_API_KEY = "lin_api_..."
LINEAR_WEBHOOK_SECRET = "persistent-webhook-signing-secret"

[mastermind]
enabled = true
host = "127.0.0.1"
port = 8787
sqlite_path = "~/.weavekit/mastermind.sqlite"
public_webhook_url = "https://mastermind.example.com/channels/linear/webhook"
cloudflare_tunnel = "weavekit-mastermind"
cloudflare_tunnel_config = "~/.cloudflared/weavekit-mastermind.yml"
linear_organization_id = "linear-organization-id"
linear_webhook_id = "linear-webhook-id"
synthesis_model = "gpt-5.5"
reviewed_label_id = "linear-label-id"
reviewed_label_name = "mastermind-reviewed"
ready_label_id = "linear-ready-label-id"
ready_label_name = "mastermind-ready"
needs_input_label_id = "linear-needs-input-label-id"
needs_input_label_name = "mastermind-needs-input"
review_failed_label_id = "linear-review-failed-label-id"
review_failed_label_name = "mastermind-review-failed"
code_review_label_id = "linear-code-review-label-id"
code_review_label_name = "mastermind-code-review"
code_review_passed_label_id = "linear-code-review-passed-label-id"
code_review_passed_label_name = "mastermind-code-review-passed"
changes_requested_label_id = "linear-changes-requested-label-id"
changes_requested_label_name = "mastermind-changes-requested"
in_progress_state_name = "In Progress"
in_review_state_name = "In Review"
done_state_name = "Done"
lease_duration_ms = 60000
reconcile_interval_ms = 30000
max_decision_iterations = 3
allowed_actions = [
  "REVIEW_TICKET",
  "IMPLEMENT_DIRECTLY",
  "DELEGATE_SUBMIND",
  "WAIT",
  "NEEDS_HUMAN",
  "IGNORE",
]

[mastermind.harnesses.ticket_review]
transport = "copilot-sdk"
command = "copilot"
args = []
model = "claude-opus-4.8"

[mastermind.harnesses.implementation]
transport = "herdr"
command = "copilot"
kind = "copilot"
args = []

[mastermind.harnesses.code_review]
transport = "command"
command = "codx"
args = ["exec", "--json", "{prompt}"]

[[mastermind.project_mappings]]
team_id = "linear-team-id"
linear_project_id = "optional-linear-project-id"
project_id = "weavekit"

[mastermind.execution]
executor_kind = "herdr-copilot"
harness_kind = "copilot"
max_autopilot_continues = 8
allow_tools = ["write", "shell(git:*)", "shell(nub:*)", "shell(mise:*)"]
deny_tools = ["shell(git push)", "shell(gh pr merge)"]
allow_urls = ["github.com"]
deny_urls = []
poll_interval_ms = 5000
unknown_status_threshold = 3
cancellation_grace_ms = 30000
prompt_acceptance_timeout_ms = 30000
max_attempts = 2

[projects.weavekit]
display_name = "Weavekit"
working_tree = "~/projects/personal/weavekit"
repository_mode = "existing"
mainline = "origin main"
validation_commands = ["nub run typecheck", "nub run test"]

[projects.weavekit.execution.direct]
enabled = true
allowed_executors = ["herdr-copilot"]
allowed_pr_hosts = ["github.com"]

[projects.prototypes]
display_name = "Prototypes"
working_tree = "~/projects/prototypes"
repository_mode = "greenfield"
provisioning_root = "~/projects/prototypes"
autonomous_pr_allowed = false
```

Set model runtime values in the process environment:

```bash
export COPILOT_PROXY_BASE_URL="http://127.0.0.1:8080/v1"
export COPILOT_PROXY_API_KEY="anything"
export BAML_MODEL="gpt-5.5"
nub run mastermind
```

`LINEAR_API_KEY` and `LINEAR_WEBHOOK_SECRET` come from root config values and are marked sensitive
by Varlock. Environment variables still override config values when supplied by the caller.

Linear sends issue create/update events to `/channels/linear/webhook`. For an unreviewed ticket,
Mastermind starts a read-only Copilot SDK harness and loads the `weavekit-ticket-review` skill.
Existing-repository projects receive repository read tools and produce structured, repository-
relative evidence. They do **not** fetch external URLs in that same agent session. Greenfield
projects use a separate no-local-filesystem trust boundary that may still call `web_fetch`, and
their `provisioning_root` is only the parent under which a future governed executor may create a
concrete project directory. Ticket review never creates that directory or inspects sibling
prototypes. BAML converts the dossier into a typed patch, deterministic policy validates evidence,
readiness, and open-item ownership, and only Mastermind's narrow Linear gateway can apply the
patch.

Mastermind applies `mastermind-reviewed` plus `mastermind-ready` when the ticket is ready,
`mastermind-needs-input` when a blocked or scope-changing patch requires a human, and
`mastermind-review-failed` when review generation or policy validation fails. A human edit made
while review is running invalidates the stale proposal through a content hash and triggers a fresh
review. A stored review also gates the next action: human-owned review items route directly to
`NEEDS_HUMAN`, `EXECUTOR_PREFLIGHT` gaps may stay nonblocking but must remain explicit
implementation prerequisites, and BLOCKED reviews made only of `EXTERNAL_DEPENDENCY` items route
to `WAIT` without being misclassified as executor preflight.

Direct execution remains disabled unless `[mastermind.execution]` and the resolved project's
`[projects.<id>.execution.direct]` policy are both present. An opted-in `IMPLEMENT_DIRECTLY`
action creates a durable attempt before side effects, provisions or adopts one dedicated Herdr
worktree, runs preflight in that writable worktree, starts one named Copilot agent in bounded
unattended autopilot with all permissions enabled, and reconciles it through restart-safe polling.
Herdr `idle` or `done` never means
success by itself: Mastermind requires a current-attempt result manifest and verification evidence,
then writes one idempotent Linear comment and label projection. Successful implementation moves
the ticket to `In Review` and starts a distinct post-implementation code review against the frozen
ticket snapshot, successful attempt, result manifest, verification evidence, and current commit.
Review `PASS` waits for explicit human acceptance; `CHANGES_REQUIRED` stays out of `Done`.
`DELEGATE_SUBMIND` remains unlaunched.

Submind operating instructions have one canonical source:
`.github/skills/mastermind-submind/SKILL.md`. The build copies that skill to
`dist/.github/skills/mastermind-submind/SKILL.md`. When the submind controller provisions an
assigned worktree, it stages the same skill at
`<assigned-worktree>/.github/skills/mastermind-submind/SKILL.md` before launching the orchestrator.
The initial agent prompt explicitly says to use `mastermind-submind`, then supplies only dynamic run
context such as the objective, worktree, identities, scoped Herdr helper, and result location.
Each submind attempt randomly selects either `gpt-5.6-sol` or `claude-opus-5`, persists that choice
before launch, and starts the orchestrator with `--reasoning-effort high`. Recovery reuses the
persisted model rather than drawing again.

This split is intentional. Stable authority, delegation, review, and verification rules live in
the skill rather than being repeated in every task prompt. Attempt-specific data remains in the
initial user prompt. A pure model system prompt is not used because Mastermind supports replaceable
harness commands with different system-prompt interfaces; the staged skill is the portable
instruction seam. Harness adapters may map the skill to a native system-instruction mechanism in
the future, but the initial prompt must still invoke it explicitly and must fail closed when the
selected harness cannot load the staged instructions.

Harness profiles are independent by phase. `ticket_review` supports `copilot-sdk` or `command`,
`implementation` runs through `herdr`, and `code_review` supports `copilot-sdk` or `command`.
`command` and `args` are passed exactly as configured, and `{prompt}` is replaced with the phase
prompt. This supports custom executables and profiles such as `codx` without hardcoding a vendor
CLI into Mastermind.

To execute one already-reviewed item without starting the webhook server or daemon loop, stop
`mastermind:live` and run:

```bash
mise run mastermind:execute-one
```

The command resumes the oldest recoverable attempt first; otherwise it launches the oldest
`IMPLEMENT_DIRECTLY` item with explicit project opt-in. It runs bounded coordinator phases,
polls the agent, runs post-code review, and exits at `awaiting_acceptance`, `changes_requested`,
`needs_human`, or `failed`. If no work is ready, it exits successfully without side effects.

To review one already-successful execution directly:

```bash
mise run mastermind:review-one ENG-5
```

After reviewing the result manually, accept it and move the Linear ticket to `Done`:

```bash
mise run mastermind:accept ENG-5
```

To return to an execution agent later, use its Linear ticket identifier, Mastermind work ID, Linear
issue ID, or execution attempt ID:

```bash
mise run mastermind:attach ENG-5
```

Inside Herdr, the task focuses the agent. From a normal terminal, it attaches directly to the
agent's terminal. Mastermind terminal comments also include the explicit `herdr agent attach`,
`focus`, and transcript-reading commands plus the preserved worktree path. The task resolves the
deterministic agent name from SQLite rather than relying on compact live workspace or pane IDs.

### Manual direct-execution smoke

Use one disposable Linear ticket and one explicitly opted-in project:

1. Run `mise run doctor`.
2. Start `mise run mastermind:live`.
3. Confirm review selects `IMPLEMENT_DIRECTLY`.
4. Confirm one parent repository workspace and one dedicated worktree workspace exist in Herdr.
5. Confirm one deterministic `mm-...-a1` Copilot agent starts in the worktree root pane with
   `--autopilot`, `--allow-all`, `--no-ask-user`, bounded continuation, and reviewed deny flags.
6. Restart Mastermind while the agent runs and confirm it adopts the same agent and worktree.
7. Let the agent write `.weavekit/mastermind-result.json`.
8. Confirm trusted validation commands pass, one terminal Linear projection appears, and Langfuse
   shows short phases correlated by work ID and attempt ID.

The released `@flue/linear` package currently depends on an `@linear/sdk` version rejected by this
repository's Nub trust policy. Mastermind therefore mounts the same verified Linear HMAC channel
as an application-owned Flue/Hono route without weakening dependency trust. Replace the local
channel with `@flue/linear` when a trusted compatible release is available.

Install the local pre-commit hook (lints/auto-fixes and formats staged files with oxlint + oxfmt via `mise run pre-commit`; this must be run once per clone since `.git/hooks` isn't version-controlled):

```bash
mise generate git-pre-commit --write
```

Run the local Copilot proxy on port 8080 before running the real workflow. The BAML clients use
the proxy's OpenAI-compatible `/v1/chat/completions` endpoint. Set `BAML_MODEL` for the fallback
`DefaultClient` (e.g., `gpt-5-mini`); note the decision council routes its BAML calls to fixed
policy clients by default, so `BAML_MODEL` does not drive them (see
[Model + effort routing](#model--effort-routing)). Mastermind synthesis now uses
`[mastermind].synthesis_model` when it is set, otherwise `MASTERMIND_SYNTHESIS_MODEL` when the
runtime environment provides it, otherwise `BAML_MODEL` when present, and finally the stable
`gpt-5.5` default. The runtime loads the `MASTERMIND_SYNTHESIS_MODEL` override before building the
final typed Mastermind config so rollback overrides work in the daemon, CLI, and live smoke entrypoints.

```bash
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/v1/models
export COPILOT_PROXY_BASE_URL="http://127.0.0.1:8080/v1"
export COPILOT_PROXY_API_KEY="anything"
export BAML_MODEL="gpt-5-mini"
```

`COPILOT_PROXY_BASE_URL` is the base URL for the `DefaultClient` (the BAML fallback client, used only when no model router is injected). Set it to your proxy's OpenAI-compatible endpoint. The hardcoded `CopilotProxy*` model clients — including the ones the decision council routes to by default — always use `http://127.0.0.1:8080/v1`.

`COPILOT_PROXY_API_KEY` can be any non-empty value unless your proxy is configured to require a specific inbound API key. The proxy uses your local Copilot credentials; keep it bound to loopback.

`BAML_MODEL` sets the model for `DefaultClient`, the fallback used when no model router is
injected. By default the decision council routes `normalize`/`assess`/`report` to fixed policy
clients (see [Model + effort routing](#model--effort-routing)), so `BAML_MODEL` does not affect
those calls. Mastermind also uses `BAML_MODEL` as its synthesis default when neither
`[mastermind].synthesis_model` nor `MASTERMIND_SYNTHESIS_MODEL` is set. Otherwise it keeps the
stable `gpt-5.5` baseline unless you opt into another synthesis model explicitly.

The counterbalanced Mastermind synthesis benchmark writes a local artifact at
`runs/mastermind-synthesis-benchmark/<timestamp>.json`. The latest rerun in this worktree kept
`gpt-5.5` as the effective default: `gemini-3.6-flash` preserved the quality and safety gates but
posted a 15.8-second median versus `gpt-5.5` at 9.17 seconds, failing the strict baseline-beat
adoption gate, the 10% relative slowdown gate, and the 12-second observed-target gate. The
observed-target gate only says absolute latency is acceptable; default adoption also requires the
candidate median to be strictly lower than the baseline median. Keep Gemini behind an explicit
synthesis override until a future rerun reverses that result.

> **Migration note (from ≤ aa829d9):** The BAML `DefaultClient` env variables were renamed when client definitions were extracted to `baml_src/clients.baml`. Rename your environment variables:
>
> - `BAML_OPENAI_BASE_URL` → `COPILOT_PROXY_BASE_URL`
> - `BAML_OPENAI_API_KEY` → `COPILOT_PROXY_API_KEY`

GitHub Copilot SDK authentication for persona workers follows the SDK's local authentication behavior.

## Source-to-project workflow

The `source-to-project` workflow applies one external Source artifact to one configured Target project. It reads the source, corroborates claims, researches the target project, maps project-specific Opportunities, asks the Decision Council to rank and bundle them, writes Plan artifacts, and can optionally prepare review-ready pull requests.

Advisory mode is the default and does not modify the target project:

```bash
nub src/cli.ts workflow run --template source-to-project --source "https://example.com/post" --project weavekit --mode advisory
```

`--source` may be omitted when the prompt or input file includes a URL, `source: ...`, or `blog: ...`; the explicit flag still wins when both are present.

Use `--prompt` when you want a human-readable objective for the run without creating an input file:

```bash
nub src/cli.ts workflow run \
  --template source-to-project \
  --prompt "Read and analyze https://github.com/robert-mcdermott/ai-knowledge-graph for how it will apply to project: secondbrain" \
  --source "https://github.com/robert-mcdermott/ai-knowledge-graph" \
  --project secondbrain \
  --mode advisory
```

For repeated source-to-project runs against weavekit, use the mise task. If the prompt includes a URL, Weavekit uses that URL as the Source artifact reference; otherwise it treats the prompt text itself as the Source artifact.

```bash
mise run source-to-project "Adapt these loops to weavekit: https://github.com/cobusgreyling/loop-engineering and also review their code to see how they are doing loops and what might apply to the weavekit static DAG templates or dynamic workflows"
```

The task defaults to `project=weavekit`, `mode=advisory`, `output=runs`, and dashboard publishing to `http://127.0.0.1:4321`. For different project or output settings, call `nub src/cli.ts workflow run` directly with `--project` or `--project-path`, `--mode`, `--output`, and `--dashboard-url`.

By default, source-to-project runs use the live Copilot SDK harness and generated BAML distillation calls. Configure first-party source-to-project defaults in `~/.weavekit/config.toml`: `source_to_project.copilot_model` overrides Copilot SDK calls, `timeout_ms` controls SDK wait time, `max_tool_calls` sets the global research tool budget, `source_reading_max_tool_calls` and `project_research_max_tool_calls` tune individual research nodes, and `offline = true` uses the deterministic offline harness for local smoke tests. The workflow verifies the `visual-plan` skill installer in a preflight node before source reading begins, and `mise run doctor:sdk` dry-runs the same installer path with `--dry-run --no-connect`. Without a Copilot model override, source reading and source corroboration use `gpt-5.5`, target project research uses `claude-sonnet-5`, planning uses `claude-opus-4.8`, and implementation uses `gpt-5.3-codex`. `BAML_MODEL` affects generated BAML distillation/mapping calls, not Copilot SDK sessions. Set `source_to_project.council_deliberation.enabled = true` (default `false`) to have the "Rank and bundle opportunities" node also run a real, persona-driven decision council deliberation from the full council roster alongside its deterministic acceptance gate — the dashboard then shows the genuinely selected personas and their reasoning instead of nothing; `max_rounds` (default `1`) caps debate rounds. This is disabled by default because each round runs a real Copilot SDK agent session per selected persona, adding real cost and latency.

Autonomous PR mode must be enabled for the project in `~/.weavekit/config.toml`:

```bash
nub src/cli.ts workflow run --template source-to-project --source "https://example.com/post" --project weavekit --mode autonomous-pr
```

Example project catalog entry:

```toml
[source_to_project]
max_opportunities = 1
min_applicability = 0.7
min_confidence = 0.65
min_impact = 0.5
max_risk = 0.8
mode = "advisory"
offline = false
copilot_model = "gpt-5.5"
timeout_ms = 300000
max_tool_calls = 60
source_reading_max_tool_calls = 40
project_research_max_tool_calls = 60

[copilot]
verbose_events = false
# Optional local SDK runtime selection:
# runtime_url = "http://127.0.0.1:8181"
# cli_path = "~/.local/bin/copilot"
sdk_doctor_model = "gpt-5-mini"

[flue]
model = "anthropic/claude-haiku-4-5"

[tooling]
skills_directory = "~/.weavekit/skills"
agent_native_skills_installer = "~/.local/bin/agent-skills"
agent_native_skills_package = "@agent-native/skills@latest"
mise_bin = "/opt/homebrew/bin/mise"

[plugins.hve-core]
directory = "~/.copilot/installed-plugins/_direct/hve-core"

[projects.weavekit]
display_name = "Weavekit"
working_tree = "/path/to/weavekit"
mainline = "origin main"
remote = "origin"
context_docs = ["CONTEXT.md", "docs/adr"]
validation_commands = ["nub run typecheck", "nub run test"]
autonomous_pr_allowed = true
max_opportunities = 1
notification = "cli"
knowledge_export = "off"

[projects.weavekit.execution.azure]
subscription_id = "00000000-0000-0000-0000-000000000000"
tenant_id = "00000000-0000-0000-0000-000000000000"
```

Executor authentication requirements come from the project catalog, never from an LLM decision.
Immediately before Azure work starts, the selected executor runs `az account show` in its own
environment and fails closed unless the configured subscription and optional tenant match.

Set `notification = "telegram"` to send final-review rejection notices through `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID`. The CLI loads these from the current shell first, then local `.env`, then local `.env.fish` without printing secret values. Notification failures are recorded in the workflow artifacts but do not fail a guarded no-op rejection.

Autonomous PR mode prepares an isolated worktree, rebases it from the configured mainline, copies `.env*` files into the worktree without recording their contents, runs implementation and verification, opens a PR, and stops. It never merges or self-approves.

## Native Flue agent harness

Weavekit uses Flue as the production workflow/agent harness. The main workflow path should call models through Flue/Pi providers, not through `@github/copilot-sdk`. The Copilot SDK may be used later for an explicit final handoff/autopilot experiment, but it is not the primary Decision Council model-call path.

Set `[flue].model` in `~/.weavekit/config.toml` to override the default Flue model for Decision Council agents. Defaults to `anthropic/claude-haiku-4-5`. The model must be a registered Flue/Pi provider.

### Flue MCP tools

The Flue workflow can expose selected MCP tools from the same systems used in local Copilot CLI config:

| MCP             | Env/config                | Notes                                                                                                 |
| --------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Exa             | `EXA_API_KEY`             | Builds `https://mcp.exa.ai/mcp?exaApiKey=...` at runtime.                                             |
| EngHub          | none                      | Uses `https://mcp.eng.ms`.                                                                            |
| Context7        | `CONTEXT7_API_KEY`        | Sent as a trusted application header.                                                                 |
| Baton           | `includeLocalBaton: true` | Local development only; requires Baton MCP server on `http://localhost:53724/mcp`.                    |
| awesome-copilot | not wired                 | Current Flue MCP API expects remote MCP endpoints; bridge the Docker stdio server before exposing it. |

Server or application registration code should use `createConfiguredDecisionCouncilWorkflow(...)` when it wants the environment-configured MCP tools attached to the Flue workflow:

```ts
const { workflow, close } = await createConfiguredDecisionCouncilWorkflow(deps, {
  env: process.env,
  includeLocalBaton: false,
});

try {
  // Register or invoke `workflow` with the Flue runtime.
} finally {
  await close();
}
```

### Superpowers skill

The `using-superpowers` Agent Skill is vendored under `src/skills/using-superpowers/` and imported by the shared Flue Decision Council agent. Skills provide instructions and reusable process guidance; executable capabilities still come from Flue tools/MCP servers.

## Run the Design Council

```bash
nub run council decision-council run --input examples/design-question.md --output runs/example
```

The CLI prints rich progress to stderr while the council runs: run start, round start, persona start/finish/failure, BAML normalization/Judge/report phases, artifact paths, and final stop reason. Each event renders as a colored, YAML-style block (via [prettyjson](https://www.npmjs.com/package/prettyjson)) under a status-colored header. After each successful BAML normalization, the block includes the persona's normalized stance summary:

```text
[2026-06-24T19:42:21.962Z] baml completed
  runId:       run-1
  roundNumber: 1
  personaId:   pragmatic
  operation:   normalize
  summary:     Pragmatic persona recommends a minimal validation spike before adopting Flue/BAML.
  duration:    4.5s
```

Rounds use a shared fan-out/fan-in model. Round 1 sends the initial brief to the selected personas for that round. Round 2+ sends one shared Judge brief, produced from the previous round's full set of normalized critiques, to the newly selected personas; the Judge then assesses the current round's full critique set together.

The final stdout includes the recommendation plus a link to the Markdown report:

```text
Markdown report: runs/example/DecisionCouncilReport.md
```

Use `--log-format` to control progress output:

```bash
nub run council decision-council run --input examples/design-question.md --output runs/example --log-format pretty
nub run council decision-council run --input examples/design-question.md --output runs/example --log-format json
nub run council decision-council run --input examples/design-question.md --output runs/example --log-format silent
```

`pretty` is colored, YAML-style human-readable progress (rendered with prettyjson). `json` emits newline-delimited structured events such as `council.run.started`, `council.persona.completed`, and `council.baml.completed`. `silent` suppresses Weavekit progress logs.

BAML can print large raw prompts/responses. Use `BAML_LOG=warn` when you want Weavekit's progress logs without BAML's verbose prompt dump:

```bash
BAML_LOG=warn COPILOT_PROXY_API_KEY="anything" nub run council decision-council run --input examples/design-question.md --output runs/example
```

## Workflow Entity Manifests

Weavekit uses repo-local YAML Workflow Entity Manifests as the canonical catalog for reusable workflow entities.

- Personas live in `entities/personas/<id>.yaml` with sibling prompt prose in `entities/personas/<id>.md`.
- Artifacts live in `entities/artifacts/<id>.yaml` and reference BAML-owned functions.
- Elicitation contracts live in `entities/elicitation/<id>.yaml` with sibling prompt prose.
- Artifact and elicitation manifests are validated in v1 but are not invoked directly by runtime code.

Validate the catalog before a run:

```bash
nub src/cli.ts entity validate
```

Decision Council dynamically selects from all eligible manifest personas. Static persona sets are not supported.

```bash
nub run council decision-council run --input examples/design-question.md
```

## Smoke testing

For fast end-to-end integration smoke tests, use `--smoke`. It is a runtime preset that keeps dynamic persona selection, caps selection to two personas, runs a **single round**, and pins every model call (personas and BAML normalize/assess/report) to `gpt-5-mini` for speed:

```bash
nub run council decision-council run --smoke --input examples/smoke-question.md --output runs/smoke
```

`--smoke` defaults `--max-rounds` to `1`. `--max-rounds <n>` is also available independently to cap any run.

A `mise` task wraps the smoke command (with `BAML_LOG=warn` and a placeholder proxy key):

```bash
mise run council:smoke
```

### Sun Tzu Strategist

`sun-tzu` reads a decision as terrain. It names the real battlefield and the actual opposing force (not the surface rival), finds the undefended gap, prescribes the exact next move, and names the trap to avoid — then closes on the one governing principle that makes the move win. It is cold and prescriptive ("give the move, not the wisdom"); in-council it ends every critique with the four claims/risks/questions/recommendations lists so BAML normalization stays lossless. The full standalone form lives in [`entities/personas/sun-tzu.md`](entities/personas/sun-tzu.md).

### Reusing personas in other workflows

Personas are loaded from the entity catalog and exposed through manifest-backed APIs. Future workflows can reuse `createBamlPersonaSelector` with `listPersonas()` or direct persona lookup:

```ts
import {
  createBamlPersonaSelector,
  getPersona,
  listPersonas,
  composePersonaPrompt,
} from "weavekit";

const sunTzu = getPersona("sun-tzu");
const dynamicSelector = createBamlPersonaSelector({
  candidatePersonas: listPersonas(),
  minPersonas: 2,
  maxPersonas: 6,
});
const message = composePersonaPrompt(sunTzu, {
  brief: { roundNumber: 1, prompt: "Should we out-build a larger competitor?", focus: "Strategy" },
});
```

`getPersona(id)` and `listPersonas()` read the validated entity catalog; `composePersonaPrompt` renders the sibling Markdown prompt with the round brief.

## Model + effort routing

Weavekit's decision council routes each task (normalize, assess, report, persona) to a model and optional reasoning effort using a hybrid router: a deterministic policy default always applies, and an optional fast LLM router is consulted only when a task is marked `dynamic`.

**Hybrid router:** The policy default is always resolved first. For tasks with `dynamic: true`, the router consults a fast LLM router model to pick a model and effort from a curated candidate set. The LLM router result is cached per `(taskKind, summary)` prefix. If the LLM returns a client or model outside the allowed candidate set, the router falls back to the policy default.

**Sub-5-second guarantee:** The LLM router races its call against a 3500 ms `AbortSignal` timeout. On timeout or any error, the router immediately falls back to the deterministic policy. This ensures routing decisions never block the workflow.

**Default routing policy:**

| Task kind   | BAML client         | Model               | Use case                                  |
| ----------- | ------------------- | ------------------- | ----------------------------------------- |
| `normalize` | `CopilotProxyGpt54` | `gpt-5.4`           | Lowest-TTFT structured extraction default |
| `assess`    | `CopilotProxyGpt54` | `gpt-5.4`           | Lowest-TTFT Judge decision default        |
| `report`    | `CopilotProxyGpt54` | `gpt-5.4`           | Stable synthesis default                  |
| `persona`   | (Copilot SDK path)  | `claude-sonnet-4.5` | Persona debate tier                       |

**BAML effort passthrough:** By default, BAML routing swaps the _client_ only and does NOT send `reasoning_effort` to the proxy. Effort passthrough is opt-in, left disabled pending proxy verification. Similarly, persona `reasoningEffort` is only forwarded when an operator wires an explicit capability predicate (it defaults to off). No model receives an effort field it might reject unless explicitly enabled.

**Benchmark router latency:**

Before choosing a production router model, measure TTFT and total latency across candidates:

```bash
export COPILOT_PROXY_BASE_URL="http://127.0.0.1:8080/v1"
export COPILOT_PROXY_API_KEY="anything"
nub run bench:router
```

This prints a table of TTFT and total latency per candidate router model. It is a standalone diagnostic, not part of `npm test`.

## Observability

The direct CLI path uses Weavekit's typed `DecisionCouncilLogger` events. Use `--log-format json` to capture them as JSONL:

```bash
BAML_LOG=warn nub run council decision-council run --input examples/design-question.md --output runs/example --log-format json 2> runs/example/events.jsonl
```

Recommended span names if you export those events to OpenTelemetry:

- `run.council`
- `run.council.round`
- `run.council.persona`
- `run.council.baml`
- `write.council.artifacts`

Flue runtime observability applies when running through the exported `createDecisionCouncilWorkflow(...)` registration seam. Register Flue's observer or OpenTelemetry instrumentation in the application entrypoint that hosts the workflow:

```ts
import { instrument, observe } from "@flue/runtime";
import { createOpenTelemetryInstrumentation } from "@flue/opentelemetry";

observe((event) => {
  if (event.type === "run_end" && event.isError) {
    console.error("Workflow failed", event.runId, event.error);
  }

  if (event.type === "operation" && event.durationMs > 5_000) {
    console.warn("Slow Flue operation", event.operationKind, event.durationMs);
  }
});

const dispose = instrument(
  createOpenTelemetryInstrumentation({
    content: {
      enabled: process.env.OTEL_GENAI_CAPTURE_CONTENT === "true",
      transform(content) {
        return content;
      },
    },
  }),
);
```

Install the Flue OpenTelemetry bridge only in apps that export telemetry:

```bash
nub install @flue/opentelemetry @opentelemetry/api
```

Keep `OTEL_GENAI_CAPTURE_CONTENT` unset or `false` unless you have reviewed prompt/content retention, because Flue events can include model-visible content.

## Telemetry and Observability

Decision Council telemetry is emitted through OpenTelemetry spans at three levels: the CLI run (`council-run`), per-round/per-persona workflow spans, and decorator-based BAML operation spans such as `run.council.baml.normalize`. If you leave all exporter credentials unset, the CLI still runs normally and no telemetry leaves the process. Set `OTEL_SDK_DISABLED=true` when you want to skip OpenTelemetry startup entirely.

The Copilot persona worker also uses the built-in Copilot SDK telemetry path when an OTLP endpoint is configured. It reuses the same OTEL endpoint/service name as the rest of Weavekit, injects the active trace context into the SDK's outbound RPCs, and joins the same trace tree as the council spans. This is enabled automatically whenever `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set and `OTEL_SDK_DISABLED` is not `true`.

### Environment variables

| Variable                      | Purpose                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_SDK_DISABLED`           | Set to `true` to disable OpenTelemetry startup entirely.                                                                                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Enables OTLP trace export when set (for example `http://127.0.0.1:4318/v1/traces`).                                                      |
| `OTEL_EXPORTER_OTLP_HEADERS`  | Optional OTLP auth/tenant headers consumed by the OTLP exporter environment configuration.                                               |
| `OTEL_SERVICE_NAME`           | Optional OpenTelemetry service name override; defaults to `weavekit`.                                                                    |
| `OTEL_GENAI_CAPTURE_CONTENT`  | Set to `true` to enable Copilot SDK content capture for persona sessions; defaults to redacted/off.                                      |
| `LANGFUSE_PUBLIC_KEY`         | Langfuse public key. When paired with `LANGFUSE_SECRET_KEY`, enables Langfuse trace export.                                              |
| `LANGFUSE_SECRET_KEY`         | Langfuse secret key.                                                                                                                     |
| `LANGFUSE_BASE_URL`           | Optional Langfuse base URL override. Defaults to `https://cloud.langfuse.com`.                                                           |
| `LANGFUSE_PROJECT_ID`         | Optional Langfuse project ID used to print a direct trace URL when a Mastermind work item starts.                                        |
| `LANGFUSE_EXPORT_RAW`         | Set to `true` only when you intentionally want raw prompts/responses uploaded to Langfuse. By default Weavekit redacts exported content. |

### Example: telemetry enabled (OTLP + Langfuse)

```bash
BAML_LOG=warn \
OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318/v1/traces" \
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer <token>" \
OTEL_SERVICE_NAME="weavekit" \
LANGFUSE_PUBLIC_KEY="pk-lf-..." \
LANGFUSE_SECRET_KEY="sk-lf-..." \
LANGFUSE_BASE_URL="https://cloud.langfuse.com" \
LANGFUSE_EXPORT_RAW="false" \
nub run council decision-council run --smoke --input examples/smoke-question.md --output runs/telemetry-enabled
```

`mise run mastermind:live` starts the same telemetry SDK after Varlock loads
`~/.weavekit/config.toml`. Each work item creates one `mastermind.work` trace with child
observations for lease acquisition, freshness checks, Linear reads and writes, state transitions,
the Copilot SDK review agent, BAML decisions and synthesis, deterministic policy gates, and the
governed Linear mutation. When `LANGFUSE_PROJECT_ID` is set, the command prints the direct trace
URL before processing begins. The Copilot SDK receives the active W3C trace context and exports its
internal model/tool spans directly to Langfuse when no separate OTLP endpoint is configured.
Synthesis spans record `gen_ai.request.model` plus
`weavekit.mastermind.baml.operation = "synthesis"` so trace inspection shows the configured
override. Greenfield review `web_fetch` permission checks accept only absolute HTTPS URLs without
embedded credentials and record hashed diagnostics instead of raw hosts, paths, or query strings.
Repository-backed review sessions do not expose `web_fetch` at all.
Long-running review and BAML calls renew the work lease; the root work span accumulates lease
duration, heartbeat interval, renewal count, last renewal, and latest expiry attributes, while
only lost/error conditions emit terminal lease events. Transitions and Linear mutations still fail
closed if ownership is lost. Terminal failed work marks the root trace as an error and records
validation reasons in the trace output and append-only event metadata.

For the repository-local Langfuse instance:

```toml
LANGFUSE_PUBLIC_KEY = "pk-lf-..."
LANGFUSE_SECRET_KEY = "sk-lf-..."
LANGFUSE_BASE_URL = "http://localhost:3000"
LANGFUSE_PROJECT_ID = "cmqwb90vu0006t307hrbgpj74"
LANGFUSE_EXPORT_RAW = "false"
```

Keep `LANGFUSE_EXPORT_RAW` false unless ticket text, prompts, and model responses are approved for
retention. Mastermind still records operational identifiers, states, timings, decisions, and token
usage when raw export is disabled.

### Example: telemetry disabled

```bash
OTEL_SDK_DISABLED=true \
BAML_LOG=warn \
nub run council decision-council run --smoke --input examples/smoke-question.md --output runs/telemetry-disabled
```

### Verification

Capture structured progress logs while you run a smoke test:

```bash
BAML_LOG=warn \
OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318/v1/traces" \
LANGFUSE_PUBLIC_KEY="pk-lf-..." \
LANGFUSE_SECRET_KEY="sk-lf-..." \
nub run council decision-council run --smoke --input examples/smoke-question.md --output runs/telemetry-verify --log-format json \
  2> runs/telemetry-verify.stderr.log
```

Check for startup/export/shutdown failures in stderr (no matches is the healthy case):

```bash
grep -iE "telemetry startup failed|telemetry shutdown failed|otlp|langfuse|export" runs/telemetry-verify.stderr.log
```

Inspect the run-level JSONL events written by Weavekit:

```bash
grep -E '"type":"council\\.(run|round|persona|baml)\\.' runs/telemetry-verify.stderr.log
```

If Langfuse export is enabled, confirm the trace in Langfuse by filtering for service `weavekit` and span names such as `council-run`, `run.council.round`, and `run.council.baml.normalize`.

## Verify

```bash
nub run baml-generate
nub run test
nub run typecheck
nub run build
```

## Evaluating the Decision Council

Promptfoo is the system of record for repository evaluations. Every eval command
persists and prints its Promptfoo evaluation ID. Inspect completed runs primarily
with `nubx promptfoo view`, or list recent IDs with
`nubx promptfoo list evals -n 20`. Repository-owned JSON and Markdown reports are
deterministic projections of those persisted results, not a second evaluation path.
The shared runner adds the immutable `schemaVersion=1` tag to every evaluation and
disables Promptfoo caching unless a caller explicitly enables it.
To verify local persistence without calling a model, run
`nub run eval:promptfoo:smoke`.

`evals/corpus/*.yaml` holds open-ended technical _decision_ questions, each with a
detailed reference answer and a weighted rubric. The eval harness runs two
providers against every question — the Decision Council (`runDecisionCouncil`,
in-memory) and a vanilla `copilot -p` baseline (no extra prompting) — and grades
both with a reference-guided LLM judge via promptfoo.

```bash
# Grade every corpus item (council vs vanilla Copilot CLI):
nub run eval

# Grade specific items by id:
nub run eval -- orchestration-framework-001 data-store-001

# Run up to 4 promptfoo eval cells concurrently:
nub run eval -- --max-concurrency 4 orchestration-framework-001 data-store-001
```

Judge configuration (OpenAI-compatible) via env: `EVAL_JUDGE_BASE_URL`
(default `http://127.0.0.1:8080/v1`), `EVAL_JUDGE_API_KEY`, `EVAL_JUDGE_MODEL`.
Baseline model via `EVAL_COPILOT_MODEL` (default `auto`). Results are written to
`evals/results/<timestamp>/` (gitignored).

Eval concurrency defaults to `1` (fully sequential). Set `--max-concurrency <n>` or
`--concurrency <n>` (or `EVAL_MAX_CONCURRENCY`) to let promptfoo evaluate multiple
corpus cells in parallel. Keep values small: each Council cell fans out roughly 4+
Copilot SDK persona sessions, and each baseline cell starts a `copilot` CLI process,
so concurrency `N` can mean up to `N × personas` concurrent Copilot SDK sessions plus
`N` baseline processes against the local proxy.

### Source-to-project verification

The source-to-project benchmark compares the real weavekit advisory workflow with
Copilot CLI plan mode and Codex CLI read-only planning. Each provider receives an
isolated copy of a deliberately flawed full-stack todo app and the same stable
best-practices article. Each run creates linked Promptfoo generation and judge
evaluations. Generation collects one canonical plan per provider; an anonymous,
counterbalanced BAML panel (`gpt-5.5` and `claude-opus-4.8`) performs
evidence-backed absolute and pairwise judging. TypeScript validates and aggregates
the judgments deterministically. Provider execution, workspace mutation, judge
validity, plan quality, pairwise preference, and efficiency remain separate results.
The eval omits both visual-plan preflight and visual-design opportunity nodes because
those artifacts serve human review rather than plan-quality scoring.

```bash
# Run the three-provider benchmark:
nub run eval:source-to-project

# Run one immutable migration case:
nub run eval:source-to-project -- \
  --case evals/source-to-project/cases/eslint-to-oxlint.yaml

# Run the four-case, three-trial reliability acceptance matrix:
nub run eval:source-to-project -- \
  --matrix evals/source-to-project/matrix.yaml --trials 3

# Rejudge byte-identical stored plans without invoking any provider workflow:
nub run eval:source-to-project -- \
  --rejudge-from evals/source-to-project/results/<prior-run>

# Verify the live two-model judge against weak/medium/strong fixtures:
nub run eval:source-to-project:judge-calibration

# Require weavekit to improve by at least 0.02 over a prior run:
nub run eval:source-to-project -- \
  --baseline evals/source-to-project/results/<prior-run>/scores.json \
  --minimum-weavekit-delta 0.02
```

The command prints both Promptfoo evaluation IDs and writes them to `manifest.json`,
`scores.json`, and `summary.md` alongside `promptfoo-report.json`, raw
absolute/pairwise judgments, and per-provider plans under
`evals/source-to-project/results/<timestamp>/`. Rejudge verifies every SHA-256
digest, creates exactly one judge-only evaluation linked to the original generation
evaluation, and writes its projections below the unchanged source result in
`judge-replays/<timestamp>/`.
A failed provider, workspace mutation, invalid absolute judgment, or missed minimum
delta makes the command exit nonzero. Pairwise losses never mark generation failed;
ties, disputes, single-judge outcomes, and invalid comparisons are reported directly.

Every new Weavekit plan used by the matrix is compiled through a source-practice
ledger, project applicability matrix, coverage map, structured draft, semantic
audit, and at most one repair. Passing runs persist those linked JSON envelopes,
their SHA-256 input digests, the original Copilot transcript, and the final audited
Markdown at `raw-plans/plan-portfolio-full.md`. The matrix writes
`matrix-scorecard.json` and `matrix-summary.md`, with the linked generation/judge
evaluation-ID pair for every case/trial. It passes only when Weavekit beats
both Codex and Copilot on majority wins, positive mean quality margin, the per-case
deficit tolerance, and agreed pairwise reliability, with no invalid provider run,
invalid judge panel, or unaudited Weavekit plan. Median and p95 latency, tokens, and
cost are reported separately and never affect the quality gate. Judge-only replay
reuses frozen plans for calibration but does not replace the twelve paired generation
trials.

Judge calibration is one persisted Promptfoo judge evaluation covering all frozen
weak, medium, and strong fixtures; its command prints that evaluation ID.

The default provider models are `gpt-5.4` for Copilot and `gpt-5.3-codex` for
Codex. Override them with `PROJECT_VERIFICATION_COPILOT_MODEL` and
`PROJECT_VERIFICATION_CODEX_MODEL`. The fixed judge panel uses
`gpt-5.5` and `claude-opus-4.8` through
`PROJECT_VERIFICATION_JUDGE_BASE_URL` (default
`http://127.0.0.1:8080/v1`) and `PROJECT_VERIFICATION_JUDGE_API_KEY`. Judge requests
default to a five-minute timeout for long stored plans; override it with the positive
integer `PROJECT_VERIFICATION_JUDGE_TIMEOUT_MS`.
Baseline CLI plans default to low reasoning so the three-provider loop remains
bounded; set `PROJECT_VERIFICATION_REASONING_EFFORT` to override it.

### Router evals

A focused Promptfoo suite for the canonical Router workflow lives under
`evals/corpus/router/`. It exercises the full Router route taxonomy, including
direct answers, planning, research, decision council, goal prompts, prompt
refinement, local code changes, fleet delegation, source-to-project, and manual
Herdr worktree handoffs.

```bash
nub run eval:router
```

The run writes `report.json`, `router-summary.md`, `router-report.json`, and
`router-results.json` into `evals/results/router/<timestamp>/`.
