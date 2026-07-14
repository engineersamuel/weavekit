# Portfolio Planner Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make canonical portfolio planning compact and fail closed so unfinished timeout partials cannot enter BAML distillation or semantic audit.

**Architecture:** Add a per-call timeout-partial policy to the Copilot SDK harness and disable partial acceptance only for `plan-portfolio`. Replace duplicated portfolio context with a canonical compiler projection and persist exact prompt-size diagnostics. Preserve Promptfoo lineage, BAML contracts, semantic auditing, and the one-repair limit.

**Tech Stack:** Node 24 native TypeScript, Copilot SDK, BAML-generated clients, Vitest, Nub, oxlint, oxfmt, mise.

---

## File map

- Modify `src/macro-workflow/sourceToProject/harnesses.ts` for the per-call completion
  policy, portfolio call wiring, and persisted diagnostics.
- Modify `src/macro-workflow/sourceToProject/prompts.ts` for canonical prompt projection
  and exact section measurement.
- Modify `tests/macro-workflow/sourceToProject/harnesses.test.ts` for timeout and
  portfolio integration regressions.
- Modify `tests/macro-workflow/sourceToProject/prompts.test.ts` for context and size
  regressions.
- Modify `README.md` only if the live operator contract needs clarification.

### Task 1: Reject timeout partials at the canonical portfolio boundary

**Files:**

- Modify: `src/macro-workflow/sourceToProject/harnesses.ts:297-312`
- Modify: `src/macro-workflow/sourceToProject/harnesses.ts:1276-1514`
- Modify: `src/macro-workflow/sourceToProject/harnesses.ts:2010-2055`
- Test: `tests/macro-workflow/sourceToProject/harnesses.test.ts:1070-1145`

- [ ] **Step 1: Write the failing SDK policy test**

Add a test beside `uses the last assistant message when the SDK never emits session idle`
that emits `assistant.message` without `session.idle`, invokes:

```ts
copilot.run({
  prompt: "Create canonical plan",
  mode: "plan",
  acceptPartialOnTimeout: false,
});
```

and expects rejection with `Timeout after 10ms waiting for session.idle` plus a
`timeout-rejected-partial` log carrying the rejected content length.

- [ ] **Step 2: Verify RED**

Run:

```sh
nub run test -- tests/macro-workflow/sourceToProject/harnesses.test.ts
```

Expected: TypeScript/test failure because `acceptPartialOnTimeout` is not supported and
the timeout still resolves to partial content.

- [ ] **Step 3: Implement the per-call completion policy**

Add `acceptPartialOnTimeout?: boolean` to `CopilotHarnessClient.run()` and the internal
run-argument types accepted by `sendCopilotPromptAndWait()` and
`sendWithPartialAssistantFallback()`. Replace the timeout branch with:

```ts
if (
  outcome === "timeout" &&
  runArgs.acceptPartialOnTimeout !== false &&
  lastAssistantContent.trim()
) {
  // existing timeout-partial log and return
}
if (outcome === "timeout") {
  if (lastAssistantContent.trim()) {
    logCopilotHarnessEvent(
      diagnostics.onLog,
      {
        phase: "timeout-rejected-partial",
        mode: runArgs.mode,
        model: diagnostics.model,
        cwd: diagnostics.cwd,
        timeoutMs,
        contentLength: lastAssistantContent.length,
        elapsedMs: elapsedSince(diagnostics.startedAt),
      },
      diagnostics.verboseEvents,
    );
  }
  throw new Error(`Timeout after ${timeoutMs}ms waiting for session.idle`);
}
```

Set `acceptPartialOnTimeout: false` only on the `plan-portfolio` `copilot.run()` call.

- [ ] **Step 4: Add the portfolio wiring regression**

In the existing canonical portfolio harness test, capture the complete argument passed to
the injected Copilot client and assert:

```ts
expect(runArgs).toMatchObject({
  mode: "plan",
  operation: "plan-portfolio",
  acceptPartialOnTimeout: false,
});
```

- [ ] **Step 5: Verify GREEN**

Run:

```sh
nub run test -- tests/macro-workflow/sourceToProject/harnesses.test.ts
nub run typecheck
git diff --check -- src/macro-workflow/sourceToProject/harnesses.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
```

Expected: all commands exit zero; the existing research partial test still passes.

- [ ] **Step 6: Commit the focused task**

```sh
git add src/macro-workflow/sourceToProject/harnesses.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
git commit -m "fix(source-to-project): reject incomplete portfolio timeout output"
```

### Task 2: Compact and measure canonical portfolio prompts

**Files:**

- Modify: `src/macro-workflow/sourceToProject/prompts.ts:161-282`
- Modify: `src/macro-workflow/sourceToProject/harnesses.ts:1980-2140`
- Test: `tests/macro-workflow/sourceToProject/prompts.test.ts:1-48`
- Test: `tests/macro-workflow/sourceToProject/harnesses.test.ts:4140-4230`

- [ ] **Step 1: Write failing prompt projection tests**

Update the compiler fixture with distinctive redundant sentinels and assert that direct,
child, and synthesis compiler prompts retain canonical sections but omit:

```ts
expect(prompt).not.toContain("REDUNDANT_SOURCE_ANALYSIS");
expect(prompt).not.toContain("REDUNDANT_CORROBORATION");
expect(prompt).not.toContain("REDUNDANT_DISCOVERED_OPPORTUNITIES");
expect(prompt).not.toContain("REDUNDANT_OPPORTUNITY_DECISIONS");
```

Keep positive assertions for the ledger, applicability matrix, required coverage,
accepted coverage, specialized obligations, synthesis reviews, and child plans.

- [ ] **Step 2: Write the failing diagnostics and size tests**

Define the desired builder result:

```ts
type PortfolioPromptBuild = {
  prompt: string;
  diagnostics: {
    route: "direct" | "synthesis";
    totalChars: number;
    sections: Record<string, number>;
  };
};
```

Add a captured-scale fixture reflecting the observed section sizes and assert
`diagnostics.totalChars < 60_000`, exact equality with `prompt.length`, and non-zero
canonical section sizes.

- [ ] **Step 3: Verify RED**

Run:

```sh
nub run test -- tests/macro-workflow/sourceToProject/prompts.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
```

Expected: failures because redundant envelopes are still rendered and diagnostics do not
exist.

- [ ] **Step 4: Implement canonical prompt builders**

Remove source analysis, corroboration, discovered opportunities, and full decisions from
`PortfolioPromptInput` and `renderPortfolioCompilerContext()`. Introduce direct and
synthesis builder functions returning `PortfolioPromptBuild`. Build each section as a
named string before joining so diagnostics measure the exact rendered section. Keep
existing string-returning exports only as thin compatibility wrappers if tests or other
callers require them.

- [ ] **Step 5: Persist diagnostics at plan execution**

Construct the prompt through the measured builder and add:

```ts
payload: {
  // existing fields
  portfolioPromptDiagnostics: promptBuild.diagnostics,
}
```

Pass the same diagnostics to `buildExecutionMetadata()` without removing the existing
prompt/call data. Stop adding redundant optional fields to `compilerPromptInput`.

- [ ] **Step 6: Verify GREEN**

Run:

```sh
nub run test -- tests/macro-workflow/sourceToProject/prompts.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
nub run typecheck
nub run lint
git diff --check -- src/macro-workflow/sourceToProject/prompts.ts src/macro-workflow/sourceToProject/harnesses.ts tests/macro-workflow/sourceToProject/prompts.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
```

Expected: all commands exit zero and the captured prompt is below 60,000 characters.

- [ ] **Step 7: Commit the focused task**

```sh
git add src/macro-workflow/sourceToProject/prompts.ts src/macro-workflow/sourceToProject/harnesses.ts tests/macro-workflow/sourceToProject/prompts.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
git commit -m "perf(source-to-project): compact portfolio planning context"
```

### Task 3: Acceptance audit and live Promptfoo proof

**Files:**

- Modify: `README.md` only if live behavior differs from the documented operator contract.
- Produce ignored artifacts under `evals/source-to-project/results/`.

- [ ] **Step 1: Run repository validation**

```sh
nub run fmt
nub run fmt:check
nub run typecheck
nub run lint
nub run test
mise run doctor
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 2: Run persisted evaluator breadth**

```sh
nub run eval:promptfoo:smoke
nub run eval
nub run eval:router
```

Expected: every command prints a persisted Promptfoo evaluation ID and the `promptfoo
view` hint. Record failures as live evidence; do not bypass Promptfoo.

- [ ] **Step 3: Run the ESLint source case**

```sh
mise run doctor
nub run eval:source-to-project -- --case evals/source-to-project/cases/eslint-to-oxlint.yaml
```

Expected reliability gate: the Weavekit provider generates a canonical plan, its
portfolio audit passes, prompt diagnostics are below 60,000 characters, and generation
plus judge evaluation IDs are persisted.

- [ ] **Step 4: Inspect persisted rows before tuning quality**

Open the latest generation/judge results with `nubx promptfoo view` or inspect the linked
JSON artifacts. Confirm failed providers remain visible, hashes match the manifest, and
the Weavekit row is scored rather than converted to zero.

- [ ] **Step 5: Run the full matrix only after the reliability gate**

```sh
nub run eval:source-to-project -- --matrix evals/source-to-project/matrix.yaml --trials 3
```

Expected: twelve linked generation/judge trials. If the single-case gate failed, do not
spend the matrix budget; report the persisted failure and return to diagnosis.

- [ ] **Step 6: Final review and integration handoff**

Run a whole-change specification review, then a code-quality review. Fix and re-review
all Critical or Important findings. Use `superpowers:finishing-a-development-branch` to
offer merge, PR, preserve, or discard options after fresh verification.
