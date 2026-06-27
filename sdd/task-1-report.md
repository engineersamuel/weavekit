# Task 1 Report — Persona-aware normalize span names

Status: DONE

Commits created:
- 4afffd4 feat: name normalize spans by persona

One-line test summary:
- `nub run test -- tests/decision-council/bamlTelemetry.test.ts` ✅ and `nub run typecheck` ✅

What changed:
- Updated `src/decision-council/bamlTelemetry.ts` so normalize spans keep the `run.council...` prefix but are renamed to `run.council.baml.persona.<personaId>` when persona context is available.
- Kept non-normalize span names unchanged.
- Preserved all existing span attributes.
- Added tests covering persona-aware renaming, fallback naming when persona context is missing, and unchanged non-normalize spans.
- Tightened fallback/non-normalize test coverage so the conditional rename branch is exercised inside traced targets.

Concerns:
- None.

Report path:
- /Users/smendenhall/.baton/worktrees/weavekit/steady-elm/sdd/task-1-report.md

## Final fix follow-up

- Moved `createBamlTelemetryOptions(...)` calls into traced targets so the span-renaming branch now runs inside the active trace scope.
- Added a normalize fallback assertion with no persona context to prove the span name stays `run.council.baml.normalize`.
- Added report/assess coverage with `personaId: "skeptic"` to prove non-normalize span names remain unchanged.
- Verified with `nub run test -- tests/decision-council/bamlTelemetry.test.ts` and `nub run typecheck`.
