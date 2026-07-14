# Source-to-Project BAML Judge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace saturated Promptfoo model grading with an auditable two-model BAML judge, deterministic aggregation, and hash-verified stored-plan rejudging.

**Architecture:** Promptfoo remains responsible for executing plan providers and capturing outputs. New focused modules freeze canonical artifacts, invoke BAML absolute and pairwise judges, validate complete contracts, aggregate scores, and render a version-2 scorecard. Rejudge mode reloads the frozen manifest and never invokes providers.

**Tech Stack:** Native TypeScript on Node 22+, Vitest, BAML 0.223, Promptfoo, Zod, Nub, oxlint, oxfmt.

---

### Task 1: Add stable case requirements and BAML contracts

**Files:**

- Modify: `src/eval/sourceToProjectVerification/case.ts`
- Modify: `baml_src/source_to_project.baml`
- Test: `tests/eval/sourceToProjectVerification/case.test.ts`
- Test: `tests/eval/sourceToProjectVerification/baml-contract.test.ts`

- [ ] **Step 1: Write failing tests**

Add assertions that `buildProjectVerificationRequirements()` produces IDs such as `validate-boundaries/action-1`, rejects duplicate derived IDs, and formats a judge reference containing every ID. Add a BAML contract test that checks for `PlanRequirementAssessment`, `PlanCriterionAssessment`, `SourceToProjectPlanJudgment`, `SourceToProjectPairwiseJudgment`, `JudgeSourceToProjectPlan`, and `CompareSourceToProjectPlans`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```text
nub run test -- tests/eval/sourceToProjectVerification/case.test.ts tests/eval/sourceToProjectVerification/baml-contract.test.ts
```

Expected: failure because the requirement builder and BAML contracts do not exist.

- [ ] **Step 3: Implement the minimal contracts**

Add:

```ts
export type ProjectVerificationRequirement = {
  id: string;
  practiceId: string;
  practiceTitle: string;
  action: string;
  sourceExpectation: string;
  projectEvidence: string[];
};

export function buildProjectVerificationRequirements(
  definition: ProjectVerificationCase,
): ProjectVerificationRequirement[];
```

Define the approved BAML classes and functions. Use `CopilotProxyGpt55` as the declared client and `ctx.output_format`; runtime client overrides supply the panel member.

- [ ] **Step 4: Regenerate BAML and verify GREEN**

Run:

```text
nub run baml-generate
nub run test -- tests/eval/sourceToProjectVerification/case.test.ts tests/eval/sourceToProjectVerification/baml-contract.test.ts
```

Expected: both files pass.

### Task 2: Freeze and verify canonical plan artifacts

**Files:**

- Create: `src/eval/sourceToProjectVerification/manifest.ts`
- Test: `tests/eval/sourceToProjectVerification/manifest.test.ts`

- [ ] **Step 1: Write failing manifest tests**

Cover manifest creation from Promptfoo rows, SHA-256 digest persistence, one canonical artifact per provider, missing artifact failure, digest mismatch failure, and mutation-safety metadata.

- [ ] **Step 2: Run the test and verify RED**

```text
nub run test -- tests/eval/sourceToProjectVerification/manifest.test.ts
```

- [ ] **Step 3: Implement manifest types and functions**

Provide:

```ts
export type FrozenPlanArtifact = {
  providerId: string;
  planPath: string;
  sha256: string;
  generationSucceeded: boolean;
  workspaceMutationVerified: boolean;
  model?: string;
  latencyMs?: number;
};

export type ProjectVerificationManifest = {
  version: 1;
  caseId: string;
  createdAt: string;
  artifacts: FrozenPlanArtifact[];
};

export async function buildProjectVerificationManifest(...): Promise<ProjectVerificationManifest>;
export async function verifyProjectVerificationManifest(...): Promise<void>;
```

Resolve and hash the single canonical artifact listed by provider metadata. Provider generation errors remain manifest rows with no judgeable artifact and do not become score zero.

- [ ] **Step 4: Run the test and verify GREEN**

### Task 3: Add judge interface, BAML adapter, and counterbalanced panel coordinator

**Files:**

- Create: `src/eval/sourceToProjectVerification/judge.ts`
- Create: `src/eval/sourceToProjectVerification/bamlJudge.ts`
- Test: `tests/eval/sourceToProjectVerification/judge.test.ts`
- Test: `tests/eval/sourceToProjectVerification/bamlJudge.test.ts`

- [ ] **Step 1: Write failing tests**

Test deterministic provider-pair sorting, SHA-256-seeded first ordering, inverse second-judge ordering, anonymous provider remapping, tie preservation, agreement, dispute, single-judge, and invalid states. Test that the BAML adapter passes `client: "CopilotProxyGpt55"` or `client: "CopilotProxyClaudeOpus48"` without exposing provider identity in judge inputs.

- [ ] **Step 2: Verify RED with focused tests**

- [ ] **Step 3: Implement the deep interface**

```ts
export type SourceToProjectPlanJudge = {
  id: string;
  judgePlan(input: AbsoluteJudgeInput): Promise<SourceToProjectPlanJudgment>;
  comparePlans(input: PairwiseJudgeInput): Promise<SourceToProjectPairwiseJudgment>;
};
```

Add `runProjectVerificationJudgePanel()` that executes absolute judgments for every valid artifact and both judges, then all provider pairs with counterbalanced order. Capture errors as invalid judge records rather than throwing away the whole run.

- [ ] **Step 4: Run focused tests and verify GREEN**

### Task 4: Validate and aggregate judgments deterministically

**Files:**

- Create: `src/eval/sourceToProjectVerification/aggregation.ts`
- Test: `tests/eval/sourceToProjectVerification/aggregation.test.ts`

- [ ] **Step 1: Write failing aggregation tests**

Cover complete/partial/missing/contradicted values, equal practice weighting despite unequal action counts, two-judge criterion averaging, unknown/duplicate/missing requirement IDs, unknown/duplicate/missing criterion IDs, out-of-range scores, and transport errors remaining invalid rather than zero.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement deterministic aggregation**

Map coverage statuses to `1, 0.5, 0, 0`; average actions within each practice and then practices; normalize ordinal criteria by four; apply case weights only after every required score is valid. Persist requirement, practice, criterion, contradiction, unsupported-recommendation, and judge-error details.

- [ ] **Step 4: Verify GREEN**

### Task 5: Replace the scorecard with version 2 semantics

**Files:**

- Modify: `src/eval/sourceToProjectVerification/scorecard.ts`
- Test: `tests/eval/sourceToProjectVerification/scorecard.test.ts`

- [ ] **Step 1: Rewrite tests for version 2**

Assert separate `generationSucceeded`, `workspaceMutationVerified`, `qualityValid`, quality score, criteria, evidence, errors, efficiency metadata, score deltas, and pairwise panel status. Losing a comparison must not change generation success. Parsing an old version-1 scorecard should fail clearly rather than silently reinterpret it.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement and render version 2**

Render distinct sections for provider quality, pairwise outcomes, generation/mutation reliability, and efficiency. Report `agreed`, `disputed`, `single-judge`, and `invalid`; show ties explicitly.

- [ ] **Step 4: Verify GREEN**

### Task 6: Rewire collection, judging, persistence, and rejudge mode

**Files:**

- Modify: `src/eval/sourceToProjectVerification/suite.ts`
- Modify: `src/eval/sourceToProjectVerification/run.ts`
- Create: `src/eval/sourceToProjectVerification/rejudge.ts`
- Modify: `src/eval-source-to-project-cli.ts`
- Test: `tests/eval/sourceToProjectVerification/suite.test.ts`
- Test: `tests/eval/sourceToProjectVerification/run.test.ts`
- Test: `tests/eval/sourceToProjectVerification/rejudge.test.ts`
- Test: `tests/eval/sourceToProjectVerification/cli.test.ts`

- [ ] **Step 1: Write failing orchestration tests**

Assert the Promptfoo suite contains no `llm-rubric`, `g-eval`, or `select-best`; normal runs write `manifest.json`, `promptfoo-report.json`, judgment files, `scores.json`, and `summary.md`; judge dependencies are injectable; `--rejudge-from` is mutually exclusive with provider-generation options; and rejudge invokes zero providers while rejecting changed hashes.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement orchestration**

Normal mode executes Promptfoo once, freezes artifacts, runs the judge panel, aggregates, and writes artifacts. Rejudge mode loads the previous case and manifest, verifies hashes, creates `judge-replays/<timestamp>`, and runs only judge/aggregation. Keep baseline comparison compatible only with version-2 scorecards.

- [ ] **Step 4: Verify GREEN**

### Task 7: Add calibration fixtures and live calibration entrypoint

**Files:**

- Create: `evals/source-to-project/judge-calibration/todo-safe-write-path/weak.md`
- Create: `evals/source-to-project/judge-calibration/todo-safe-write-path/medium.md`
- Create: `evals/source-to-project/judge-calibration/todo-safe-write-path/strong.md`
- Create: `src/eval/sourceToProjectVerification/calibration.ts`
- Modify: `package.json`
- Test: `tests/eval/sourceToProjectVerification/calibration.test.ts`

- [ ] **Step 1: Write failing calibration loader tests**

Assert all three fixtures load, strong/medium/weak expectations are validated, A/B reversal maps to the same winner, and no provider workflow is involved.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Add fixtures and command**

Add `eval:source-to-project:judge-calibration` using the real two-model panel. The strong fixture covers every expected practice; medium deliberately omits service/repository and safe rendering; weak remains generic.

- [ ] **Step 4: Verify GREEN with fake judges**

### Task 8: Verify live judging and complete repository validation

**Files:**

- Modify only files required by failures discovered in this task.

- [ ] **Step 1: Run live calibration**

```text
nub run eval:source-to-project:judge-calibration
```

Expected: both models rank strong above medium above weak; all pairwise expectations hold after order reversal; no result is invalid or disputed.

- [ ] **Step 2: Rejudge the latest stored plans**

```text
nub run eval:source-to-project -- --rejudge-from evals/source-to-project/results/2026-07-10T17-33-14-776Z
```

Expected: zero provider calls; manifest hashes verified; two-model absolute evidence and pairwise results persisted; no Promptfoo saturation or fixed-order comparison.

- [ ] **Step 3: Run full repository checks**

```text
nub run baml-generate
nub run fmt
nub run typecheck
nub run lint
nub run test
mise run doctor
```

- [ ] **Step 4: Audit the design acceptance criteria**

Inspect the live replay artifacts requirement by requirement. Keep the broader goal active unless varied cases and repetitions prove reliable superiority.
