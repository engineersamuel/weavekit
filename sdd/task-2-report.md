# Task 2 Report — Decorator-based BAML tracing module

Status: DONE

Commits created:
- feat: add decorator-based baml tracing

One-line test summary:
- Ran `nub run typecheck && nub run test` — typecheck passed and 181 tests passed.

What I changed
- Added `src/decision-council/bamlTelemetry.ts` with `@TraceBamlOperation`, collector/tag helpers, and span enrichment for BAML usage metadata.
- Extended `BamlRouteOptions` in `src/decision-council/bamlRouting.ts` to allow `collector` and `tags`.
- Decorated BAML adapter methods in `src/decision-council/bamlAdapters.ts` and merged telemetry-backed collector/tag options into each BAML call.
- Added `tests/decision-council/bamlTelemetry.test.ts` plus adapter assertions in `tests/decision-council/bamlAdapters.test.ts`.

Verification
- RED: `nub run test -- tests/decision-council/bamlTelemetry.test.ts tests/decision-council/bamlAdapters.test.ts` failed before implementation because `bamlTelemetry.ts` did not exist and adapter calls passed no collector/tags.
- GREEN: the focused suite passed after implementation.
- Final: `nub run typecheck && nub run test` passed.

Concerns
- The brief references an `executeOperation` adapter seam, but the current tree has only public adapter methods; I applied the decorator at those method boundaries instead.

Follow-up fix report
- Captured BAML span args/result with plain `JSON.stringify()` and a 5KB per-attribute cap, truncating larger payloads.
- Routed `defaultRouteModelCall` through the traced BAML wrapper so the generated `RouteModelCall` runs inside an active span.
- Added coverage for bounded serialization plus RouteModelCall tracing.
- Verification: `nub run typecheck && nub run test` — both passed; 183 tests passed total.
