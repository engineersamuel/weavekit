# Workflow Planner Reference

The workflow planner BAML contract in `baml_src/workflow_planner.baml` defines the shape of generated macro-workflow DAGs and the bounded replanning patches used to recover from failures.

## Schema overview

- `WorkflowNode` describes one node in the DAG.
- `WorkflowPlan` describes the full plan for a workflow run.
- `WorkflowReplanPatch` describes a patch that replaces the remaining nodes of a plan after a bounded replan.

## WorkflowNode fields

| Field | Description | Typical values |
| --- | --- | --- |
| `id` | Stable identifier used by dependency edges, execution state, and replans. | `research`, `council`, `implement`, `verify` |
| `kind` | Semantic role of the node. | `research`, `deliberation`, `implementation`, `verification`, `visualization` |
| `harness` | Harness or executor that should run the node. | `research`, `decision-council`, `copilot-sdk`, `verifier`, `reporter` |
| `title` | Short human-readable title for the node. | `Research logging context`, `Run verification` |
| `prompt` | Instruction or task prompt passed to the selected harness. | Free-form task instruction |
| `dependsOn` | IDs of prerequisite nodes that must finish first. | `[]`, `['research']`, `['implement']` |
| `gates` | Automated gate kinds that should be enforced or required. | `output-contract`, `review-accepted`, `verification` |
| `writeMode` | Whether the node is read-only or the single writer for implementation work. | `read-only`, `single-writer` |
| `replanPolicy` | Policy controlling whether the node can trigger bounded replanning after a failure. | `never`, `on-contract-failure`, `on-review-rejection`, `on-verification-failure` |

## WorkflowPlan fields

| Field | Description |
| --- | --- |
| `id` | Stable identifier for the generated workflow plan. |
| `objective` | High-level objective supplied by the caller. |
| `templateId` | Template identifier used to constrain the plan, such as `implementation-review`. |
| `maxReplans` | Maximum number of bounded replans allowed while executing the plan. |
| `nodes` | The ordered DAG nodes that make up the workflow plan. |

## WorkflowReplanPatch fields

| Field | Description |
| --- | --- |
| `reason` | Explanation for why the remaining portion of the plan is being replaced. |
| `replaceRemainingNodeIds` | IDs of the remaining nodes that should be replaced by the patch. |
| `newNodes` | Replacement nodes that should be inserted for the remaining portion of the workflow. |
