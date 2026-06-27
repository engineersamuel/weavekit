# Task 1 Report — Telemetry bootstrap (OTEL + Langfuse)

Status: DONE

Commits created:
- 4dcaddd feat: add otel bootstrap and cli lifecycle wiring

One-line test summary:
- Ran focused tests: 2 tests passed (tests/telemetry/bootstrap.test.ts)

What I changed
- Added src/telemetry/bootstrap.ts implementing startTelemetry, telemetryEnabled, and TelemetryHandle. It starts an OpenTelemetry NodeSDK with optional OTLP exporter and optional LangfuseSpanProcessor when LANGFUSE_* env vars are present. When OTEL_SDK_DISABLED=true the module returns a noop shutdown handle.
- Wired telemetry startup/shutdown into src/cli.ts main() so the CLI lifecycle starts telemetry before running Decision Council and always shuts it down in a finally block.
- Added tests/tests/telemetry/bootstrap.test.ts covering disabled and enabled flows.

Test & Typecheck
- Ran: `nub run test -- tests/telemetry/bootstrap.test.ts` — both tests passed.
- Ran: `nub run typecheck` (tsc --noEmit) — no TypeScript errors.

Notes and verification steps
- The tests intentionally avoid requiring external OTEL or Langfuse servers by exercising the enabled/disabled behavior and by setting OTEL_EXPORTER_OTLP_ENDPOINT to a local URL only to ensure exporter creation does not throw during startup. The tests call shutdown to ensure the returned handle resolves correctly.
- The implementation uses conservative any casts around OpenTelemetry and Langfuse types to avoid strict type coupling with runtime shapes; these are safe because the project's package.json already includes the required dependencies.

Concerns
- Runtime: The Langfuse SDK import (LangfuseSpanProcessor, isDefaultExportSpan) assumes @langfuse/otel v5.9.0 exports those symbols; if upstream changes exports, runtime failures could occur. Tests did not exercise Langfuse paths because LANGFUSE_* env vars were not set.
- Behavior: startTelemetry eagerly calls sdk.start(); if there are long start hooks this could slow CLI startup. This matches the brief but could be deferred in future.

Next steps (optional)
- Add integration tests that set LANGFUSE_* env vars in a controlled sandbox or mock the Langfuse module to assert processor behavior.
- Consider graceful logging around telemetry startup failures so CLI still runs even if telemetry init throws.

Report path:
/Users/smendenhall/.baton/worktrees/weavekit/steady-elm/sdd/task-1-report.md

## Fix follow-up

- Fixed the Langfuse bootstrap against the v5.9.0 API by relying on the exported `LangfuseSpanProcessor` and `isDefaultExportSpan` symbols, and by passing `publicKey`, `secretKey`, and `baseUrl` explicitly into the processor.
- Added `LANGFUSE_EXPORT_RAW` gating so raw prompt/response export is masked by default and only enabled when `LANGFUSE_EXPORT_RAW=true`.
- Replaced `any`-typed NodeSDK/spanProcessor wiring with typed `SpanProcessor[]` and `ConstructorParameters<typeof NodeSDK>[0]`.
- Tightened test cleanup by restoring env state after each test and covering both default-redaction and explicit raw-export paths.

Verification:
- `nub run test -- tests/telemetry/bootstrap.test.ts`
- `nub run typecheck`

## Important findings follow-up

- Hardened Langfuse masking so structured payloads are redacted too when `LANGFUSE_EXPORT_RAW` is not `true`; this prevents object/array span attributes from leaking raw content.
- Wrapped telemetry shutdown in `src/cli.ts` with a try/catch so shutdown failures are logged but do not override the CLI's original success/failure status.

Verification:
- `nub run test -- tests/telemetry/bootstrap.test.ts tests/cli-main.test.ts`
- `nub run typecheck`
