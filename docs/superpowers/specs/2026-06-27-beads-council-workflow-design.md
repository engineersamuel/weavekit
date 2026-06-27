# Beads-Generated Decision Council Workflow Design

## Goal

Add an explicit `--create-beads-workflow` mode for Decision Council runs. In this mode, Weavekit creates a small Beads workflow DAG for the council run, runs the council under the generated `run-council` work item, attaches the whole DAG to the Langfuse root trace, and leaves human review/follow-up work visible in Beads.

## User-facing behavior

The new command shape is:

```bash
nub run council decision-council run \
  --input examples/design-question.md \
  --create-beads-workflow
```

When `--create-beads-workflow` is supplied:

1. Weavekit creates a Beads workflow for the input decision question.
2. The workflow contains four ordered items:
   - `frame-question`
   - `run-council`
   - `review-report`
   - `implement-next-experiment`
3. The generated `run-council` item is claimed before the council run.
4. The existing `runDecisionCouncil(...)` execution remains unchanged.
5. The root `council-run` Langfuse trace includes the whole generated Beads DAG.
6. On success, Weavekit closes only the `run-council` item with the report path and recommendation.
7. `review-report` and `implement-next-experiment` remain open for human/agent follow-up.

Existing behavior remains:

- `--work-item <id>` attaches the run to an existing Beads item.
- Runs without `--work-item` or `--create-beads-workflow` do not create or touch Beads.
- Lifecycle flags such as `--close-work-item`, `--create-follow-up-work-item`, and `--sync-work-queue` continue to apply only to explicit attachment mode unless a specific generated-workflow behavior is defined here.

`--work-item <id>` and `--create-beads-workflow` are mutually exclusive. Supplying both is a CLI error.

## Architecture

Keep `runDecisionCouncil(...)` as the core execution module. It should continue to accept optional work queue context, emit telemetry, write artifacts, and return `DecisionCouncilReport`.

Add a new orchestration module at the Beads seam:

```ts
type DecisionCouncilBeadsWorkflow = {
  rootItem: WorkItem;
  runItem: WorkItem;
  reviewItem: WorkItem;
  followUpItem: WorkItem;
  items: WorkItem[];
};

async function createDecisionCouncilBeadsWorkflow(args: {
  backend: WorkQueueBackend;
  title: string;
  inputPath?: string;
}): Promise<DecisionCouncilBeadsWorkflow>;
```

This module owns the knowledge of the generated DAG shape. Callers should not need to know Beads CLI flags, dependency strings, or item creation order.

The CLI becomes the coordinator:

1. Parse `--create-beads-workflow`.
2. Build a `BeadsCliWorkQueue`.
3. Create the workflow through `createDecisionCouncilBeadsWorkflow(...)`.
4. Pass the generated `runItem.id` into `runDecisionCouncil(...)` as `workQueue`.
5. Pass the full generated DAG as telemetry context so Langfuse can show the whole workflow.

## Beads DAG shape

Use Beads items instead of internal council steps:

```text
frame-question
  -> run-council
  -> review-report
  -> implement-next-experiment
```

Dependencies:

- `run-council` waits for `frame-question`.
- `review-report` waits for `run-council`.
- `implement-next-experiment` waits for `review-report`.

Item descriptions should include enough context for humans and agents:

- `frame-question`: input path and prompt summary.
- `run-council`: command intent and output directory.
- `review-report`: where to review the Decision Council report.
- `implement-next-experiment`: open follow-up item that depends on report review and can be edited after the council report identifies the next experiment.

Do not create one Beads item per persona, round, normalization, or BAML call. Those are runtime execution details and remain in `DecisionCouncilRunState.json`, debug artifacts, and Langfuse child observations.

## Langfuse telemetry

Extend the existing Beads telemetry helper so a root trace can include a full workflow DAG, not just the active item.

Add a serialized metadata field:

- `langfuse.trace.metadata.beads.workflow_dag`

The serialized DAG should include:

```ts
type WorkItemDag = {
  rootItemId: string;
  activeItemId: string;
  items: Array<{
    id: string;
    title: string;
    status: WorkItem["status"];
    type: WorkItem["type"];
    priority: number;
    labels: string[];
    dependencies: WorkItem["dependencies"];
  }>;
};
```

The existing root metadata remains:

- `langfuse.trace.metadata.beads.item_id`
- `langfuse.trace.metadata.beads.item_title`
- `langfuse.trace.metadata.beads.dag`

In generated workflow mode, `item_id` and `item_title` refer to the active `run-council` item. `workflow_dag` contains all generated items.

Lifecycle observations remain child spans:

- `work-queue.beads.claim`
- `work-queue.beads.close`
- `work-queue.beads.sync`

The generated workflow creation should also emit child observations:

- `work-queue.beads.create-workflow`
- `work-queue.beads.create-workflow-item`

## Error handling

Workflow creation is all-or-visible, not atomic. If an item creation fails, Weavekit should surface the `WorkQueueBackendError` with the underlying stdout/stderr details already used by the CLI error formatter.

If the workflow is created but the council run fails:

- The `run-council` item should not be closed.
- The Langfuse root trace should be marked failed by existing Decision Council error handling.
- The generated Beads items remain available for inspection and manual recovery.

If the council succeeds but closing `run-council` fails:

- The CLI should surface the Beads lifecycle failure.
- The report artifacts remain written.
- This mirrors the current lifecycle behavior and can be improved later with idempotent completion semantics.

## Testing

Use test-driven development.

Required tests:

1. CLI parsing rejects `--work-item <id>` with `--create-beads-workflow`.
2. CLI parsing accepts `--create-beads-workflow`.
3. Workflow creation creates the four items with the expected dependency chain.
4. Generated workflow mode runs the council using the generated `run-council` item id.
5. Generated workflow mode attaches `workflow_dag` metadata to the root Langfuse trace.
6. Failure during workflow creation surfaces a `WorkQueueBackendError` and does not run the council.
7. Existing attach mode with `--work-item <id>` still works.
8. Runs without Beads flags still avoid Beads.

## Documentation

Update `docs/beads.md` and `README.md` with:

- how to run `--create-beads-workflow`,
- how it differs from `--work-item <id>`,
- what Beads items are created,
- what appears in Langfuse,
- how to inspect generated work with `nub run council work ready` and `nub run council work show <id>`.

## Non-goals

- No automatic Beads creation unless `--create-beads-workflow` is supplied.
- No replacement of `runDecisionCouncil(...)`.
- No Rivet integration.
- No full Beads molecule/formula support unless the existing `WorkQueueBackend` can support it cleanly.
- No Beads item per internal council/persona/BAML operation.
