# Source-to-Project Portfolio Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a coverage-preserving source-to-project portfolio compiler whose canonical Weavekit plans reliably outperform Codex and Copilot plans across the approved four-case, three-trial benchmark.

**Architecture:** BAML owns semantic extraction, applicability classification, coverage auditing, and bounded repair. Focused TypeScript modules own stable IDs, exact-set validation, adaptive route selection, artifact hashing/persistence, and reliability aggregation. The existing workflow harness orchestrates those modules and always emits one audited canonical portfolio plan; child plans exist only for independent change surfaces.

**Tech Stack:** Node.js native TypeScript, Vitest, BAML generated TypeScript client, Copilot SDK, existing macro-workflow DAG/runtime, Promptfoo-backed provider collection, Langfuse/OpenTelemetry metadata, Zod/YAML evaluation fixtures, Nub and Mise.

---

## File map

**Create**

- `src/macro-workflow/sourceToProject/portfolioCompiler.ts` — stable practice/behavior/proof IDs, required coverage derivation, cross-artifact invariants, opportunity set-cover selection, adaptive planning route, and audit evidence validation.
- `src/macro-workflow/sourceToProject/portfolioArtifacts.ts` — schema-versioned JSON persistence, SHA-256 input links, initial/final audit artifacts, rejected draft preservation, and canonical Markdown publication.
- `tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts` — pure compiler contract and route tests.
- `tests/macro-workflow/sourceToProject/portfolioArtifacts.test.ts` — persistence, hashes, and canonical output tests.
- `src/eval/sourceToProjectVerification/matrix.ts` — four-case/three-trial orchestration and deterministic reliability-gate aggregation.
- `tests/eval/sourceToProjectVerification/matrix.test.ts` — reliability threshold and invalid-result tests.
- `evals/source-to-project/matrix.yaml` — ordered acceptance case list and trial count.
- `evals/source-to-project/cases/eslint-to-oxlint.yaml` plus fixture source/project files — complete tool-migration case.
- `evals/source-to-project/cases/github-pattern-transfer.yaml` plus fixture source/project files — multiple independent practice-transfer case.
- `evals/source-to-project/cases/evidence-backed-partial-adoption.yaml` plus fixture source/project files — correct partial/non-adoption case.

**Modify**

- `baml_src/source_to_project.baml` — ledger, applicability, coverage, draft, audit, evidence-repair, and plan-repair schemas/functions.
- `src/generated/baml_client/**` — regenerate; never hand-edit.
- `src/macro-workflow/sourceToProject/modelPolicy.ts` — route new BAML functions and expose audit/repair model operations.
- `tests/macro-workflow/sourceToProject/modelPolicy.test.ts` — prove all new functions resolve to declared models.
- `src/macro-workflow/sourceToProject/prompts.ts` — source-conditioned project research, direct portfolio, child plan, evidence-repair, and coverage-aware plan prompts.
- `tests/macro-workflow/sourceToProject/prompts.test.ts` — exact prompt-contract tests.
- `src/macro-workflow/sourceToProject/harnesses.ts` — orchestrate typed stages, coverage-complete selection, adaptive DAG expansion, audit/repair, persistence, and trace metadata.
- `tests/macro-workflow/sourceToProject/harnesses.test.ts` — stage, routing, repair, fail-closed, and end-to-end artifact tests.
- `src/eval-source-to-project-cli.ts` — add matrix/trials entry point without weakening single-case and rejudge modes.
- `tests/eval-source-to-project-cli.test.ts` — CLI compatibility and matrix argument tests.
- `src/eval/sourceToProjectVerification/scorecard.ts` — render matrix reliability and efficiency diagnostics separately from per-trial quality.
- `tests/eval/sourceToProjectVerification/scorecard.test.ts` — matrix Markdown safety and quality/efficiency separation.
- `README.md` — document single-case versus reliability-matrix commands and artifact locations.

## Task 1: Add pure compiler identities and applicability invariants

**Files:**

- Modify: `baml_src/source_to_project.baml`
- Modify: `src/generated/baml_client/**`
- Create: `src/macro-workflow/sourceToProject/portfolioCompiler.ts`
- Create: `tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts`

- [ ] **Step 1: Write failing stable-ID and applicability tests**

```ts
import { describe, expect, it } from "vitest";
import {
  compilePracticeLedger,
  requiredCoverage,
  validateApplicabilityMatrix,
} from "../../../src/macro-workflow/sourceToProject/portfolioCompiler.js";

describe("source-to-project portfolio compiler", () => {
  it("derives stable collision-safe practice, behavior, and proof ids", () => {
    const ledger = compilePracticeLedger({
      sourceId: "oxlint-article",
      summary: "Migration guidance",
      claims: [],
      evidence: [],
      practices: [
        {
          id: "Rule Compatibility",
          title: "Rule compatibility",
          behavior: "Inventory semantic differences before replacement.",
          rationale: "Avoid silent lint regressions.",
          adoptionPreconditions: ["The project uses ESLint rules."],
          requiredBehaviors: ["Inventory enabled ESLint rules", "Classify unsupported rules"],
          proofObligations: ["Run both tools during transition"],
          evidence: [],
        },
        {
          id: "rule compatibility",
          title: "Compatibility fallback",
          behavior: "Retain ESLint for unsupported rules.",
          rationale: "Permit partial adoption.",
          adoptionPreconditions: ["Unsupported rules remain."],
          requiredBehaviors: ["Keep a bounded ESLint compatibility config"],
          proofObligations: ["Show both commands pass"],
          evidence: [],
        },
      ],
    });

    expect(ledger.practices.map((practice) => practice.id)).toEqual([
      "practice-rule-compatibility",
      "practice-rule-compatibility-2",
    ]);
    expect(ledger.practices[0]?.behaviorIds).toEqual([
      "practice-rule-compatibility/behavior-1",
      "practice-rule-compatibility/behavior-2",
    ]);
    expect(ledger.practices[0]?.proofIds).toEqual(["practice-rule-compatibility/proof-1"]);
  });

  it("rejects non-adoption without contradictory project evidence", () => {
    const ledger = compilePracticeLedger(singlePracticeLedgerDraft());
    expect(() =>
      validateApplicabilityMatrix(ledger, {
        projectId: "fixture",
        architecture: "Node project",
        constraints: [],
        validationCommands: ["nub run test"],
        evidence: [],
        assessments: [
          {
            practiceId: ledger.practices[0]!.id,
            status: "not-applicable",
            applicableBehaviorIds: [],
            excludedBehaviorIds: ledger.practices[0]!.behaviorIds,
            targetLayers: [],
            projectEvidence: [],
            contradictionEvidence: [],
            rationale: "No fit was found.",
          },
        ],
      }),
    ).toThrow(/contradiction evidence/);
  });

  it("derives only the applicable subset as required coverage", () => {
    const { ledger, matrix } = partialApplicabilityFixture();
    expect(requiredCoverage(ledger, matrix)).toEqual({
      practiceIds: [ledger.practices[0]!.id],
      behaviorIds: [ledger.practices[0]!.behaviorIds[0]],
      proofIds: ledger.practices[0]!.proofIds,
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `nub run test -- tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts`

Expected: FAIL because `portfolioCompiler.ts` does not exist.

- [ ] **Step 3: Add the generated draft/canonical data contracts**

Add these root declarations to `baml_src/source_to_project.baml` before creating the TypeScript module:

```baml
class SourcePracticeDraft {
  id string @description("Semantic slug proposal; the harness canonicalizes it before downstream use.")
  title string
  behavior string
  rationale string
  adoptionPreconditions string[]
  requiredBehaviors string[]
  proofObligations string[]
  evidence EvidenceReference[]
}

class SourcePractice {
  id string
  title string
  behavior string
  rationale string
  adoptionPreconditions string[]
  requiredBehaviors string[]
  proofObligations string[]
  behaviorIds string[]
  proofIds string[]
  evidence EvidenceReference[]
}

class SourcePracticeLedgerDraft {
  sourceId string
  summary string
  practices SourcePracticeDraft[]
  claims string[]
  evidence EvidenceReference[]
}

class SourcePracticeLedger {
  sourceId string
  summary string
  practices SourcePractice[]
  claims string[]
  evidence EvidenceReference[]
}

class PracticeApplicabilityAssessment {
  practiceId string
  status "applicable" | "partial" | "not-applicable" | "unknown"
  applicableBehaviorIds string[]
  excludedBehaviorIds string[]
  targetLayers string[]
  projectEvidence EvidenceReference[]
  contradictionEvidence EvidenceReference[]
  rationale string
}

class ProjectApplicabilityMatrix {
  projectId string
  assessments PracticeApplicabilityAssessment[]
  architecture string
  constraints string[]
  validationCommands string[]
  evidence EvidenceReference[]
}
```

Run: `nub run baml-generate`

Expected: generation succeeds and exports `SourcePracticeLedgerDraft`, `SourcePracticeLedger`, and `ProjectApplicabilityMatrix`.

- [ ] **Step 4: Implement canonical compilation and strict invariants**

```ts
import type {
  ProjectApplicabilityMatrix,
  SourcePracticeLedger,
  SourcePracticeLedgerDraft,
} from "../../generated/baml_client/index.js";

export type RequiredCoverage = {
  practiceIds: string[];
  behaviorIds: string[];
  proofIds: string[];
};

export function compilePracticeLedger(draft: SourcePracticeLedgerDraft): SourcePracticeLedger {
  const counts = new Map<string, number>();
  const practices = draft.practices.map((practice) => {
    const base = `practice-${normalizeSlug(practice.id)}`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    const id = count === 1 ? base : `${base}-${count}`;
    return {
      ...practice,
      id,
      behaviorIds: practice.requiredBehaviors.map((_, index) => `${id}/behavior-${index + 1}`),
      proofIds: practice.proofObligations.map((_, index) => `${id}/proof-${index + 1}`),
    };
  });
  assertUnique(
    practices.map((practice) => practice.id),
    "practice id",
  );
  return { ...draft, practices };
}

export function validateApplicabilityMatrix(
  ledger: SourcePracticeLedger,
  matrix: ProjectApplicabilityMatrix,
): void {
  assertExactSet(
    matrix.assessments.map((assessment) => assessment.practiceId),
    ledger.practices.map((practice) => practice.id),
    "applicability practice ids",
  );
  for (const assessment of matrix.assessments) {
    const practice = ledger.practices.find((candidate) => candidate.id === assessment.practiceId)!;
    assertSubset(assessment.applicableBehaviorIds, practice.behaviorIds, "applicable behavior ids");
    assertSubset(assessment.excludedBehaviorIds, practice.behaviorIds, "excluded behavior ids");
    if (assessment.status === "applicable" || assessment.status === "partial") {
      if (assessment.projectEvidence.length === 0 || assessment.targetLayers.length === 0) {
        throw new Error(`${assessment.practiceId} requires project evidence and target layers.`);
      }
    }
    if (assessment.status === "not-applicable" && assessment.contradictionEvidence.length === 0) {
      throw new Error(`${assessment.practiceId} requires contradiction evidence for non-adoption.`);
    }
  }
}

export function requiredCoverage(
  ledger: SourcePracticeLedger,
  matrix: ProjectApplicabilityMatrix,
): RequiredCoverage {
  validateApplicabilityMatrix(ledger, matrix);
  const applicable = matrix.assessments.filter(
    (assessment) => assessment.status === "applicable" || assessment.status === "partial",
  );
  const practiceIds = applicable.map((assessment) => assessment.practiceId);
  const behaviorIds = applicable.flatMap((assessment) => assessment.applicableBehaviorIds);
  const proofIds = ledger.practices
    .filter((practice) => practiceIds.includes(practice.id))
    .flatMap((practice) => practice.proofIds);
  return { practiceIds, behaviorIds, proofIds };
}

function normalizeSlug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) throw new Error("Practice id must contain an ASCII letter or digit.");
  return normalized;
}
```

Implement `assertUnique`, `assertExactSet`, and `assertSubset` in the same file with sorted missing/unknown/duplicate IDs in error messages.

- [ ] **Step 5: Run generation and the focused test and verify GREEN**

Run: `nub run baml-generate && nub run test -- tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the pure identity slice**

```bash
git add baml_src/source_to_project.baml src/generated/baml_client src/macro-workflow/sourceToProject/portfolioCompiler.ts tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts
git commit -m "feat(source-to-project): compile stable practice coverage"
```

## Task 2: Wire BAML ledger and applicability functions

**Files:**

- Modify: `baml_src/source_to_project.baml`
- Modify: `src/generated/baml_client/**`
- Modify: `src/macro-workflow/sourceToProject/harnesses.ts:353-378`
- Modify: `tests/macro-workflow/sourceToProject/harnesses.test.ts:1-180`

- [ ] **Step 1: Extend the source/project harness test with typed ledger and matrix payloads**

Add assertions that `source-reading` persists `practiceLedger` and `project-research` persists `applicabilityMatrix`, including the canonical practice ID passed into the project distiller.

```ts
expect(result.payload?.practiceLedger).toMatchObject({
  sourceId: "source-1",
  practices: [{ id: "practice-boundary-validation" }],
});
expect(projectDistillCalls[0]?.practiceLedger.practices[0]?.id).toBe(
  "practice-boundary-validation",
);
expect(projectResult.payload?.applicabilityMatrix).toMatchObject({
  assessments: [{ practiceId: "practice-boundary-validation", status: "applicable" }],
});
```

- [ ] **Step 2: Run the two stage tests and verify RED**

Run: `nub run test -- tests/macro-workflow/sourceToProject/harnesses.test.ts -t "typed payload|applicability matrix"`

Expected: FAIL because the harness does not yet persist the ledger/matrix payloads or call the source-conditioned project distiller.

- [ ] **Step 3: Change the BAML distillation functions**

Change `DistillSourceAnalysis` to return the generated `SourcePracticeLedgerDraft`. Replace `DistillProjectBrief` with this source-conditioned function:

```baml
function DistillProjectApplicability(
  projectJson: string,
  practiceLedger: SourcePracticeLedger,
  rawResearch: string
) -> ProjectApplicabilityMatrix {
  client CopilotProxyGpt5Mini
  prompt #"
    {{ _.role("system") }}
    Assess every source practice against the target project. Return each supplied practiceId exactly once.
    Applicable and partial decisions require exact target-project evidence and target layers.
    Not-applicable decisions require contradictory project evidence. Missing evidence means unknown.

    {{ _.role("user") }}
    Project JSON:
    {{ projectJson }}

    Canonical source practice ledger:
    {{ practiceLedger }}

    Raw project research transcript:
    {{ rawResearch }}

    {{ ctx.output_format }}
  "#
}
```

Keep `SourceAnalysis` and `ProjectBrief` only as temporary compatibility projections built by these TypeScript helpers; all downstream compiler calls use `SourcePracticeLedger` and `ProjectApplicabilityMatrix` as authoritative:

```ts
export function sourceAnalysisFromLedger(ledger: SourcePracticeLedger): SourceAnalysis {
  return {
    sourceId: ledger.sourceId,
    title: ledger.summary,
    accessLevel: "local",
    summary: ledger.summary,
    claims: [...ledger.claims],
    transferableLessons: ledger.practices.map((practice) => practice.behavior),
    evidence: [...ledger.evidence],
  };
}

export function projectBriefFromMatrix(
  project: ProjectCatalogEntry,
  matrix: ProjectApplicabilityMatrix,
): ProjectBrief {
  return {
    projectId: project.id,
    displayName: project.displayName,
    architecture: matrix.architecture,
    constraints: [...matrix.constraints],
    goals: [],
    changeSurfaces: [...new Set(matrix.assessments.flatMap((item) => item.targetLayers))],
    validationCommands: [...matrix.validationCommands],
    risks: matrix.assessments
      .filter((item) => item.status === "unknown")
      .map((item) => `Unknown applicability: ${item.practiceId}`),
    evidence: [...matrix.evidence],
  };
}
```

- [ ] **Step 4: Generate the client**

Run: `nub run baml-generate`

Expected: generation succeeds and the new types/functions appear under `src/generated/baml_client/**`.

- [ ] **Step 5: Wire the client interface and stage payloads**

Update `SourceToProjectBamlClient`:

```ts
DistillSourceAnalysis(
  sourceArtifactJson: string,
  rawResearch: string,
): Promise<SourcePracticeLedgerDraft>;
DistillProjectApplicability(
  projectJson: string,
  practiceLedger: SourcePracticeLedger,
  rawResearch: string,
): Promise<ProjectApplicabilityMatrix>;
```

In `source-reading`, call `compilePracticeLedger` and persist both the canonical ledger and the compatibility `sourceAnalysis`. In `project-research`, pass the canonical ledger into `DistillProjectApplicability`, validate it, and persist both the matrix and compatibility `projectBrief`.

- [ ] **Step 6: Run generation and focused tests**

Run: `nub run baml-generate && nub run test -- tests/macro-workflow/sourceToProject/harnesses.test.ts -t "typed payload|applicability matrix"`

Expected: PASS.

- [ ] **Step 7: Commit the typed semantic boundary**

```bash
git add baml_src/source_to_project.baml src/generated/baml_client src/macro-workflow/sourceToProject/harnesses.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
git commit -m "feat(source-to-project): model practice applicability"
```

## Task 3: Add bounded applicability evidence repair

**Files:**

- Modify: `baml_src/source_to_project.baml`
- Modify: `src/generated/baml_client/**`
- Modify: `src/macro-workflow/sourceToProject/prompts.ts`
- Modify: `tests/macro-workflow/sourceToProject/prompts.test.ts`
- Modify: `src/macro-workflow/sourceToProject/harnesses.ts`
- Modify: `tests/macro-workflow/sourceToProject/harnesses.test.ts`

- [ ] **Step 1: Write failing unknown-practice repair tests**

Create one harness test where the initial matrix contains one `unknown`, the Copilot research stub receives a narrowly scoped repair prompt, `RepairProjectApplicability` returns `applicable`, and the node passes. Create another where repair remains `unknown` and assert rejection with `Unresolved applicability`.

```ts
expect(researchPrompts[1]).toContain("Investigate only these unresolved source practices");
expect(researchPrompts[1]).toContain("practice-rule-compatibility");
expect(bamlCalls.filter((name) => name === "RepairProjectApplicability")).toHaveLength(1);
await expect(runProjectResearch(unresolvedRepairClient)).rejects.toThrow(
  /Unresolved applicability.*practice-rule-compatibility/,
);
```

- [ ] **Step 2: Run repair tests and verify RED**

Run: `nub run test -- tests/macro-workflow/sourceToProject/harnesses.test.ts -t "applicability evidence repair"`

Expected: FAIL because there is no repair prompt or BAML function.

- [ ] **Step 3: Add the repair prompt and BAML function**

```ts
export function buildApplicabilityEvidenceRepairPrompt(args: {
  objective: string;
  projectJson: string;
  unresolvedPracticeIds: string[];
  initialMatrixJson: string;
  maxToolCalls: number;
}): string {
  return [
    "Investigate only these unresolved source practices in the target project.",
    "Find direct project evidence that establishes fit or contradiction. Do not broaden into a repository overview.",
    `Hard budget: use at most ${args.maxToolCalls} tool calls.`,
    `Objective:\n${args.objective}`,
    `Project JSON:\n${args.projectJson}`,
    `Unresolved practice IDs:\n${args.unresolvedPracticeIds.join("\n")}`,
    `Initial applicability matrix:\n${args.initialMatrixJson}`,
  ].join("\n\n");
}
```

```baml
function RepairProjectApplicability(
  practiceLedger: SourcePracticeLedger,
  initialMatrix: ProjectApplicabilityMatrix,
  rawRepairResearch: string
) -> ProjectApplicabilityMatrix {
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    Return a fresh complete matrix for every practiceId. Change unknown only when the repair transcript contains direct project evidence.
    Never turn absence of evidence into not-applicable.

    {{ _.role("user") }}
    Practice ledger:
    {{ practiceLedger }}

    Initial matrix:
    {{ initialMatrix }}

    Targeted repair research:
    {{ rawRepairResearch }}

    {{ ctx.output_format }}
  "#
}
```

- [ ] **Step 4: Enforce exactly one repair call**

Use a local `unknownAssessments` check in the project-research adapter. Run one Copilot research call with a fixed `20`-tool budget, call `RepairProjectApplicability`, validate the full matrix, and throw if any status remains `unknown`. Record both calls in execution metadata.

- [ ] **Step 5: Generate and rerun focused tests**

Run: `nub run baml-generate && nub run test -- tests/macro-workflow/sourceToProject/prompts.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts -t "applicability"`

Expected: PASS.

- [ ] **Step 6: Commit evidence repair**

```bash
git add baml_src/source_to_project.baml src/generated/baml_client src/macro-workflow/sourceToProject/prompts.ts src/macro-workflow/sourceToProject/harnesses.ts tests/macro-workflow/sourceToProject/prompts.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
git commit -m "feat(source-to-project): repair unknown applicability once"
```

## Task 4: Make opportunity mapping coverage-driven

**Files:**

- Modify: `baml_src/source_to_project.baml`
- Modify: `src/generated/baml_client/**`
- Modify: `src/macro-workflow/sourceToProject/portfolioCompiler.ts`
- Modify: `tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts`
- Modify: `src/macro-workflow/sourceToProject/harnesses.ts`
- Modify: `tests/macro-workflow/sourceToProject/harnesses.test.ts`

- [ ] **Step 1: Write failing exact-coverage and minimum-set tests**

```ts
it("selects a minimal coverage-complete opportunity set", () => {
  const result = selectCoverageCompleteCandidates({
    requiredBehaviorIds: ["p/behavior-1", "p/behavior-2"],
    candidates: [
      candidate("narrow-a", ["p/behavior-1"], 0.9),
      candidate("narrow-b", ["p/behavior-2"], 0.8),
      candidate("bundle", ["p/behavior-1", "p/behavior-2"], 0.85),
    ],
  });
  expect(result.map((candidate) => candidate.id)).toEqual(["bundle"]);
});

it("fails when council output leaves an applicable behavior uncovered", () => {
  expect(() =>
    validateOpportunityCoverage(requiredCoverageFixture(), [
      opportunityFixture({ behaviorIds: ["p/behavior-1"] }),
    ]),
  ).toThrow(/missing.*p\/behavior-2/);
});
```

- [ ] **Step 2: Run the focused compiler tests and verify RED**

Run: `nub run test -- tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts -t "coverage-complete|uncovered"`

Expected: FAIL because the coverage functions do not exist.

- [ ] **Step 3: Extend opportunity contracts and mapping prompt**

Add required fields to `Opportunity` and `OpportunityBundle`:

```baml
practiceIds string[]
behaviorIds string[]
targetLayers string[]
proofIds string[]
```

Change `MapSourceToProject` inputs to `practiceLedger`, `corroboration`, and `applicabilityMatrix`. Its prompt must require exact supplied IDs, prohibit opportunities for `not-applicable`/`unknown`, and require all applicable behavior IDs to be covered.

- [ ] **Step 4: Implement deterministic coverage validation and set cover**

In `portfolioCompiler.ts`, add:

```ts
export function validateOpportunityCoverage(
  required: RequiredCoverage,
  opportunities: Opportunity[],
): void {
  assertExactSet(
    opportunities.flatMap((opportunity) => opportunity.behaviorIds),
    required.behaviorIds,
    "opportunity behavior coverage",
    { allowDuplicates: true },
  );
  assertExactSet(
    opportunities.flatMap((opportunity) => opportunity.proofIds),
    required.proofIds,
    "opportunity proof coverage",
    { allowDuplicates: true },
  );
  for (const opportunity of opportunities) {
    assertSubset(opportunity.practiceIds, required.practiceIds, "opportunity practice ids");
    assertSubset(opportunity.proofIds, required.proofIds, "opportunity proof ids");
    if (opportunity.targetLayers.length === 0) {
      throw new Error(`${opportunity.id} requires at least one target layer.`);
    }
  }
}
```

Implement `selectCoverageCompleteCandidates` as deterministic greedy set cover: maximize newly covered required behavior count, then higher acceptance score, then lexicographically smaller candidate ID. Throw with sorted uncovered IDs if no candidate advances coverage. Do not cap away required coverage.

- [ ] **Step 5: Wire council selection to required coverage**

Compute `requiredCoverage(ledger, matrix)` in `opportunity-mapping`, validate the BAML result, persist `opportunityCoverage`, and have `council-review` promote the deterministic coverage-complete set. Scalar thresholds rank redundant alternatives but cannot remove the last carrier of a required behavior.

- [ ] **Step 6: Generate and run compiler plus harness tests**

Run: `nub run baml-generate && nub run test -- tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts -t "coverage"`

Expected: PASS.

- [ ] **Step 7: Commit coverage-driven selection**

```bash
git add baml_src/source_to_project.baml src/generated/baml_client src/macro-workflow/sourceToProject/portfolioCompiler.ts src/macro-workflow/sourceToProject/harnesses.ts tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
git commit -m "feat(source-to-project): preserve opportunity coverage"
```

## Task 5: Add deterministic adaptive planning routes

**Files:**

- Modify: `src/macro-workflow/sourceToProject/portfolioCompiler.ts`
- Modify: `tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts`
- Modify: `src/macro-workflow/sourceToProject/harnesses.ts:2650-3118`
- Modify: `tests/macro-workflow/sourceToProject/harnesses.test.ts:1500-1740`

- [ ] **Step 1: Write failing route tests**

```ts
expect(selectPortfolioPlanningRoute([singleCandidate])).toEqual({
  kind: "direct",
  reason: "one accepted opportunity covers the required behavior set",
});
expect(selectPortfolioPlanningRoute([promotedBundle])).toMatchObject({ kind: "direct" });
expect(selectPortfolioPlanningRoute([independentIngress, independentRendering])).toEqual({
  kind: "child-synthesis",
  reason: "2 independent accepted change surfaces require focused child plans",
});
```

Add harness assertions:

```ts
expect(directNodes.map((node) => node.id)).toEqual([
  "plan-portfolio",
  "audit-portfolio",
  "report-portfolio",
]);
expect(directNodes[0]?.dependsOn).toEqual(["council-review"]);
expect(childNodes.find((node) => node.id === "plan-portfolio")?.dependsOn).toEqual([
  "review-opportunity-ingress",
  "review-opportunity-rendering",
]);
```

- [ ] **Step 2: Run route tests and verify RED**

Run: `nub run test -- tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts -t "planning route|canonical portfolio"`

Expected: FAIL because every candidate currently produces a child plan.

- [ ] **Step 3: Implement route selection**

```ts
export type PortfolioPlanningRoute =
  { kind: "direct"; reason: string } | { kind: "child-synthesis"; reason: string };

export type PortfolioPlanningCandidate = {
  id: string;
  kind: "opportunity" | "bundle";
  behaviorIds: string[];
  targetLayers: string[];
};

export function selectPortfolioPlanningRoute(
  candidates: PortfolioPlanningCandidate[],
): PortfolioPlanningRoute {
  if (candidates.length === 1) {
    return {
      kind: "direct",
      reason:
        candidates[0]?.kind === "bundle"
          ? "one promoted bundle covers the required behavior set"
          : "one accepted opportunity covers the required behavior set",
    };
  }
  return {
    kind: "child-synthesis",
    reason: `${candidates.length} independent accepted change surfaces require focused child plans`,
  };
}
```

- [ ] **Step 4: Rebuild dynamic expansion around the route**

For `direct`, create no opportunity plan/review/report nodes. Build `plan-portfolio` with `dependsOn: ["council-review"]` and the accepted candidates in its input. For `child-synthesis`, retain focused child plan and review nodes, then depend on their review IDs. Replace the generic `review-portfolio` with `audit-portfolio`; the audit becomes the acceptance gate. Persist route kind and reason in node input and execution metadata.

For autonomous PR mode, make implementation depend on the audited `report-portfolio` result so direct planning does not require synthetic child plans.

- [ ] **Step 5: Run route and existing dynamic-expansion tests**

Run: `nub run test -- tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts -t "planning route|portfolio|dynamic"`

Expected: PASS after updating obsolete node-order assertions to the approved route semantics.

- [ ] **Step 6: Commit adaptive routing**

```bash
git add src/macro-workflow/sourceToProject/portfolioCompiler.ts src/macro-workflow/sourceToProject/harnesses.ts tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
git commit -m "feat(source-to-project): plan portfolios adaptively"
```

## Task 6: Make direct and child prompts consume the compiler representations

**Files:**

- Modify: `src/macro-workflow/sourceToProject/prompts.ts`
- Modify: `tests/macro-workflow/sourceToProject/prompts.test.ts`
- Modify: `src/macro-workflow/sourceToProject/harnesses.ts`
- Modify: `tests/macro-workflow/sourceToProject/harnesses.test.ts`

- [ ] **Step 1: Write failing prompt-contract tests**

```ts
expect(directPrompt).toContain("Canonical source practice ledger");
expect(directPrompt).toContain("Project applicability matrix");
expect(directPrompt).toContain("Required behavior IDs");
expect(directPrompt).not.toContain("Accepted opportunity plans:");
expect(childPrompt).toContain("Assigned behavior IDs");
expect(synthesisPrompt).toContain("Full required coverage set");
expect(synthesisPrompt).toContain("Independent child plans");
```

- [ ] **Step 2: Run prompt tests and verify RED**

Run: `nub run test -- tests/macro-workflow/sourceToProject/prompts.test.ts`

Expected: FAIL because the current prompt reconstructs a ledger from child prose.

- [ ] **Step 3: Replace the generic portfolio prompt with explicit variants**

Implement:

```ts
export function buildDirectPortfolioPlanPrompt(args: PortfolioPromptInput): string;
export function buildChildPlanPrompt(args: ChildPlanPromptInput): string;
export function buildPortfolioSynthesisPrompt(
  args: PortfolioPromptInput & { childPlans: Array<{ title: string; markdown: string }> },
): string;
```

All variants receive serialized canonical ledger, applicability matrix, required coverage, accepted opportunity coverage, target project, source/corroboration evidence, objective, and specialized obligations. Child prompts receive only assigned behavior/proof IDs plus shared constraints. Synthesis receives the full required set and child plans as evidence, not as immutable deliverable boundaries.

Keep the current target-project safety instructions and tool-integration guidance. Remove the instruction to build a ledger internally because the prompt now receives the canonical ledger.

- [ ] **Step 4: Wire route-specific prompts in `plan-portfolio` and opportunity planning**

Read route metadata from node input. Direct uses `buildDirectPortfolioPlanPrompt`; child opportunity nodes use `buildChildPlanPrompt`; child synthesis uses `buildPortfolioSynthesisPrompt`. Every Copilot call remains `mode: "plan"`, uses the target-project `cwd`, and preserves session plan capture.

- [ ] **Step 5: Run prompt and plan-adapter tests**

Run: `nub run test -- tests/macro-workflow/sourceToProject/prompts.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts -t "prompt|portfolio plan"`

Expected: PASS.

- [ ] **Step 6: Commit compiler-aware prompts**

```bash
git add src/macro-workflow/sourceToProject/prompts.ts src/macro-workflow/sourceToProject/harnesses.ts tests/macro-workflow/sourceToProject/prompts.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
git commit -m "feat(source-to-project): ground portfolio planning in coverage"
```

## Task 7: Add structured portfolio draft and semantic audit contracts

**Files:**

- Modify: `baml_src/source_to_project.baml`
- Modify: `src/generated/baml_client/**`
- Modify: `src/macro-workflow/sourceToProject/modelPolicy.ts`
- Modify: `tests/macro-workflow/sourceToProject/modelPolicy.test.ts`
- Modify: `src/macro-workflow/sourceToProject/harnesses.ts`
- Modify: `tests/macro-workflow/sourceToProject/harnesses.test.ts`

- [ ] **Step 1: Write failing draft/audit adapter tests**

Assert that after Copilot returns Markdown, the harness calls `DistillPortfolioPlanDraft`, validates exact quotes, then calls `AuditPortfolioCoverage`. Assert every BAML function is present in the model-policy map.

```ts
expect(bamlCalls).toEqual(["DistillPortfolioPlanDraft", "AuditPortfolioCoverage"]);
expect(result.payload?.portfolioAudit).toMatchObject({ passed: true, repairAttempted: false });
expect(sourceToProjectBamlFunctionRoute("AuditPortfolioCoverage").model).toBe("gpt-5.5");
```

- [ ] **Step 2: Run adapter and policy tests and verify RED**

Run: `nub run test -- tests/macro-workflow/sourceToProject/harnesses.test.ts tests/macro-workflow/sourceToProject/modelPolicy.test.ts -t "portfolio draft|portfolio audit|BAML function"`

Expected: FAIL because draft/audit functions do not exist.

- [ ] **Step 3: Add BAML plan/draft/audit declarations**

```baml
class PortfolioCoverageClaim {
  practiceId string
  behaviorIds string[]
  proofIds string[]
  targetLayers string[]
  evidenceQuotes string[]
}

class PortfolioPlanDraft {
  title string
  summary string
  markdown string
  coverageClaims PortfolioCoverageClaim[]
}

class PortfolioCoverageAssessment {
  behaviorId string
  status "complete" | "partial" | "missing" | "contradicted"
  responsibleLayer string
  evidenceQuotes string[]
  gaps string[]
  rationale string
}

class SpecializedObligationAssessment {
  obligationId string
  status "complete" | "partial" | "missing" | "not-required"
  evidenceQuotes string[]
  rationale string
}

class PortfolioCoverageAudit {
  behaviorAssessments PortfolioCoverageAssessment[]
  specializedAssessments SpecializedObligationAssessment[]
  unsupportedClaims string[]
  contradictions string[]
  summary string
}
```

Add `DistillPortfolioPlanDraft(compilerJson, planMarkdown)` using `CopilotProxyGpt5Mini` and `AuditPortfolioCoverage(compilerJson, draft)` using `CopilotProxyGpt55`. Both prompts treat inputs as untrusted, require exact IDs, and require byte-exact Markdown quotes.

- [ ] **Step 4: Extend deterministic draft/audit validation**

Add `validatePortfolioDraft(required, draft)` and `validatePortfolioAudit(required, obligations, draft, audit)` to `portfolioCompiler.ts`. They must reject duplicate/unknown/omitted IDs, missing claims, blank or non-substring quotes, non-complete required behaviors, unresolved contradictions, and missing specialized obligations. Allow deterministic pruning only for surplus invalid quotes when another exact quote remains.

- [ ] **Step 5: Generate client, route functions, and wire audit node**

Add `PORTFOLIO_AUDIT` and `PORTFOLIO_REPAIR` operations to the model policy. Map draft distillation to `gpt-5-mini`, audit and repair to `gpt-5.5`. The `audit-portfolio` adapter loads the canonical draft payload, runs semantic audit, applies deterministic validation, and returns `passed` only on complete coverage.

- [ ] **Step 6: Run generation and focused tests**

Run: `nub run baml-generate && nub run test -- tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts tests/macro-workflow/sourceToProject/modelPolicy.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts -t "portfolio draft|portfolio audit|BAML function"`

Expected: PASS.

- [ ] **Step 7: Commit structured audit**

```bash
git add baml_src/source_to_project.baml src/generated/baml_client src/macro-workflow/sourceToProject/modelPolicy.ts src/macro-workflow/sourceToProject/portfolioCompiler.ts src/macro-workflow/sourceToProject/harnesses.ts tests/macro-workflow/sourceToProject/modelPolicy.test.ts tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
git commit -m "feat(source-to-project): audit portfolio coverage"
```

## Task 8: Add one bounded plan repair and fail-closed publication

**Files:**

- Modify: `baml_src/source_to_project.baml`
- Modify: `src/generated/baml_client/**`
- Modify: `src/macro-workflow/sourceToProject/portfolioCompiler.ts`
- Modify: `src/macro-workflow/sourceToProject/harnesses.ts`
- Modify: `tests/macro-workflow/sourceToProject/harnesses.test.ts`

- [ ] **Step 1: Write failing repair state-machine tests**

Cover: initial pass (zero repair), initial partial then repaired pass (one repair), repaired partial (node fails), malformed repair (node fails), and repair output that changes upstream IDs (node fails).

```ts
expect(repairCalls).toHaveLength(1);
expect(result.payload?.portfolioAudit).toMatchObject({
  passed: true,
  repairAttempted: true,
  attempts: 1,
});
await expect(runPortfolio(unresolvedAfterRepair)).rejects.toThrow(
  /Portfolio coverage remains incomplete after one repair/,
);
```

- [ ] **Step 2: Run repair tests and verify RED**

Run: `nub run test -- tests/macro-workflow/sourceToProject/harnesses.test.ts -t "portfolio repair"`

Expected: FAIL because audit currently has no repair path.

- [ ] **Step 3: Add BAML repair function**

```baml
function RepairPortfolioPlan(
  compilerJson: string,
  draft: PortfolioPlanDraft,
  auditFeedback: string
) -> PortfolioPlanDraft {
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    Repair the plan markdown and coverage claims once. Resolve only the supplied deterministic and semantic gaps.
    Preserve the immutable practice, behavior, proof, project, opportunity, and route decisions in compilerJson.
    Return a fresh complete draft. Do not widen scope or invent project evidence.

    {{ _.role("user") }}
    Immutable compiler context:
    {{ compilerJson }}

    Initial draft:
    {{ draft }}

    Audit feedback:
    {{ auditFeedback }}

    {{ ctx.output_format }}
  "#
}
```

- [ ] **Step 4: Implement a two-state audit loop**

Use explicit states `initial` and `repaired`; there is no loop counter greater than one. On initial failure, call repair once, validate the fresh draft, rerun a fresh audit, and accept only a complete result. On repaired failure, throw with sorted remaining behavior/obligation IDs. Never turn operational failures into a low-quality plan.

- [ ] **Step 5: Generate and run repair tests**

Run: `nub run baml-generate && nub run test -- tests/macro-workflow/sourceToProject/harnesses.test.ts -t "portfolio repair"`

Expected: PASS.

- [ ] **Step 6: Commit bounded repair**

```bash
git add baml_src/source_to_project.baml src/generated/baml_client src/macro-workflow/sourceToProject/portfolioCompiler.ts src/macro-workflow/sourceToProject/harnesses.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
git commit -m "feat(source-to-project): repair portfolio coverage once"
```

## Task 9: Persist compiler artifacts, hashes, and canonical Markdown

**Files:**

- Create: `src/macro-workflow/sourceToProject/portfolioArtifacts.ts`
- Create: `tests/macro-workflow/sourceToProject/portfolioArtifacts.test.ts`
- Modify: `src/macro-workflow/sourceToProject/harnesses.ts`
- Modify: `tests/macro-workflow/sourceToProject/harnesses.test.ts`

- [ ] **Step 1: Write failing artifact-chain tests**

```ts
const published = await persistPortfolioCompilerArtifacts({
  outputDir,
  ledger,
  matrix,
  opportunityCoverage,
  initialDraft,
  initialAudit,
  finalDraft,
  finalAudit,
  repairAttempted: true,
});
expect(published.canonicalPlanPath).toBe("raw-plans/plan-portfolio-full.md");
expect(
  JSON.parse(await readFile(join(outputDir, "project-applicability-matrix.json"), "utf8")),
).toMatchObject({ schemaVersion: 1, inputDigests: { practiceLedger: expect.any(String) } });
await expect(
  readFile(join(outputDir, "portfolio-plan-draft.initial.json"), "utf8"),
).resolves.toContain(initialDraft.markdown);
await expect(readFile(join(outputDir, "raw-plans/plan-portfolio-full.md"), "utf8")).resolves.toBe(
  finalDraft.markdown,
);
await expect(
  verifyPortfolioCompilerArtifact(join(outputDir, "project-applicability-matrix.json"), {
    practiceLedger: "incorrect-digest",
  }),
).rejects.toThrow(/digest mismatch/);
```

- [ ] **Step 2: Run artifact tests and verify RED**

Run: `nub run test -- tests/macro-workflow/sourceToProject/portfolioArtifacts.test.ts`

Expected: FAIL because the artifact module does not exist.

- [ ] **Step 3: Implement schema-versioned linked artifacts**

Use `createHash("sha256")`, stable JSON serialization, atomic temporary-file rename, and relative `WorkflowArtifactRef` paths. Export `verifyPortfolioCompilerArtifact(path, expectedInputDigests)` and fail closed on any missing file, schema-version mismatch, or input-digest mismatch. Persist:

```text
source-practice-ledger.json
project-applicability-matrix.json
opportunity-coverage-map.json
portfolio-plan-draft.initial.json
portfolio-coverage-audit.initial.json
portfolio-plan-draft.final.json
portfolio-coverage-audit.final.json
raw-plans/plan-portfolio-transcript.md
raw-plans/plan-portfolio-full.md
```

Each JSON envelope is `{ schemaVersion: 1, inputDigests, value }`. The canonical full Markdown is always the final audited draft, never the unrepaired session file. Preserve the Copilot transcript separately.

- [ ] **Step 4: Wire artifact publication after final audit only**

The planning adapter may persist the transcript and initial draft, but `report-portfolio` publishes the canonical `plan-portfolio-full.md` only when the final audit passes. Failed runs retain draft/audit diagnostics and expose no passing canonical plan artifact.

- [ ] **Step 5: Run artifact and canonical-plan evaluator tests**

Run: `nub run test -- tests/macro-workflow/sourceToProject/portfolioArtifacts.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts tests/eval/sourceToProjectVerification/weavekitPlan.test.ts`

Expected: PASS, including evaluator preference for `plan-portfolio-full.md`.

- [ ] **Step 6: Commit persistence**

```bash
git add src/macro-workflow/sourceToProject/portfolioArtifacts.ts src/macro-workflow/sourceToProject/harnesses.ts tests/macro-workflow/sourceToProject/portfolioArtifacts.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
git commit -m "feat(source-to-project): persist audited portfolio artifacts"
```

## Task 10: Add specialized obligations and observability

**Files:**

- Modify: `src/macro-workflow/sourceToProject/portfolioCompiler.ts`
- Modify: `tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts`
- Modify: `src/macro-workflow/sourceToProject/prompts.ts`
- Modify: `tests/macro-workflow/sourceToProject/prompts.test.ts`
- Modify: `src/macro-workflow/sourceToProject/harnesses.ts`
- Modify: `tests/macro-workflow/sourceToProject/harnesses.test.ts`

- [ ] **Step 1: Write failing obligation and metadata tests**

```ts
expect(specializedObligationsFor("tool-integration").map((item) => item.id)).toEqual([
  "tool-installation",
  "configuration-translation",
  "compatibility-inventory",
  "workflow-enforcement",
  "migration-and-cleanup",
  "rollback",
]);
expect(result.execution?.metadata).toMatchObject({
  practiceCounts: { applicable: 2, partial: 1, notApplicable: 1, unknown: 0 },
  requiredBehaviorCount: 4,
  planningRoute: "child-synthesis",
  evidenceRepairAttempted: false,
  portfolioRepairAttempted: true,
  finalAuditStatus: "passed",
});
```

- [ ] **Step 2: Run obligation tests and verify RED**

Run: `nub run test -- tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts -t "specialized obligation|compiler metadata"`

Expected: FAIL because obligation catalogs and metadata are absent.

- [ ] **Step 3: Implement immutable obligation catalogs**

Use an `as const` object keyed by `tool-integration`, `code-change`, `workflow-process`, and `documentation`. Return deduplicated obligations for all accepted opportunity change kinds. Include the exact obligations from the approved spec; do not encode source-specific tools or paths.

- [ ] **Step 4: Add obligations to prompts/audits and execution metadata**

Serialize selected obligations into direct, child, synthesis, audit, and repair inputs. Record practice/applicability counts, required/covered behavior counts, opportunity/bundle counts, route/reason, initial gap counts, repair flags, final audit status, and existing model/latency/token/cost metadata in workflow events and Langfuse execution metadata.

- [ ] **Step 5: Run focused tests**

Run: `nub run test -- tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts tests/macro-workflow/sourceToProject/prompts.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts -t "obligation|metadata"`

Expected: PASS.

- [ ] **Step 6: Commit obligations and telemetry**

```bash
git add src/macro-workflow/sourceToProject/portfolioCompiler.ts src/macro-workflow/sourceToProject/prompts.ts src/macro-workflow/sourceToProject/harnesses.ts tests/macro-workflow/sourceToProject/portfolioCompiler.test.ts tests/macro-workflow/sourceToProject/prompts.test.ts tests/macro-workflow/sourceToProject/harnesses.test.ts
git commit -m "feat(source-to-project): trace portfolio compiler quality"
```

## Task 11: Add the three missing immutable benchmark cases

**Files:**

- Create: `evals/source-to-project/cases/eslint-to-oxlint.yaml`
- Create: `evals/source-to-project/cases/github-pattern-transfer.yaml`
- Create: `evals/source-to-project/cases/evidence-backed-partial-adoption.yaml`
- Create: fixture files under `evals/source-to-project/fixtures/<case-id>/source.md`
- Create: fixture projects under `evals/source-to-project/fixtures/<case-id>/project/`
- Modify: `tests/eval/sourceToProjectVerification/case.test.ts`

- [ ] **Step 1: Write failing table-driven case tests**

```ts
it.each([
  "todo-safe-write-path",
  "eslint-to-oxlint",
  "github-pattern-transfer",
  "evidence-backed-partial-adoption",
])("loads and fingerprints %s", async (caseId) => {
  const definition = loadProjectVerificationCase(`evals/source-to-project/cases/${caseId}.yaml`);
  expect(definition.id).toBe(caseId);
  expect(definition.expectedPractices.length).toBeGreaterThan(0);
  expect(await fingerprintProjectVerificationCase(definition)).toMatch(/^[a-f0-9]{64}$/);
});
```

- [ ] **Step 2: Run case tests and verify RED**

Run: `nub run test -- tests/eval/sourceToProjectVerification/case.test.ts`

Expected: FAIL for the three missing case files.

- [ ] **Step 3: Build the ESLint-to-Oxlint fixture**

The source explains Oxlint installation, rule/plugin compatibility, staged coexistence, configuration, CI/editor enforcement, migration, and rollback. The target project contains `package.json`, `eslint.config.js`, `.github/workflows/ci.yml`, `src/`, and tests with real ESLint scripts. Expected actions require inventorying unsupported rules, introducing Oxlint, retaining only justified ESLint compatibility, updating scripts/CI/docs, running both tools during migration, dependency cleanup, and rollback.

- [ ] **Step 4: Build the GitHub pattern-transfer fixture**

Use a local source snapshot describing three independently adoptable repository patterns: explicit boundary validation, output escaping, and deterministic fixture-driven integration tests. The target project has separate HTTP adapter, renderer, and integration-test surfaces. Expected actions require correct layer assignment and one cohesive final plan while permitting child planning internally.

- [ ] **Step 5: Build the partial/non-adoption fixture**

Use a source containing a generally useful cache, queue, and retry pattern. The target is an offline, single-process, deterministic batch tool whose existing bounded retry already satisfies one practice and whose architecture contradicts a durable queue. Exactly one practice should be adopted, one partially adapted, and one rejected with concrete project evidence. Anti-goals prohibit adding Redis, a durable queue, or network infrastructure.

- [ ] **Step 6: Run case tests**

Run: `nub run test -- tests/eval/sourceToProjectVerification/case.test.ts`

Expected: PASS for all four immutable cases.

- [ ] **Step 7: Commit evaluation fixtures**

```bash
git add evals/source-to-project/cases evals/source-to-project/fixtures tests/eval/sourceToProjectVerification/case.test.ts
git commit -m "test(eval): add source-to-project reliability cases"
```

## Task 12: Add matrix orchestration and the reliability gate

**Files:**

- Create: `src/eval/sourceToProjectVerification/matrix.ts`
- Create: `tests/eval/sourceToProjectVerification/matrix.test.ts`
- Create: `evals/source-to-project/matrix.yaml`
- Modify: `src/eval-source-to-project-cli.ts`
- Modify: `tests/eval-source-to-project-cli.test.ts`
- Modify: `src/eval/sourceToProjectVerification/scorecard.ts`
- Modify: `tests/eval/sourceToProjectVerification/scorecard.test.ts`

- [ ] **Step 1: Write failing deterministic gate tests**

```ts
const result = evaluateReliabilityGate(
  matrixFixture({
    weavekitVsCodexWins: 7,
    weavekitVsCodexLosses: 3,
    weavekitVsCopilotWins: 8,
    weavekitVsCopilotLosses: 2,
    codexMeanMargin: 0.03,
    copilotMeanMargin: 0.04,
    worstCaseCodexMargin: -0.01,
    worstCaseCopilotMargin: -0.02,
  }),
);
expect(result.passed).toBe(true);
expect(evaluateReliabilityGate(matrixFixture({ worstCaseCodexMargin: -0.021 })).passed).toBe(false);
expect(evaluateReliabilityGate(matrixFixture({ invalidProviderRuns: 1 })).passed).toBe(false);
```

- [ ] **Step 2: Run matrix tests and verify RED**

Run: `nub run test -- tests/eval/sourceToProjectVerification/matrix.test.ts tests/eval-source-to-project-cli.test.ts`

Expected: FAIL because matrix orchestration does not exist.

- [ ] **Step 3: Implement sequential trial orchestration with bounded provider concurrency**

`runProjectVerificationMatrix` loads the matrix, runs each case exactly three times through `runSourceToProjectVerification`, persists each trial directory, then writes `matrix-scorecard.json` and `matrix-summary.md`. Reuse the existing provider collector and judge panel; never reimplement judging. Preserve quality, pairwise reliability, provider failures, invalid judgments, latency, tokens, and cost as separate fields.

- [ ] **Step 4: Implement the exact approved reliability gate**

The gate passes only when:

```ts
return {
  passed:
    codex.majorityWins &&
    copilot.majorityWins &&
    codex.meanQualityMargin > 0 &&
    copilot.meanQualityMargin > 0 &&
    codex.worstCaseMeanMargin >= -0.02 &&
    copilot.worstCaseMeanMargin >= -0.02 &&
    codex.reliableWins > codex.reliableLosses &&
    copilot.reliableWins > copilot.reliableLosses &&
    input.invalidProviderRuns === 0 &&
    input.invalidJudgePanels === 0 &&
    input.unauditedWeavekitPlans === 0,
  checks,
};
```

Disputed comparisons do not count as wins or losses. Provider/judge failures are reported and make the matrix incomplete, not baseline losses.

- [ ] **Step 5: Add CLI flags and compatibility rules**

Add `--matrix <path>` and `--trials <positive integer>`. Default matrix trials come from YAML and must equal `3` for the acceptance run. Reject `--matrix` combined with `--case`, `--rejudge-from`, or single-run baseline flags. Keep all existing single-case invocations unchanged.

- [ ] **Step 6: Render quality and efficiency separately**

The Markdown summary leads with the gate and quality margins, then agreed/disputed pairwise counts, then provider failures, and finally median/p95 latency, tokens, and cost. Efficiency never changes `passed`.

- [ ] **Step 7: Run matrix, CLI, and scorecard tests**

Run: `nub run test -- tests/eval/sourceToProjectVerification/matrix.test.ts tests/eval-source-to-project-cli.test.ts tests/eval/sourceToProjectVerification/scorecard.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit matrix orchestration**

```bash
git add src/eval/sourceToProjectVerification/matrix.ts src/eval-source-to-project-cli.ts src/eval/sourceToProjectVerification/scorecard.ts tests/eval/sourceToProjectVerification/matrix.test.ts tests/eval-source-to-project-cli.test.ts tests/eval/sourceToProjectVerification/scorecard.test.ts evals/source-to-project/matrix.yaml
git commit -m "feat(eval): gate source-to-project reliability"
```

## Task 13: Document and run repository-wide verification

**Files:**

- Modify: `README.md`
- Modify: any source/test file required to resolve verification failures caused by Tasks 1-12

- [ ] **Step 1: Document exact operator commands**

Add:

```sh
nub run eval:source-to-project -- --case evals/source-to-project/cases/eslint-to-oxlint.yaml
nub run eval:source-to-project -- --matrix evals/source-to-project/matrix.yaml --trials 3
```

Document compiler artifacts, judge-only replay, quality gate semantics, and separate efficiency diagnostics.

- [ ] **Step 2: Regenerate and format**

Run: `nub run baml-generate && nub run fmt`

Expected: both commands exit 0.

- [ ] **Step 3: Run static validation**

Run: `nub run typecheck && nub run lint && mise run doctor`

Expected: all commands exit 0 with no warnings promoted to errors.

- [ ] **Step 4: Run the complete test suite**

Run: `nub run test`

Expected: every test file passes; record the exact file/test count in the completion audit.

- [ ] **Step 5: Commit verification/documentation fixes**

```bash
git add README.md baml_src src tests evals/source-to-project
git commit -m "docs(source-to-project): operate portfolio compiler"
```

Before committing, inspect `git diff --cached --name-only` and remove any unrelated user-owned paths from the index.

## Task 14: Run the live twelve-trial benchmark and close only on evidence

**Files:**

- Generate: `evals/source-to-project/results/<matrix-run-id>/matrix-scorecard.json`
- Generate: `evals/source-to-project/results/<matrix-run-id>/matrix-summary.md`
- Modify: implementation and tests only when benchmark evidence identifies an in-scope compiler defect

- [ ] **Step 1: Run workflow entity validation immediately before live execution**

Run: `mise run doctor`

Expected: PASS.

- [ ] **Step 2: Run the complete paired matrix**

Run: `nub run eval:source-to-project -- --matrix evals/source-to-project/matrix.yaml --trials 3`

Expected: twelve trials, each with frozen Weavekit/Codex/Copilot plans, valid two-model absolute judgments, counterbalanced pairwise judgments, and audited Weavekit canonical plans.

- [ ] **Step 3: Inspect the persisted matrix evidence**

Verify from JSON rather than terminal summaries:

- case IDs and trial counts are exact;
- every plan digest verifies;
- every Weavekit plan has a passing final portfolio audit and no manual edits;
- Weavekit wins a majority against each baseline;
- mean margins against both baselines are positive;
- no case mean deficit is below `-0.02`;
- reliable agreed wins outnumber reliable agreed losses against each baseline;
- disputed/invalid/provider failures are separate;
- latency/token/cost diagnostics are present but absent from the quality formula.

- [ ] **Step 4: Diagnose and fix any failed gate at the failing compiler transition**

Use the persisted ledger, matrix, opportunity map, draft, audit, judge evidence, and pairwise rationale to locate the loss. Add a reproducing test first, make the narrow compiler/BAML/prompt correction, run focused tests, then rerun `nub run baml-generate`, `nub run typecheck`, `nub run lint`, `nub run test`, and the full twelve-trial matrix. Do not tune expected case actions into generation prompts.

- [ ] **Step 5: Perform the requirement-by-requirement completion audit**

Create a checklist from every Goals, Architecture, Error handling, Testing, Evaluation, and Rollout requirement in `docs/superpowers/specs/2026-07-11-source-to-project-portfolio-compiler-design.md`. For each item, cite current code, a passing test, or a persisted live artifact. Any missing or indirect evidence keeps the goal active.

- [ ] **Step 6: Mark the goal complete only after the audit and reliability gate pass**

Run `git status --short`, preserve unrelated user changes, and report the final commit list, exact validation outputs, matrix result path, quality margins, pairwise counts, and efficiency diagnostics. Call the goal completion tool only when no required work remains.
