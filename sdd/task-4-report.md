# Task 4 report

Status: DONE_WITH_CONCERNS

## Changes made
- Added a `Telemetry and Observability` section to `README.md` covering OTEL and Langfuse environment variables, enabled/disabled run examples, and verification commands.
- Added a CLI test in `tests/cli-main.test.ts` that asserts the README documents the required telemetry configuration and verification guidance.

## Validation
- `nub run test` ✅ — 30 test files passed, 190 tests passed.
- `nub run typecheck` ✅
- `nub run build` ✅ (`baml-cli generate` + TypeScript compile succeeded)
- Proxy health check ✅ — `curl -fsS http://127.0.0.1:8080/health`

## Concern
- `OTEL_SDK_DISABLED=true BAML_LOG=warn nub run council decision-council run --smoke --input examples/smoke-question.md --output runs/task4-smoke` ❌
- Root cause: the `council` script runs `tsx src/cli.ts`, and Nub's tsx transpiler currently errors on Stage 3 decorators used in `src/decision-council/bamlAdapters.ts` (`Nub: Stage 3 decorators are not supported by the transpiler yet`).
- This appears to predate Task 4 and is coupled to the decorator-based telemetry introduced earlier, not to the documentation/test changes in this task.
