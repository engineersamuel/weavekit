# Glueplane Decision Council Rename Design

## Goal

Rename the project from Weavekit to Glueplane and rename the v0 workflow from Design Council to Decision Council. Glueplane is the project/package/CLI name; Decision Council is the first workflow. The product promise is generic decision support: helping a user think through problems, tradeoffs, risks, and next experiments. This is an intentional breaking rename, not a compatibility migration.

The workflow can still handle design and architecture questions, but the default framing should be broader than design review.

## Scope

This change should rename the active product surface end to end:

- Project/product name: `Weavekit` becomes `Glueplane`.
- Package, binary, and command examples: `weavekit` becomes `glueplane`.
- User-facing prose: `Design Council` becomes `Decision Council`.
- Public TypeScript API: `CouncilInput`, `CouncilReport`, `CouncilRunState`, `runCouncil`, and `createCouncilWorkflow` become `DecisionCouncil*` or `runDecisionCouncil` names.
- Source layout: `src/council/*` becomes `src/decision-council/*`.
- CLI: `weavekit council run` becomes `glueplane decision-council run`.
- npm script: `npm run council` becomes `npm run decision-council`.
- Artifacts: `CouncilReport.md` and `CouncilRunState.json` become `DecisionCouncilReport.md` and `DecisionCouncilRunState.json`.
- BAML contracts and functions use Decision Council names.
- Logs/events use consistent decision-council naming.
- Tests and active examples use the new command, artifacts, and terminology.

Historical design and plan documents can be updated when they are copied into active usage docs, but they do not need to be renamed or rewritten solely to erase history. Active specs/plans for this current rename should use Glueplane.

## Non-goals

- Do not keep a `council` CLI alias.
- Do not keep old artifact filenames.
- Do not introduce a second workflow beside the old one.
- Do not change persona behavior, round scheduling, BAML validation policy, or stop policy as part of the rename.
- Do not broaden Glueplane into a general workflow framework beyond the current Decision Council surface.

## Architecture

The external seam stays intentionally small, but gets renamed:

```ts
runDecisionCouncil(input: DecisionCouncilInput, options?: RunDecisionCouncilOptions): Promise<DecisionCouncilReport>
```

The implementation remains the same finite fan-out/fan-in workflow:

1. Build an initial decision brief from user input.
2. Fan out to Copilot SDK persona sessions.
3. Normalize each persona response through BAML.
4. Fan in to the Judge reducer.
5. Continue with one shared Judge brief or stop.
6. Write a decision-ready Markdown report and typed JSON state.

The rename should make the module easier to understand by matching the product purpose. `DecisionCouncil` is the workflow name; `persona`, `round`, `judge`, `brief`, and `artifact` remain implementation concepts inside it.

## Components

### Public exports

`src/index.ts` should export the renamed public API only:

- `runDecisionCouncil`
- `createDecisionCouncilWorkflow`
- `DecisionCouncilInput`
- `DecisionCouncilReport`
- `DecisionCouncilRunState`
- `RunDecisionCouncilOptions`
- `DecisionCouncilWorkflowDeps`

No deprecated `Council*` aliases should remain because the user-facing choice is to break compatibility now.

### CLI

The CLI parser should accept:

```bash
glueplane decision-council run --input examples/decision-question.md --output runs/example
```

The old `council run` command should fail with the normal usage error. Success output should point to `DecisionCouncilReport.md`.

### BAML contracts

Rename BAML types/functions so generated TypeScript matches the product language:

- `PersonaCritique` -> `DecisionPersonaCritique`
- `PersonaFailure` -> `DecisionPersonaFailure`
- `RoundAssessment` -> `DecisionRoundAssessment`
- `CouncilReport` -> `DecisionCouncilReport`
- `NormalizePersonaCritique` -> `NormalizeDecisionPersonaCritique`
- `AssessCouncilRound` -> `AssessDecisionCouncilRound`
- `CreateCouncilReport` -> `CreateDecisionCouncilReport`

Prompts should describe a Decision Council and a decision-ready report. The final Markdown report should start with `# Decision Council Report`.

### Artifacts

Artifact writing should emit:

- `DecisionCouncilReport.md`
- `DecisionCouncilRunState.json`
- raw transcript/debug artifacts under the existing output directory structure

The JSON state contract should use renamed top-level types, but preserve the underlying fields unless a field name itself contains old product terminology.

### Logs and observability

Structured event names should consistently use `decision_council.*` naming, replacing the current `council.*` prefix. Recommended span names in documentation should change from `run.council` forms to `run.decision_council` forms. Pretty logs can continue to say `run`, `round`, `persona`, `baml`, and `artifact` in the short event text as long as event identifiers and docs make the workflow name clear.

## Data flow

The data flow does not change. The only semantic reframing is that input is a decision question or problem statement, not necessarily a design prompt. The example input should be renamed from `examples/design-question.md` to `examples/decision-question.md` and rewritten to ask for help making a decision among tradeoffs.

## Error handling

Existing error behavior should be preserved:

- Setup/configuration errors fail loudly.
- Per-persona failures are partial success when at least two normalized critiques remain.
- Judge or artifact failures fail the run.
- The `nextRoundBrief: null` schema boundary fix remains in place after renaming.

Usage errors should mention `glueplane decision-council run --input <path> [--output <dir>]`.

## Testing strategy

Use TDD for behavior changes during implementation. Update the existing test suite rather than duplicating it:

- CLI tests cover the new command, usage error, success report path, and old command rejection.
- Type/schema tests cover renamed schemas and keep the `nextRoundBrief: null` regression.
- Artifact tests assert new filenames and `# Decision Council Report`.
- Runner/workflow tests use renamed public API and BAML adapter calls.
- README/examples tests, if any, use the new command.

After BAML changes, regenerate the client and verify generated files are in sync.

## Acceptance criteria

- No active source, tests, README, example, BAML prompt, generated client, or artifact assertion refers to `Design Council` except dated historical docs that are intentionally preserved.
- The old CLI command `council run` is rejected.
- The new CLI command and npm script use `decision-council`.
- The package name and binary are `glueplane`.
- Artifacts are written as `DecisionCouncilReport.md` and `DecisionCouncilRunState.json`.
- Public exports expose `DecisionCouncil*` names with no `Council*` compatibility aliases.
- Tests, typecheck, BAML generation, and build pass.
