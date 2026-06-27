# Beads Incident-Triage Demo Design

## Goal

Create a small, runnable example that demonstrates how Weavekit can use Beads to plan and execute a three-step workflow. The example should feel like a real queue-driven task, but remain contrived and lightweight enough to live as an integration test plus documentation.

The chosen scenario is an incident-triage drill:

1. Reproduce the bug.
2. Isolate the root cause.
3. Add a regression test.

Each step becomes its own Beads item, and each later item depends on the earlier one.

## Scope

This example should add a single, focused demo surface:

- A test-backed scenario that seeds 3 Beads items with dependencies.
- A deterministic execution path that claims, runs, and closes each item in order.
- A short docs update describing the scenario and how to run it.

It should not add a new production CLI command or a new Beads abstraction layer.

## Non-goals

- No new workflow runtime.
- No new Beads API wrapper beyond the existing adapter.
- No real bug tracker integration.
- No auto-generated demo content outside the scenario itself.

## Architecture

The example should reuse the existing `WorkQueueBackend` seam and the Beads CLI adapter.

The demo has three layers:

1. **Fixture/setup layer** — creates three Beads items and their dependency chain.
2. **Execution layer** — uses the existing work-queue flow to list ready items, claim them, and close them with a reason.
3. **Verification layer** — asserts that Beads unlocks the next item only after the prior item closes, and that the final queue is empty.

This keeps the example close to the real integration path without teaching a second way to use Beads.

## Components

### 1. Scenario fixture

A small fixture should define the three work items:

- `reproduce-incident`
- `find-root-cause`
- `add-regression-test`

Dependencies:

- `find-root-cause` depends on `reproduce-incident`
- `add-regression-test` depends on `find-root-cause`

The fixture should also define stable titles and close reasons so the test can assert on exact behavior.

### 2. Runner test

Add one integration-style test that:

1. Seeds the three items.
2. Calls `ready` and sees only `reproduce-incident`.
3. Claims and closes that item.
4. Calls `ready` again and sees `find-root-cause`.
5. Repeats for the final item.
6. Verifies the flow closes all three items in order.

If the test harness cannot seed real Beads state, it should use the existing `BeadsCliWorkQueue` runner seam with a command runner stub that records the issued commands and returns canonical Beads-shaped JSON.

### 3. Documentation

Update `docs/beads.md` with a short “Incident-triage demo” section that explains:

- what the 3 items represent,
- how the dependency chain works,
- what the test proves,
- and why this is a good example of Beads + Weavekit cooperation.

## Data flow

1. The scenario starts with three Beads items already created.
2. Beads `ready` returns only the first item because the others are blocked.
3. Weavekit claims the first item, performs the demo step, and closes it.
4. Beads unlocks the next item.
5. The process repeats until all three items are closed.

The important behavior is not the content of each step; it is that Beads is responsible for queue order while Weavekit is responsible for execution.

## Error handling

The example should fail loudly if:

- the Beads adapter emits malformed JSON,
- the dependency chain is not respected,
- or a later item becomes ready before its prerequisite is closed.

The test should surface those failures as ordinary test failures rather than retrying or silently skipping items.

## Testing

Add a focused test that covers:

- the exact Beads command sequence,
- the dependency chain,
- and the final closure of all three items.

If a docs example is added, keep it in sync with the test scenario so the names and order match exactly.

## Acceptance criteria

- The repo contains one runnable Beads incident-triage demo scenario.
- The scenario uses exactly 3 contrived items.
- The dependency chain is visible and enforced.
- The example is backed by a test.
- The docs explain how the demo works in plain language.
- No new production CLI surface is required.
