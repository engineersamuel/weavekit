# Council Compact Summaries Design

## Goal

Make compact Design Council progress logs more useful by adding one concise, indented persona summary after each successful BAML normalization, and by making round fan-out/fan-in behavior explicit in the round-start logs.

## Current Behavior

The CLI emits compact progress events for run, round, persona, BAML, artifact, and completion phases. A completed normalization line currently shows timing and identifiers but not what the persona concluded:

```text
[2026-06-24T19:42:21.962Z] baml completed round=1 persona=pragmatic operation=normalize duration=4.5s
```

The council round model is shared, not one-to-one. Round 1 uses the initial critique brief. After each round, the Judge assesses all normalized critiques from that round together and may produce a single `nextRoundBrief`. The next round sends that same shared brief to every persona, then fan-ins all current-round normalized critiques back to the Judge.

## Design

### Persona Summary Contract

Extend the normalized `PersonaCritique` contract with:

```ts
overallSummary: string;
```

The BAML `PersonaCritique` class should include `overallSummary string`. The `NormalizePersonaCritique` prompt should describe it as one short sentence for CLI progress that summarizes the persona's overall stance, conclusion, or decision. This field is part of the normalized critique because the summary should be generated from the validated BAML interpretation rather than raw persona text.

### Pretty Logging

When a `council.baml.completed` event for `operation=normalize` includes `summary`, pretty logging should render a second indented child line:

```text
[2026-06-24T19:42:21.962Z] baml completed round=1 persona=pragmatic operation=normalize duration=4.5s
    -> Pragmatic persona has significant concerns and recommends a minimal validation spike before adopting Flue/BAML.
```

The main event line stays compact. The child line is only emitted for successful normalization events with a non-empty summary.

### JSON Logging

JSON logging should keep the summary on the same event object:

```json
{"type":"council.baml.completed","operation":"normalize","personaId":"pragmatic","summary":"Pragmatic persona has significant concerns and recommends a minimal validation spike before adopting Flue/BAML."}
```

No separate summary event is needed.

### Round Clarity

Round-start events should expose whether the round focus is the initial brief or a shared Judge brief. Pretty logs should render an indented child line such as:

```text
[2026-06-24T19:42:34.757Z] round started round=2 focus="Produce a concrete v0 plan..."
    -> Shared Judge brief from round 1; all personas respond to this focus, then the Judge assesses the round 2 set together.
```

This only clarifies existing behavior. It must not change the orchestration algorithm.

## Files to Update

- `baml_src/council.baml`: add `overallSummary` to `PersonaCritique` and update the normalization prompt.
- `src/council/types.ts`: add `overallSummary` to `PersonaCritiqueSchema`.
- `src/council/workflow.ts`: attach normalized critique summaries to successful normalization completion events; add round-start source metadata.
- `src/council/logger.ts`: format optional summary and round-context child lines for pretty output; include fields unchanged in JSON output.
- `tests/council/logger.test.ts`: cover indented summary and round-context formatting.
- `tests/council/runner.test.ts` and other critique fixtures: add `overallSummary` values.
- Generated BAML client files: regenerate after schema changes.
- `README.md`: document that rounds use a shared Judge brief and that normalize completion logs include concise persona summaries.

## Non-Goals

- Do not add another BAML summarizer call.
- Do not summarize raw persona output before normalization.
- Do not change persona scheduling, Judge assessment, or round continuation behavior.
- Do not build a custom UI for this change.

## Acceptance Criteria

- Pretty logs show one concise indented summary after each successful BAML normalization.
- Pretty logs explain that round 2+ uses a shared Judge brief from the previous round.
- JSON logs include the same summary and round-source metadata as structured fields.
- `CouncilRunState.json` includes `overallSummary` inside each normalized critique.
- Tests, typecheck, build, and BAML generation pass.
