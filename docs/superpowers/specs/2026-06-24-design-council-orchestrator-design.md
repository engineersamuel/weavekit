# Weavekit Design Council Orchestrator

## Purpose

Weavekit is a TypeScript-first playground for orchestrating GitHub Copilot SDK agents through explicit, typed workflows. The first proof workflow is a Design Council: a bounded multi-persona review loop that helps pressure-test a design, architecture, or engineering question and returns a decision-ready report.

The goal is learning speed with a path to a durable personal workflow engine. The first version should prove orchestration primitives, typed fan-out/fan-in, BAML-mediated structured outputs, and useful report artifacts without prematurely building a harness, web UI, cloud service, or generalized framework.

## Design goals

- Use TypeScript for fastest iteration across workflow tooling, Copilot SDK integration, BAML, and CLI/report output.
- Use Mastra as the workflow runner for typed steps, parallel fan-out, loop control, and workflow debugging.
- Use GitHub Copilot SDK sessions as persona workers from the start.
- Use BAML at selected decision points, not every LLM boundary.
- Keep the external module deep: callers use `runCouncil(input, { personaSet? }) => CouncilReport`.
- Allow one v0 escape hatch: persona set configuration.
- Produce decision-ready output, not agent theater.

## Non-goals for v0

- No web UI.
- No cloud durability or hosted service.
- No arbitrary prompt overrides, reducers, or custom step hooks.
- No Azure architecture research workflow yet.
- No product research/shopping workflow yet.
- No Microsoft Agent Framework, Rust runner, or LangGraph implementation yet.

## Architecture

The external seam is a small library interface plus a CLI wrapper:

```ts
runCouncil(input: CouncilInput, options?: { personaSet?: PersonaSet }): Promise<CouncilReport>
```

The CLI invokes that interface and writes artifacts:

```bash
weavekit council run --input question.md --personas default
```

Behind the seam, Mastra controls the workflow:

1. Build an initial `RoundBrief` from `CouncilInput`.
2. Fan out to Copilot SDK persona sessions in parallel.
3. Capture raw persona outputs and debug transcripts.
4. Normalize each persona response with BAML into `PersonaCritique`.
5. Fan in to the Judge reducer.
6. Use BAML to create `RoundAssessment`.
7. Stop or continue based on the stop policy.
8. Emit `CouncilReport`, typed JSON run state, and Markdown report.

## Modules

### CouncilRunner

`CouncilRunner` owns the public interface. It validates input, chooses the persona set, invokes the Mastra workflow, and returns the final `CouncilReport`.

This is the primary test surface. Callers should not need to know about Mastra, BAML code generation, Copilot sessions, round orchestration, or artifact formatting.

### PersonaWorker

`PersonaWorker` adapts a persona definition to a Copilot SDK session. It receives a `RoundBrief`, persona instructions, and allowed context. It returns raw persona output plus transcript/debug metadata.

Default debating personas:

- Socratic Questioner: surfaces hidden assumptions and missing questions.
- Deep Module/DRY Architect: critiques seams, interfaces, duplication, and module depth.
- Pragmatic Builder: identifies the smallest useful next experiment or implementation slice.
- Skeptic: looks for failure modes, overconfidence, and weak evidence.

### CritiqueNormalizer

`CritiqueNormalizer` calls BAML to turn raw persona output into typed `PersonaCritique`. It is responsible for schema-aligned parsing, retry behavior configured in BAML, and explicit failure reporting when output cannot be normalized.

### JudgeReducer

`JudgeReducer` is not a debating persona. It is the fan-in reducer. It reads all successful critiques and persona failures, then uses BAML to create `RoundAssessment`.

The Judge decides whether to continue, writes the next-round brief when needed, and produces the final synthesis when the run stops.

### ArtifactStore

`ArtifactStore` writes:

- `CouncilReport.md`
- `CouncilRunState.json`
- raw Copilot transcript/debug artifacts

Raw transcripts are debug artifacts, not the primary state contract.

## BAML contracts

BAML owns the core LLM-to-type contracts:

- `PersonaCritique`
- `PersonaFailure`
- `RoundAssessment`
- `CouncilReport`

Mastra owns workflow state and step wiring. BAML should be used where determinism matters most: critique normalization, convergence assessment, disagreement synthesis, and final report shaping.

## Data flow

`CouncilInput` contains:

- design/question/spec text
- optional context files or links
- constraints
- optional persona set name/configuration

Each round contains:

- `RoundBrief`
- raw persona outputs
- typed `PersonaCritique[]`
- typed `PersonaFailure[]`
- `RoundAssessment`

`CouncilReport` contains:

- final recommendation
- rationale
- strongest objections
- unresolved questions
- confidence/convergence score
- suggested next experiment

The main report should be decision-ready. Full debate transcripts remain available for debugging but should not dominate the output.

## Stop policy

The workflow stops on the earliest of:

- maximum round count, defaulting to 3
- explicit consensus from the Judge
- BAML-assessed diminishing returns

The default hard cap keeps runs cheap and predictable while preserving enough room for critique and revision.

## Error handling

Setup and configuration errors fail loudly:

- missing Copilot credentials
- invalid BAML generation/runtime configuration
- invalid input
- missing required dependencies

Per-persona failures are treated as partial success. The Judge receives typed `PersonaFailure` values alongside successful critiques. The final report must clearly state which personas failed.

The run exits non-zero only if:

- fewer than two debating personas succeed
- the Judge fails
- artifact writing fails
- a setup/configuration error occurs

No failure should be silently converted into success-shaped output.

## Testing strategy

Tests should target the public seam first:

- `runCouncil` with fake persona workers and fake BAML adapters
- stop-policy tests for max rounds, consensus, and diminishing returns
- partial-failure tests for failed personas
- artifact snapshot tests for Markdown and JSON output
- contract tests for BAML-generated shapes

Internal modules can have tests behind their own seams, but v0 should avoid exposing those seams publicly unless a second adapter or real variation appears.

## Growth path

1. Build the Design Council workflow.
2. Add persona packs after the default council is useful.
3. Add an Azure architecture pressure-test workflow.
4. Add a product research/recommendation workflow.
5. Revisit Rust for stable orchestrator primitives or performance-sensitive pieces.
6. Revisit Microsoft Agent Framework for dogfooding if Python/C# workflow experiments become valuable.
7. Revisit LangGraph only if cyclic graph semantics become more important than Mastra's workflow ergonomics.

## v0 success criteria

One command can run the Design Council on a real architecture/design question, complete in no more than three rounds, produce a decision-ready Markdown report plus typed JSON state, and make it clear where BAML affected normalization, routing, convergence, and synthesis.
