# Council Compact Summaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add concise indented persona summaries to compact Design Council logs and make shared round behavior explicit.

**Architecture:** Extend the normalized `PersonaCritique` contract with `overallSummary`, then pass that summary through existing typed logger events after BAML normalization succeeds. Add round-start metadata that describes whether the round uses the initial brief or a shared Judge brief, and format that metadata as an indented child line without changing orchestration behavior.

**Tech Stack:** TypeScript, Vitest, Zod, BAML, generated BAML client, picocolors, npm/nub CLI scripts.

## Global Constraints

- Do not add another BAML summarizer call.
- Do not summarize raw persona output before normalization.
- Do not change persona scheduling, Judge assessment, or round continuation behavior.
- Do not build a custom UI for this change.
- Pretty logs show one concise indented summary after each successful BAML normalization.
- Pretty logs explain that round 2+ uses a shared Judge brief from the previous round.
- JSON logs include the same summary and round-source metadata as structured fields.
- `CouncilRunState.json` includes `overallSummary` inside each normalized critique.
- Tests, typecheck, build, and BAML generation pass.

---

## File Structure

- Modify `baml_src/council.baml`: add `overallSummary` to `PersonaCritique`; update the `NormalizePersonaCritique` prompt to request one short CLI summary.
- Modify `src/council/types.ts`: add `overallSummary` to `PersonaCritiqueSchema`.
- Modify generated BAML files under `src/generated/baml_client/`: regenerate after BAML schema changes.
- Modify `src/council/logger.ts`: add optional event fields `summary`, `focusSource`, and `previousRoundNumber`; render indented child lines in pretty format.
- Modify `src/council/workflow.ts`: set round source metadata on round-start events and attach `critique.overallSummary` to normalize completion events.
- Modify `tests/council/logger.test.ts`: verify formatted summary and shared round child lines.
- Modify `tests/council/runner.test.ts`: verify emitted normalize event carries the normalized critique summary and round-start events carry source metadata.
- Modify `tests/council/types.test.ts`, `tests/council/bamlAdapters.test.ts`, `tests/council/artifacts.test.ts`, and `tests/council/runner.test.ts`: add `overallSummary`.
- Modify `README.md`: document shared fan-out/fan-in rounds and normalize summary logging.

---

### Task 1: Add the normalized persona summary contract

**Files:**
- Modify: `baml_src/council.baml`
- Modify: `src/council/types.ts`
- Modify after generation: `src/generated/baml_client/inlinedbaml.ts`
- Modify after generation: `src/generated/baml_client/partial_types.ts`
- Modify after generation: `src/generated/baml_client/type_builder.ts`
- Modify after generation: `src/generated/baml_client/types.ts`
- Test: `tests/council/types.test.ts`
- Test: `tests/council/bamlAdapters.test.ts`
- Test fixture: `tests/council/artifacts.test.ts`
- Test fixture: `tests/council/runner.test.ts`

**Interfaces:**
- Consumes: existing `PersonaCritique` with `personaId`, `summary`, `claims`, `risks`, `questions`, and `recommendations`.
- Produces: `PersonaCritique.overallSummary: string`, a required one-sentence CLI-friendly summary persisted in run state and available to workflow logging.

- [ ] **Step 1: Write the failing domain schema test**

Add this import in `tests/council/types.test.ts`:

```ts
import {
  CouncilInputSchema,
  CouncilReportSchema,
  PersonaCritiqueSchema,
  createInitialRunState,
} from "../../src/council/types.js";
```

Add this test inside `describe("council domain types", () => { ... })`:

```ts
  it("requires normalized persona critiques to include a compact overall summary", () => {
    const critique = PersonaCritiqueSchema.parse({
      personaId: "pragmatic",
      overallSummary: "Pragmatic persona recommends a minimal validation spike before adopting orchestration layers.",
      summary: "The design should prove the council pattern before committing to Flue and BAML.",
      claims: ["The smallest useful experiment is enough for v0."],
      risks: ["Premature framework adoption can obscure the core product risk."],
      questions: ["What measurable problem justifies Flue?"],
      recommendations: ["Run a two-persona spike before expanding the orchestration layer."],
    });

    expect(critique.overallSummary).toContain("minimal validation spike");
  });
```

- [ ] **Step 2: Run the schema test to verify it fails**

Run:

```bash
npm test -- tests/council/types.test.ts
```

Expected: FAIL because `PersonaCritiqueSchema` is not exported or does not require `overallSummary`.

- [ ] **Step 3: Add `overallSummary` to the TypeScript schema**

In `src/council/types.ts`, change the `PersonaCritiqueSchema` block to:

```ts
export const PersonaCritiqueSchema = z.object({
  personaId: z.string().min(1),
  overallSummary: z.string().min(1),
  summary: z.string().min(1),
  claims: z.array(z.string().min(1)),
  risks: z.array(z.string().min(1)),
  questions: z.array(z.string().min(1)),
  recommendations: z.array(z.string().min(1)),
});
```

- [ ] **Step 4: Add `overallSummary` to BAML**

In `baml_src/council.baml`, change the `PersonaCritique` class to:

```baml
class PersonaCritique {
  personaId string
  overallSummary string
  summary string
  claims string[]
  risks string[]
  questions string[]
  recommendations string[]
}
```

Change the `NormalizePersonaCritique` prompt to:

```baml
function NormalizePersonaCritique(raw: RawPersonaResult) -> PersonaCritique {
  client DefaultClient
  prompt #"
    Normalize this persona response into the requested critique schema.
    Preserve the personaId exactly.
    Set overallSummary to one short sentence for CLI progress that summarizes
    the persona's overall stance, conclusion, or decision.

    Persona ID: {{ raw.personaId }}
    Raw response:
    {{ raw.text }}

    {{ ctx.output_format }}
  "#
}
```

- [ ] **Step 5: Update local fake normalizer fixtures**

In `tests/council/bamlAdapters.test.ts`, update the fake `normalizeCritique` return to:

```ts
        return {
          personaId,
          overallSummary: "Summary for compact progress output.",
          summary: "Summary",
          claims: ["Claim"],
          risks: ["Risk"],
          questions: ["Question"],
          recommendations: ["Recommendation"],
        };
```

In `tests/council/runner.test.ts`, update the shared `normalizer.normalizeCritique` return to:

```ts
    return {
      personaId: raw.personaId,
      overallSummary: `${raw.personaId} recommends testing the riskiest assumption first.`,
      summary: raw.text,
      claims: [`${raw.personaId} claim`],
      risks: [`${raw.personaId} risk`],
      questions: [`${raw.personaId} question`],
      recommendations: [`${raw.personaId} recommendation`],
    };
```

- [ ] **Step 6: Regenerate BAML client files**

Run:

```bash
npm run baml-generate
```

Expected: PASS and generated files under `src/generated/baml_client/` update to include `overallSummary`.

- [ ] **Step 7: Run focused schema and adapter tests**

Run:

```bash
npm test -- tests/council/types.test.ts tests/council/bamlAdapters.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

Run:

```bash
git add baml_src/council.baml src/council/types.ts src/generated/baml_client tests/council/types.test.ts tests/council/bamlAdapters.test.ts tests/council/runner.test.ts
git commit -m "feat: add persona overall summaries" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds. If unrelated pre-existing changes are present in these files, inspect them with:

```bash
git --no-pager diff -- baml_src/council.baml src/council/types.ts tests/council/types.test.ts tests/council/bamlAdapters.test.ts tests/council/runner.test.ts
```

Then stage only the Task 1 hunks for those files.

---

### Task 2: Format compact summary and round-context child lines

**Files:**
- Modify: `src/council/logger.ts`
- Test: `tests/council/logger.test.ts`

**Interfaces:**
- Consumes: `CouncilEvent` union and `formatCouncilEvent(event, options)`.
- Produces:
  - `council.baml.completed` events may include `summary?: string`.
  - `council.round.started` events include `focusSource: "initial" | "judge"` and optional `previousRoundNumber?: number`.
  - Pretty output may contain one indented child line after the main event line.

- [ ] **Step 1: Write the failing logger tests**

Add these tests inside `describe("council logger", () => { ... })` in `tests/council/logger.test.ts`:

```ts
  it("formats normalized critique summaries as indented child lines", () => {
    const formatted = formatCouncilEvent(
      {
        type: "council.baml.completed",
        timestamp: "2026-06-24T18:00:00.000Z",
        runId: "run-1",
        roundNumber: 1,
        personaId: "pragmatic",
        operation: "normalize",
        durationMs: 4500,
        summary: "Pragmatic persona recommends a minimal validation spike before adopting Flue/BAML.",
      },
      { color: false },
    );

    expect(formatted).toContain("baml completed round=1 persona=pragmatic operation=normalize duration=4.5s");
    expect(formatted).toContain(
      "\n    -> Pragmatic persona recommends a minimal validation spike before adopting Flue/BAML.",
    );
  });

  it("formats shared Judge round context as an indented child line", () => {
    const formatted = formatCouncilEvent(
      {
        type: "council.round.started",
        timestamp: "2026-06-24T18:00:00.000Z",
        runId: "run-1",
        roundNumber: 2,
        focus: "Focus on validation criteria.",
        focusSource: "judge",
        previousRoundNumber: 1,
      },
      { color: false },
    );

    expect(formatted).toContain('round started round=2 focus="Focus on validation criteria."');
    expect(formatted).toContain(
      "\n    -> Shared Judge brief from round 1; all personas respond to this focus, then the Judge assesses the round 2 set together.",
    );
  });
```

- [ ] **Step 2: Run logger tests to verify they fail**

Run:

```bash
npm test -- tests/council/logger.test.ts
```

Expected: FAIL because `summary`, `focusSource`, and `previousRoundNumber` are not accepted or formatted.

- [ ] **Step 3: Extend `CouncilEvent` in `src/council/logger.ts`**

Change the `council.round.started` event type to:

```ts
  | {
      type: "council.round.started";
      timestamp: string;
      runId: string;
      roundNumber: number;
      focus: string;
      focusSource: "initial" | "judge";
      previousRoundNumber?: number;
    }
```

Change the `council.baml.started` / `completed` / `failed` event type to:

```ts
  | {
      type: "council.baml.started" | "council.baml.completed" | "council.baml.failed";
      timestamp: string;
      runId: string;
      roundNumber?: number;
      operation: "normalize" | "assess" | "report";
      personaId?: string;
      durationMs?: number;
      summary?: string;
      error?: string;
    }
```

- [ ] **Step 4: Add child-line helpers in `src/council/logger.ts`**

Add these functions after `colorize(...)`:

```ts
function childLine(text: string): string {
  return `\n    -> ${text}`;
}

function childText(event: CouncilEvent): string | undefined {
  if (event.type === "council.baml.completed" && event.operation === "normalize" && event.summary) {
    return event.summary;
  }

  if (event.type === "council.round.started" && event.focusSource === "judge" && event.previousRoundNumber) {
    return `Shared Judge brief from round ${event.previousRoundNumber}; all personas respond to this focus, then the Judge assesses the round ${event.roundNumber} set together.`;
  }

  if (event.type === "council.round.started" && event.focusSource === "initial") {
    return "Initial council brief; all personas respond independently, then the Judge assesses the round 1 set together.";
  }

  return undefined;
}
```

- [ ] **Step 5: Append child lines in `formatCouncilEvent`**

Replace the final return in `formatCouncilEvent`:

```ts
  return parts.join(" ");
```

with:

```ts
  const child = childText(event);
  return child ? `${parts.join(" ")}${childLine(child)}` : parts.join(" ");
```

- [ ] **Step 6: Run logger tests to verify they pass**

Run:

```bash
npm test -- tests/council/logger.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add src/council/logger.ts tests/council/logger.test.ts
git commit -m "feat: format compact council log summaries" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

---

### Task 3: Emit summaries and shared-round metadata from the workflow

**Files:**
- Modify: `src/council/workflow.ts`
- Test: `tests/council/runner.test.ts`

**Interfaces:**
- Consumes: `PersonaCritique.overallSummary` from Task 1 and `CouncilEvent` extensions from Task 2.
- Produces: `runCouncil` emits normalize completion events with `summary` and round-start events with `focusSource` plus `previousRoundNumber` for Judge-derived rounds.

- [ ] **Step 1: Write the failing workflow event test**

Add this test in `tests/council/runner.test.ts` after the existing `"emits progress events for the council run"` test:

```ts
  it("emits normalized summary and shared round source metadata", async () => {
    const events: unknown[] = [];

    await runCouncil(
      { prompt: "Log summaries across rounds." },
      {
        deps: {
          personaWorker: fakeWorker(),
          normalizer,
          judge: judge(2),
          writeArtifacts: false,
        },
        logger: {
          event(event) {
            events.push(event);
          },
        },
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "council.round.started",
        roundNumber: 1,
        focusSource: "initial",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "council.round.started",
        roundNumber: 2,
        focusSource: "judge",
        previousRoundNumber: 1,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "council.baml.completed",
        operation: "normalize",
        personaId: "pragmatic",
        summary: "pragmatic recommends testing the riskiest assumption first.",
      }),
    );
  });
```

- [ ] **Step 2: Run runner test to verify it fails**

Run:

```bash
npm test -- tests/council/runner.test.ts
```

Expected: FAIL because workflow events do not include `focusSource`, `previousRoundNumber`, or `summary`.

- [ ] **Step 3: Add round-start metadata in `src/council/workflow.ts`**

Find the `deps.logger?.event({ type: "council.round.started", ... })` call and change it to:

```ts
  deps.logger?.event({
    type: "council.round.started",
    timestamp: timestamp(),
    runId,
    roundNumber: brief.roundNumber,
    focus: brief.focus,
    focusSource: state.rounds.length === 0 ? "initial" : "judge",
    previousRoundNumber: state.rounds.at(-1)?.brief.roundNumber,
  });
```

- [ ] **Step 4: Attach normalized summaries to BAML completion events**

Find the normalize `.then` success block in `runCouncilRound` and change the completed event to:

```ts
        deps.logger?.event({
          type: "council.baml.completed",
          timestamp: timestamp(),
          runId,
          roundNumber: brief.roundNumber,
          operation: "normalize",
          personaId: raw.personaId,
          durationMs: performance.now() - startedAt,
          summary: critique.overallSummary,
        });
```

- [ ] **Step 5: Run runner tests to verify they pass**

Run:

```bash
npm test -- tests/council/runner.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add src/council/workflow.ts tests/council/runner.test.ts
git commit -m "feat: emit council summary progress events" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

---

### Task 4: Update persisted fixtures and documentation

**Files:**
- Modify: `tests/council/artifacts.test.ts`
- Modify: `tests/council/bamlAdapters.test.ts`
- Modify: `tests/council/runner.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `PersonaCritique.overallSummary` and logger child-line behavior from prior tasks.
- Produces: Documentation and fixtures that reflect the new persisted field and user-visible round explanation.

- [ ] **Step 1: Run all tests to discover remaining fixture failures**

Run:

```bash
npm test
```

Expected: Either PASS or FAIL only in `tests/council/artifacts.test.ts`, `tests/council/bamlAdapters.test.ts`, or `tests/council/runner.test.ts` where a test fixture defines `PersonaCritique` without `overallSummary`.

- [ ] **Step 2: Update artifact fixtures that include critiques**

If `tests/council/artifacts.test.ts` contains a `critiques` array with persona critique objects, add `overallSummary` to each object. Use this shape:

```ts
{
  personaId: "socratic",
  overallSummary: "Socratic persona surfaces unresolved assumptions before implementation.",
  summary: "The design depends on assumptions that should be tested before shipping.",
  claims: ["The orchestration layer may not be necessary."],
  risks: ["The design may optimize for architecture before validating user value."],
  questions: ["What evidence would prove the council pattern is useful?"],
  recommendations: ["Run a minimal council spike and compare it to a single-agent baseline."],
}
```

Do not add critiques to tests that intentionally use empty `critiques: []`.

- [ ] **Step 3: Update README run explanation**

In `README.md`, replace the paragraph beginning with `The CLI prints rich progress to stderr` with:

```md
The CLI prints compact rich progress to stderr while the council runs: run start, round start, persona start/finish/failure, BAML normalization/Judge/report phases, artifact paths, and final stop reason. After each successful BAML normalization, pretty logs include one indented summary of that persona's normalized stance:

```text
[2026-06-24T19:42:21.962Z] baml completed round=1 persona=pragmatic operation=normalize duration=4.5s
    -> Pragmatic persona recommends a minimal validation spike before adopting Flue/BAML.
```

Rounds use a shared fan-out/fan-in model. Round 1 sends the initial brief to every persona. Round 2+ sends one shared Judge brief, produced from the previous round's full set of normalized critiques, to every persona; the Judge then assesses the current round's full critique set together.
```

Keep the existing final stdout text immediately after this inserted section:

```md
The final stdout includes the recommendation plus a link to the Markdown report:
```

- [ ] **Step 4: Run all tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add README.md tests/council/artifacts.test.ts
git commit -m "docs: explain council compact progress logs" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds. If `tests/council/bamlAdapters.test.ts` or `tests/council/runner.test.ts` changed in Task 4 because fixture updates were not already committed in Task 1 or Task 3, run this exact command instead:

```bash
git add README.md tests/council/artifacts.test.ts tests/council/bamlAdapters.test.ts tests/council/runner.test.ts
git commit -m "docs: explain council compact progress logs" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Verify generated output and CLI behavior

**Files:**
- Modify only if verification reveals a defect in files changed by Tasks 1-4.
- Test: existing test suite and a local CLI smoke command.

**Interfaces:**
- Consumes: all changes from Tasks 1-4.
- Produces: verified implementation that satisfies the accepted spec.

- [ ] **Step 1: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run build**

Run:

```bash
npm run build
```

Expected: PASS, including BAML generation.

- [ ] **Step 3: Run a compact logging smoke test**

Run:

```bash
BAML_LOG=warn COPILOT_PROXY_API_KEY="anything" nub run council council run --input examples/design-question.md --output runs/example --log-format pretty
```

Expected: PASS. The stderr progress output includes a normalize summary child line:

```text
baml completed round=1 persona=pragmatic operation=normalize duration=4.5s
    -> Pragmatic persona recommends a minimal validation spike before adopting Flue/BAML.
```

and, if the Judge requests a second round, includes:

```text
round started round=2
    -> Shared Judge brief from round 1; all personas respond to this focus, then the Judge assesses the round 2 set together.
```

The stdout output includes:

```text
Markdown report: runs/example/CouncilReport.md
```

- [ ] **Step 4: Run a JSON logging smoke check**

Run:

```bash
BAML_LOG=warn COPILOT_PROXY_API_KEY="anything" nub run council council run --input examples/design-question.md --output runs/example-json --log-format json 2> runs/example-json/events.jsonl
```

Expected: PASS. Then run:

```bash
grep '"summary"' runs/example-json/events.jsonl | head -1
grep '"focusSource":"judge"' runs/example-json/events.jsonl | head -1
```

Expected: the first command prints at least one normalize completion event with `"summary"`. The second command prints a round-start event if the run continued past round 1; if the council stops after round 1, confirm `"focusSource":"initial"` appears instead:

```bash
grep '"focusSource":"initial"' runs/example-json/events.jsonl | head -1
```

- [ ] **Step 5: Commit verification fixes if verification changed Task 1 files**

If Steps 1-4 required fixes only in Task 1 files, commit them:

```bash
git add baml_src/council.baml src/council/types.ts src/generated/baml_client tests/council/types.test.ts tests/council/bamlAdapters.test.ts tests/council/runner.test.ts
git commit -m "fix: complete council compact summary logging" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If Steps 1-4 required fixes only in Task 2 files, commit them:

```bash
git add src/council/logger.ts tests/council/logger.test.ts
git commit -m "fix: complete council compact summary logging" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If Steps 1-4 required fixes only in Task 3 files, commit them:

```bash
git add src/council/workflow.ts tests/council/runner.test.ts
git commit -m "fix: complete council compact summary logging" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If Steps 1-4 required fixes only in Task 4 files, commit them:

```bash
git add README.md tests/council/artifacts.test.ts tests/council/bamlAdapters.test.ts tests/council/runner.test.ts
git commit -m "fix: complete council compact summary logging" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If verification required fixes across multiple tasks, make the smallest coherent fix and stage the exact files listed above that changed.
