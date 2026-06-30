# Constrained Macro Workflow Planner

The constrained macro-workflow planner adds a deterministic implementation-review flow that can be planned, re-planned, and executed in-process.

## Capabilities

- Materializes a static implementation-review template.
- Uses a generated planner adapter for planning and bounded replanning.
- Verifies plan shape and patch validity before execution.
- Executes nodes in dependency order using a static harness registry.
- Writes a markdown report plus a JSON state file for each run.

## CLI

- `weavekit workflow plan --input <path> [--output <dir>] [--template <id>]`
- `weavekit workflow run --input <path> [--output <dir>] [--template <id>]`

`--input <path>` reads a plain text or Markdown file and uses its contents as the workflow objective/prompt input.

`--template <id>` selects a registered static workflow template. The current built-in template id is `implementation-review`.

## Planner schema reference

The planner contract is documented in [workflow_planner.md](./workflow_planner.md). That reference explains the `WorkflowNode`, `WorkflowPlan`, and `WorkflowReplanPatch` fields that the BAML planner emits and the runtime consumes.
