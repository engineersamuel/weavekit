# 0009 — Add the durable Mastermind control plane

Status: accepted

Weavekit will host an always-on application named **Mastermind**. Mastermind receives verified
Linear webhooks, durably owns ticket workflow state, reviews and augments tickets, and decides the
next bounded action. The initial release stopped after persisting that action. The accepted direct-execution amendment
below adds one fenced `IMPLEMENT_DIRECTLY` worker without changing Mastermind's ownership boundary.

Mastermind is a scoped exception to [ADR 0001](0001-no-durable-work-queue.md) and
[ADR 0002](0002-defer-rivet-keep-in-process-runs.md). Their in-process, finite-Run constraints
remain authoritative for `src/macro-workflow/`. They do not apply to `src/mastermind/`, whose
purpose requires work ownership, recovery, and reconciliation to outlive one process invocation.

## Decision

- Keep the repository and package named `weavekit`.
- Add `src/mastermind/` as a durable service boundary and `src/submind/` as a bounded internal
  delegation contract.
- Use Flue as the Node application and workflow host. Flue submission state is correlation data;
  it is not Mastermind's business-state authority.
- Use file-backed SQLite for one supervised process on one host. Hide persistence behind a store
  interface so a later multi-host deployment can adopt Postgres.
- Persist explicit current state plus append-only domain events. Do not make an XState actor
  snapshot the only durable record.
- Use XState for deterministic allowed transitions and guards.
- Model project context explicitly as an existing repository or a greenfield project. A greenfield
  project's provisioning root is not its repository; review exposes no local filesystem tools,
  creates no child directory, and relies on Linear or authoritative external evidence.
- Use a read-only frontier harness to inspect configured project and research evidence. Existing
  repositories expose purpose-built read tools but not a shell, and they do not fetch external URLs
  in that same agent session. External research remains available only in a separate no-local-
  filesystem trust boundary such as greenfield review mode. The harness cannot mutate Linear or
  repository files.
- Use BAML to synthesize the evidence dossier into a typed ticket patch and to recommend the next
  action. BAML cannot commit state transitions or execute external actions.
- Represent repository file, symbol, and search evidence as typed fields with repository-relative
  paths. Validate containment, readiness claims, scope changes, verification, and validation
  deterministically before mutation. Only Mastermind's narrow Linear gateway can write.
- Treat a stored review as structured control-plane input, not just a label. Review readiness,
  human-owned open items, executor-preflight gaps, and external dependencies must constrain
  `DecideNextAction` deterministically before any executor work is planned.
- Route `HUMAN` ownership and material scope changes to `NEEDS_HUMAN`. Route known
  `EXTERNAL_DEPENDENCY` blockers to `WAIT`. Do not misuse executor preflight to represent waiting
  on upstream systems the executor cannot control.
- After selecting an executor, run preflight inside that executor environment immediately before
  work starts. Preflight is fail-closed and verifies required tools, authentication, and pinned
  account context. Azure work must prove `az account show` matches the configured subscription
  and tenant; Mastermind must never switch subscriptions implicitly.
- Treat Linear title, description, labels, and status as human-facing projections and input
  signals. SQLite remains authoritative.
- Use separate reviewed, ready, needs-input, and review-failed labels.
- Invalidate an in-flight proposal when the Linear title, description, or labels change before
  mutation. Preserve invalidated proposals and their reasons in the append-only audit trail.
- Preserve the original Linear snapshot and the exact BAML mutation proposal before updating the
  ticket because the review may replace the full title and description.
- Emit one correlated OpenTelemetry trace per work-item processing attempt. Export it to Langfuse
  when credentials are configured, and nest Linear I/O, state transitions, harness execution,
  BAML generations, deterministic gates, and controlled mutation beneath the work trace.
- Keep raw ticket and model content redacted from Langfuse by default. Operational metadata,
  state, decisions, timings, errors, and token usage remain observable without raw-content export.
- Permit greenfield review-time `web_fetch` only for absolute HTTPS URLs without embedded
  credentials and log hashed diagnostics rather than raw URL content. Repository-backed review
  sessions do not expose `web_fetch`.
- Renew active leases during long harness and BAML calls. Lease renewal, transitions, and Linear
  mutations fail closed when ownership expires or moves to another instance. Aggregate lease
  renewal state on the root work span and emit dedicated events only for lost/error outcomes.

## First vertical slice

1. A verified Linear issue webhook is durably deduplicated.
2. Mastermind resolves project policy and claims the work item.
3. `DecideNextAction` recommends `REVIEW_TICKET` for an unreviewed ticket.
4. A read-only Copilot SDK or Trellage harness produces an evidence dossier using the
   `weavekit-ticket-review` skill.
5. `SynthesizeLinearTicketPatch` produces a typed title, description, readiness assessment,
   verification plan, validation plan, and evidence references.
6. Deterministic policy accepts the patch, routes it for human input, or fails it closed.
7. Mastermind persists the proposal, updates Linear, and applies controlled status labels.
8. The resulting update re-enters the loop.
9. `DecideNextAction` produces `IMPLEMENT_DIRECTLY`, `DELEGATE_SUBMIND`, `WAIT`,
   `NEEDS_HUMAN`, or `IGNORE`.
10. Mastermind persists the plan and stops. No executor launches.

## Reopen triggers

Move from SQLite to Postgres when more than one active Mastermind process or host must claim work.
Revisit executor architecture when Trellage/Herdr launch, cancellation, heartbeat, nested subminds,
or durable human approval becomes part of an implemented milestone.

## Consequences

Mastermind requires a supervised service lifecycle, health/readiness routes, graceful shutdown,
lease reconciliation, idempotent Linear mutation, project allowlists, structured audit events, and
tests that prove restart recovery. Existing macro workflows do not gain a cross-Run queue.

## Accepted amendment: durable direct execution

Mastermind may execute `IMPLEMENT_DIRECTLY` through one durable Herdr-backed Copilot attempt when
both global executor configuration and the resolved project policy explicitly opt in.
`DELEGATE_SUBMIND` and `WAIT` remain planned but unlaunched.

- `mastermind_execution_attempts` is Mastermind domain persistence, not a reusable durable queue.
  SQLite remains the single-host authority.
- Mastermind creates and fences the current Execution Attempt before any workspace or Herdr side
  effect. Attempt numbers increase monotonically, and stale attempts cannot change execution state
  or publish a result.
- Work-item leases remain short. The execution coordinator claims only one bounded phase at a time
  for provisioning, preflight, launch/adoption, status polling, collection, verification, or Linear
  projection. No lease or process-local trace remains open while the coding agent runs.
- Existing and greenfield projects both resolve or create a canonical parent Herdr repository
  workspace, then create or adopt one deterministic dedicated Git worktree. Greenfield provisioning
  creates only provenance metadata plus an empty seed commit before the agent runs.
- Herdr is the first Executor Adapter. It starts the canonical `copilot` harness in the worktree
  root pane with bounded unattended autopilot, all permissions enabled, and explicit deny policy.
  Live workspace, tab, and pane IDs are diagnostics only and are re-resolved from canonical paths
  after restart.
- Herdr lifecycle status is evidence, not success. `idle` or `done` enters collection; success
  requires a current-attempt result manifest, contained artifacts, executor verification, and
  independently rerun configured project validation commands.
- Prompt-dispatch ambiguity fails closed rather than resubmitting an implementation prompt.
  Cancellation remains best effort: Mastermind sends `ctrl-c` and reports confirmation only after
  Herdr observes `idle` or `done`.
- Executors cannot mutate Linear. Mastermind performs one idempotent terminal comment and label
  projection using an attempt marker, and never completes the issue, merges a pull request, or
  deploys.
- Execution observability uses separate short spans correlated by work ID and attempt ID. Raw
  prompts, ticket content, terminal output, environment values, and full paths are excluded.
