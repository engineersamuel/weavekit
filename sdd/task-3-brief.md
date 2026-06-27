# Task 3: Emit run-level OTEL spans and map logger events

## Scope

Add run-level tracing to the Decision Council runner to create a root OTEL span for each run and map internal logger events into OTEL events so the full execution trace is captured.

## Context from earlier tasks

- Task 1: Telemetry bootstrap module (src/telemetry/bootstrap.ts) initializes OTEL SDK + Langfuse processor with guarded startup/shutdown
- Task 2: Decorator-based BAML tracing (@TraceBamlOperation) automatically traces BAML operations with collector metadata
- Task 3: You now add run-level tracing so individual BAML spans nest under a root council span

## Acceptance criteria

1. Create `src/decision-council/otelLogger.ts` implementing an OTEL-based logger adapter that maps Decision Council logger events into OTEL log events (OTEL Events API or Logs API)
2. Modify `src/decision-council/runner.ts` to:
   - Create a root OTEL span at the start of each council run
   - Use the otelLogger adapter to emit all logger events as OTEL events within that span scope
   - Close the root span when the run completes or fails
3. Add tests covering:
   - Root span creation and closure
   - Logger event → OTEL event mapping
   - Span hierarchy (root span → BAML decorator spans)
   - Error propagation (root span captures run errors)
4. All tests pass (`nub run test`)
5. All types check (`nub run typecheck`)
6. No breaking changes to Decision Council runner behavior
7. Existing logger behavior preserved (otelLogger is additive, doesn't replace)

## Implementation guidance

- **OTEL span context**: Use `context.with()` or AsyncLocalStorage to manage active span context
- **Logger events**: Map `logger.debug/info/warn/error` to OTEL event attributes (`level`, `message`, `timestamp`)
- **Span lifecycle**: Root span covers the entire `runCouncil(...)` call (from start to completion/error)
- **Backward compatibility**: Logger can emit to both console/file and OTEL simultaneously
- **Type safety**: Use existing TypeScript types for logger calls; no `any` casts for OTEL API

## Files to create/modify

- **Create**: src/decision-council/otelLogger.ts (logger adapter)
- **Create**: tests/decision-council/otelLogger.test.ts (logger tests)
- **Modify**: src/decision-council/runner.ts (add root span and use otelLogger)
- **Modify**: tests/decision-council/runner.test.ts (add span hierarchy tests)

## What success looks like

- Root span is created with name `council-run` and captures all BAML calls as nested spans
- Logger events appear as OTEL events within the active span
- Existing runner tests still pass (no breaking changes)
- New tests confirm span hierarchy and event mapping
- Full telemetry chain: telemetry bootstrap → root council span → BAML spans → logger events

## Why this matters

The root span creates the top-level trace envelope for a council run. All BAML operations (from Task 2) nest under this span. Mapped logger events provide observability into decision logic, model routing, and persona selection within the trace. Together, all three tasks (bootstrap, BAML decorator, run-level spans) form a complete telemetry picture for debugging and auditing Decision Council execution.
