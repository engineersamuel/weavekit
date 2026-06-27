# Task 3 report

## Status

Completed.

## What changed

- Added `src/decision-council/otelLogger.ts` to map council logger events onto OTEL span events and to compose logger sinks.
- Updated `src/decision-council/runner.ts` to create a root `council-run` span, mirror run events into OTEL, and record success/error span status.
- Added `tests/decision-council/otelLogger.test.ts` for logger-to-OTEL mapping.
- Extended `tests/decision-council/runner.test.ts` with root-span lifecycle, nested BAML span, and failure-capture coverage.

## Assumptions made

- Used `tracer.startActiveSpan()` for run-level context propagation and assumed Task 2 decorator spans will nest under the active root span when telemetry is initialized.
- Mapped logger event severity as:
  - `*.failed` → `error`
  - persona/BAML start+complete events → `debug`
  - all other events → `info`
- Emitted OTEL event attributes for `level`, `message`, `timestamp`, plus all defined logger event fields.

## Verification

- `nub run test`
- `nub run typecheck`
