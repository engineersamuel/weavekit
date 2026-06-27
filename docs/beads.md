# Beads Work Queue Integration

## Decision

Weavekit treats Beads as an optional external work queue, not as the workflow runtime state store.

- Beads owns work items, dependencies, ready queues, formulas, molecules, gates, and Dolt sync.
- Weavekit owns workflow execution, typed run state, BAML fan-in contracts, reports, and debug artifacts.
- Flue remains the workflow hosting/connector seam for long-running or externally triggered workflows.

## Why this shape

This keeps the weavekit interface deep. Callers can use `WorkQueueBackend` without learning Beads CLI flags,
Dolt remotes, server mode, formula search paths, or JSON output details. The Beads adapter localizes that
knowledge in `src/work-queue/beads.ts`.

## Setup

Install Beads from its upstream instructions, then initialize it manually:

```bash
bd init --stealth
```

Use `--stealth` so Beads does not rewrite repository agent instruction files during local experimentation.
The repository ignores `.beads/` and `.beads-wisp/`; sync shared work through Dolt remotes using Beads
commands such as `bd dolt push` and `bd dolt pull`.

## Command mapping

| Weavekit command | Beads command |
| --- | --- |
| `weavekit work ready` | `bd ready --json` |
| `weavekit work show <id>` | `bd show <id> --json` |
| `weavekit work claim <id>` | `bd update <id> --claim --json` |
| `weavekit work create ...` | `bd create ... --json` |
| `weavekit work close <id> --reason ...` | `bd close <id> --reason ... --json` |
| `weavekit work sync` | `bd dolt push` |

## Workflow fit

Use Beads for queue selection and dependency-aware orchestration around weavekit runs:

1. A human or agent creates a Beads issue for a decision or workflow.
2. `bd ready` decides what is unblocked.
3. `weavekit decision-council run --work-item <id> --claim-work-item` claims the item before running.
4. The Decision Council writes its normal artifacts.
5. `--close-work-item` closes the source item with a report reference.
6. `--create-follow-up-work-item` creates one `discovered-from` work item from the report's next experiment.
7. `--sync-work-queue` runs `bd dolt push`.

Do not store every persona response, round brief, or BAML call as a Beads item. Those are workflow execution
state and already live in `DecisionCouncilRunState.json` plus debug artifacts.

### Generated workflow mode

Use `--create-beads-workflow` when you want Weavekit to create the Beads DAG for a new Decision Council run:

```bash
nub run council decision-council run \
  --input examples/design-question.md \
  --create-beads-workflow
```

This creates four Beads items:

1. `frame-question`
2. `run-council`
3. `review-report`
4. `implement-next-experiment`

The council runs under the generated `run-council` item. Langfuse receives `langfuse.trace.metadata.beads.workflow_dag` with all generated items. Use `--work-item <id>` instead when you already have a Beads item and only want to attach a run to it.

## Langfuse trace visualization

When Langfuse export is configured and a run supplies `--work-item <id>`, Weavekit reads the source Beads item and annotates the root `council-run` trace with:

- `langfuse.trace.metadata.beads.item_id`
- `langfuse.trace.metadata.beads.item_title`
- `langfuse.trace.metadata.beads.dag`

Lifecycle calls appear as child observations:

- `work-queue.beads.claim`
- `work-queue.beads.create-follow-up`
- `work-queue.beads.close`
- `work-queue.beads.sync`

The existing Decision Council, persona selector, persona, and BAML spans remain nested beneath the same trace. In Langfuse, filter by service `weavekit`, trace name `council-run`, or metadata `beads.item_id`.

## Formula example

Use a Beads formula when a repeatable weavekit workflow needs a dependency graph:

```toml
formula = "weavekit-decision-review"
description = "Frame, run, review, and follow up on a Decision Council question"
version = 1
type = "workflow"

[vars.topic]
required = true

[[steps]]
id = "frame-question"
title = "Frame decision question: {{topic}}"
type = "human"

[[steps]]
id = "run-council"
title = "Run Decision Council for {{topic}}"
needs = ["frame-question"]

[[steps]]
id = "review-report"
title = "Review Decision Council report for {{topic}}"
needs = ["run-council"]
type = "human"

[[steps]]
id = "capture-follow-up"
title = "Create follow-up work from next experiment"
needs = ["review-report"]
```

## Gate example

Use a human gate for explicit approval before an automated follow-up:

```toml
formula = "weavekit-gated-follow-up"
version = 1
type = "workflow"

[[steps]]
id = "run-council"
title = "Run Decision Council"

[[steps]]
id = "approval"
title = "Approve next experiment"
needs = ["run-council"]
type = "human"

[steps.gate]
type = "human"
approvers = ["owner"]

[[steps]]
id = "implement-next-experiment"
title = "Implement approved next experiment"
needs = ["approval"]
```

## Non-goals

- No Beads requirement for normal weavekit library usage.
- No automatic `bd init`.
- No automatic network sync unless `--sync-work-queue` is supplied.
- No replacement of Flue durability.
- No replacement of `DecisionCouncilRunState.json`.

## Incident-triage demo

This repo includes a small triage drill that demonstrates Beads queue ordering while Weavekit executes work.

The scenario always uses exactly three contrived items:

1. `reproduce-incident`
2. `find-root-cause`
3. `add-regression-test`

The dependency chain is linear: `find-root-cause` waits for `reproduce-incident`, and
`add-regression-test` waits for `find-root-cause`.

The integration test seeds the three items, repeatedly calls `ready`, then claims and closes the one
ready item at each step. With the deterministic test runner, this verifies the expected
ready -> claim -> close ordering and the adapter command sequence, without asserting anything about
Beads enforcing the queue itself.

This is a good Beads + Weavekit example because it uses the real `WorkQueueBackend` seam and Beads CLI
adapter behavior without introducing a separate runtime or a new production command surface.
