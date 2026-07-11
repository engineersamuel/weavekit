# Source-to-Project Portfolio Compiler Design

Date: 2026-07-11
Status: Approved design awaiting written-spec review

## Context

The source-to-project workflow exists to learn transferable practices from a source artifact, determine which of those practices fit a target project, and produce one implementation-ready plan that improves that project. The source may be a blog post or GitHub repository. A representative case is learning from an Oxlint article and planning an ESLint-to-Oxlint migration in a project that currently uses ESLint.

The BAML judge now compares one canonical Weavekit portfolio plan with Codex and Copilot plans generated from the same immutable source, target-project snapshot, objective, and anti-goals. The controlled todo case scored Weavekit strongly, but one case cannot establish reliability. The workflow must preserve and plan all applicable source practices across varied cases rather than relying on prompt polish or opportunity count.

The current workflow has useful stages—source analysis, corroboration, project research, opportunity mapping, council review, per-opportunity planning, and portfolio synthesis—but its contracts do not make end-to-end practice coverage explicit. Source lessons are free-form strings, opportunity selection can narrow the evidence before planning, and the canonical portfolio is asked to reconstruct a coverage ledger from prose. When three opportunities are found, that fan-out is diagnostic rather than inherently good or bad: the final plan is good only if it covers the applicable source practices once, at the correct project layers, with concrete proof.

## Problem statement

Weavekit can produce a polished plan while still losing information at one of four transitions:

1. Source analysis may merge or omit distinct practices.
2. Project research may not decide whether every practice applies.
3. Opportunity selection may drop an applicable practice or duplicate it across opportunities.
4. Child planning or portfolio synthesis may omit a required behavior, proof obligation, or architectural layer.

The workflow needs a compiler-like intermediate representation that makes those losses observable and fail-closed. It must also avoid negative transfer: a source practice that does not fit the project should be explicitly rejected based on cited project evidence, not forced into the plan merely to maximize coverage.

## Goals

The design must:

1. Give every source practice a stable identity and explicit evidence, adoption preconditions, required behavior, and proof obligations.
2. Classify every practice against target-project evidence before opportunity selection.
3. Require every opportunity and plan to declare which practice IDs it covers.
4. Bundle overlapping work without losing applicable practices or rewarding a larger opportunity count.
5. Produce one canonical portfolio plan for every run, including runs with one accepted opportunity.
6. Choose direct portfolio planning or child-plan synthesis based on the number of independent change surfaces.
7. Audit semantic coverage and deterministic ID/evidence invariants before accepting the portfolio.
8. Permit one bounded repair and fail closed when required coverage remains unresolved.
9. Treat cited project contradiction as the only valid reason to skip an otherwise applicable source practice.
10. Improve plan quality without combining latency, tokens, or cost into the quality score.
11. Support domain-neutral practice transfer while adding specialized obligations for tool integrations, code changes, workflow/process changes, and documentation.

## Non-goals

- Do not optimize the workflow specifically for the todo or Oxlint benchmark cases.
- Do not hard-code source-specific practice names, project paths, tools, or commands.
- Do not reward the number of discovered opportunities, child plans, files, steps, or words.
- Do not require every source practice to be adopted; evidence-backed partial or non-adoption is valid.
- Do not use the judge's expected actions as generation input. Benchmark references remain evaluation-only.
- Do not let an LLM calculate coverage counts or decide whether required IDs are present.
- Do not make the workflow mutate or execute the target project during planning.
- Do not replace the existing BAML judge, Promptfoo provider collection, or canonical scorecard contracts.
- Do not add a durable work queue or a second orchestration system.

## Design principles

### Preserve information before optimizing scope

The workflow first records the complete source-practice set and project applicability decisions. It optimizes opportunity boundaries only after those facts are explicit. Deduplication may merge work, but it may not erase required behavior.

### Separate semantic judgment from deterministic validation

LLMs decide what the source means, whether a practice fits, and whether a plan semantically fulfills it. TypeScript verifies identities, referential integrity, exact coverage sets, evidence references, status transitions, and repair bounds.

### Optimize the canonical plan, not the fan-out

Child opportunities and plans are internal compilation artifacts. The public result and leaderboard unit remain one canonical portfolio plan. A single opportunity still passes through the canonical portfolio contract so that generation and evaluation semantics do not change with opportunity count.

### Reject negative transfer explicitly

Non-adoption is a first-class successful result when cited target-project evidence disproves an adoption precondition or shows that the behavior already exists. Absence of evidence is not contradictory evidence.

## Architecture

The revised workflow compiles source knowledge into a canonical plan through five typed representations:

```text
source artifact
  -> SourcePracticeLedger
  -> ProjectApplicabilityMatrix
  -> CoverageDrivenOpportunitySet
  -> PortfolioPlanDraft
  -> PortfolioCoverageAudit
  -> canonical portfolio plan
```

The existing source-reading, corroboration, project-research, council, planning, and reporting nodes remain orchestration stages. BAML contracts become the context boundary between stages, while TypeScript owns deterministic validation, routing, persistence, and bounded repair.

### 1. SourcePracticeLedger

Source distillation emits a ledger rather than only free-form claims and lessons. Each practice is independently adoptable and independently verifiable.

```baml
class SourcePractice {
  id string
  title string
  behavior string
  rationale string
  adoptionPreconditions string[]
  requiredBehaviors string[]
  proofObligations string[]
  evidence EvidenceReference[]
}

class SourcePracticeLedger {
  sourceId string
  summary string
  practices SourcePractice[]
  claims string[]
  evidence EvidenceReference[]
}
```

Practice granularity follows a behavioral test: two teachings are separate practices when a target project could reasonably adopt one without the other or prove them with different evidence. Examples, marketing claims, and implementation trivia are not promoted to practices unless they imply transferable behavior.

#### Stable practice IDs

The LLM proposes semantic slugs, and the harness canonicalizes them within a run:

```text
practice-<normalized-semantic-slug>
practice-<normalized-semantic-slug>-2
```

Normalization lowercases ASCII text, replaces non-alphanumeric runs with one hyphen, trims hyphens, and rejects empty slugs. Duplicate semantic slugs receive deterministic source-order suffixes. The harness persists the canonical ledger before downstream calls; downstream stages may reference IDs but may not rename or invent them.

Stable means deterministic for identical source bytes and source-distillation output. Cross-model semantic equivalence is not required. The immutable ledger artifact and its digest define identity for the remainder of a run and for replay.

### 2. ProjectApplicabilityMatrix

Project research evaluates every ledger practice against the target project. It does not return a generic repository overview.

```baml
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

Status semantics are strict:

- `applicable`: all material required behaviors fit and have direct project evidence for the change surface.
- `partial`: only an explicit subset fits, or adoption requires a bounded adaptation. Applicable and excluded behaviors must both be named.
- `not-applicable`: a precondition is disproved, the behavior already exists, or adoption conflicts with project architecture or goals. `contradictionEvidence` is required.
- `unknown`: available evidence cannot establish fit or contradiction. Unknown practices cannot silently become accepted opportunities.

For `applicable` and `partial`, at least one project evidence reference and one target architectural layer are required. For `not-applicable`, at least one contradiction reference is required. `unknown` records the missing evidence in its rationale and is surfaced as an unresolved planning diagnostic.

### 3. Coverage-driven opportunities

Opportunity mapping consumes the immutable ledger and applicability matrix. Every opportunity declares the exact practices and behaviors it covers.

The existing `Opportunity` contract gains:

```baml
practiceIds string[]
behaviorIds string[]
targetLayers string[]
proofIds string[]
```

Required behaviors receive deterministic IDs scoped to their practice:

```text
<practice-id>/behavior-<one-based-index>
<practice-id>/proof-<one-based-index>
```

The harness derives these IDs from ledger order. LLM outputs reference them but do not author them.

Opportunity construction obeys these invariants:

1. Every applicable behavior appears in at least one accepted opportunity.
2. A partially applicable practice contributes only its explicitly applicable behaviors.
3. A non-applicable or unknown practice appears in no accepted opportunity.
4. Every referenced practice, behavior, proof obligation, evidence ID, and target layer exists in upstream artifacts.
5. Duplicate coverage is allowed only when separate architectural layers require coordinated work; the overlap must be declared in bundling rationale.

Bundling minimizes duplicated planning. Opportunities sharing a change surface, user-visible outcome, ordering dependency, or proof path should become one bundle when separation would repeat the same implementation work. Independent change surfaces remain separate child opportunities so each can be planned with focused context.

The council reviews the complete coverage map, not only scalar opportunity scores. It may reject speculative or low-value work, but it cannot reject an applicable practice behavior without changing the applicability decision and supplying cited contradictory project evidence. Deterministic validation rejects a council result that leaves applicable behavior IDs uncovered.

### 4. Adaptive planning

The planner selects one of two internal paths while always producing the same canonical output contract.

#### Direct portfolio path

Use direct portfolio planning when all accepted work forms one cohesive change surface. This includes a single accepted opportunity and multiple tightly coupled opportunities that touch the same architecture, migration, and proof path.

The prompt receives the ledger, applicability matrix, coverage map, source evidence, project evidence, and target-project metadata. It drafts the canonical portfolio directly. It does not generate a child plan merely to synthesize it back into equivalent prose.

#### Child-plan synthesis path

Use child plans when accepted opportunities have independent change surfaces that can be understood and implemented separately. Each child receives only its assigned practice behaviors plus shared project constraints. The portfolio synthesizer receives all child plans and the full upstream coverage map, reconciles ordering and shared files, and emits one canonical plan.

#### Deterministic route selection

The LLM declares opportunity target layers and shared change surfaces. TypeScript chooses the path:

- direct when there is one accepted opportunity or one promoted bundle containing all accepted behavior IDs;
- child synthesis when two or more accepted opportunities remain outside a common promoted bundle.

The route and reason are persisted in workflow state and trace metadata. The route never changes what counts as required coverage.

### 5. PortfolioPlanDraft

The planner returns structured metadata alongside Markdown so coverage does not have to be recovered solely from prose.

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
```

The Markdown remains the user-facing plan and leaderboard artifact. Coverage claims are internal trace evidence. Each evidence quote must be a verbatim excerpt from the Markdown and must describe a concrete implementation or verification action, not merely repeat a practice title.

The plan must include:

- the target-project problem and expected value;
- ordered implementation steps with concrete project files, modules, or discovery instructions;
- behavior, data, error, and compatibility contracts appropriate to the change;
- migration and rollback considerations when state, tooling, or workflows change;
- focused unit and real integration/adapter proof where those layers exist;
- exact existing validation commands, or explicit steps to add stable commands when missing;
- scope boundaries and evidence-backed non-adoption decisions that materially affect implementation.

## Specialized planning obligations

The core contracts remain domain-neutral. `changeKind` activates additional obligations without replacing general coverage requirements.

### Tool integration

- Use the named tool's real installation and configuration surfaces.
- Inventory the existing tool's scripts, configuration, plugins, ignore rules, editor/CI wiring, and behavior that must be preserved.
- Plan configuration translation, content or code migration, enforcement, dependency cleanup, documentation, and rollback.
- Validate with the new tool's real CLI and the project's stable scripts.
- For replacement migrations such as ESLint to Oxlint, explicitly identify unsupported or semantically different rules and retain a justified compatibility layer when full replacement is unsafe.

### Code change

- Assign behavior to the correct domain, boundary, adapter, or persistence layer.
- Specify input, output, error, compatibility, and migration contracts.
- Preserve evidence-named edge cases and pair focused tests with real adapter or integration tests where applicable.

### Workflow or process change

- Identify the trigger, actors, state transitions, failure recovery, observability, and ownership.
- Update the actual automation or operating documentation that enforces the process.
- Prove both the happy path and recovery or rollback behavior.

### Documentation

- Identify the audience, decision or task the documentation enables, canonical location, and stale or conflicting material to replace.
- Include link, example, command, and retrieval checks appropriate to the project.
- Do not represent documentation-only work as code or tool adoption unless the project evidence requires it.

## Portfolio coverage audit

The audit runs after either planning path and before the canonical Markdown is accepted.

### Deterministic validation

TypeScript validates:

- the ledger and applicability matrix each cover the exact expected practice-ID set;
- applicable behavior and proof IDs equal the required coverage set;
- opportunity references are valid and accepted opportunities cover that set;
- portfolio claims reference only accepted IDs and cover the exact required set;
- each claim has at least one verbatim Markdown quote;
- all quoted text exists byte-for-byte in the draft;
- non-applicable practices carry contradiction evidence;
- no unknown practice is presented as adopted;
- every specialized obligation selected by `changeKind` has an audit assessment;
- no stage contains duplicate IDs or unknown evidence references.

Any deterministic failure blocks acceptance and is included in repair input.

### Semantic BAML audit

The BAML auditor receives the immutable ledger, applicability matrix, accepted coverage map, specialized obligations, project constraints, and plan draft.

```baml
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

The auditor must return every required behavior and selected specialized obligation exactly once. Evidence quotes are checked against the Markdown. An LLM classification never overrides a deterministic ID or quote failure.

The draft passes only when every applicable behavior is `complete`, every selected specialized obligation is `complete` or validly `not-required`, no contradiction remains, and deterministic validation succeeds. `partial` is a repairable failure, not a passing score.

### Bounded repair

At most one repair call is allowed. The repair prompt receives the original draft, exact deterministic errors, semantic gaps, and relevant upstream evidence. It may edit the Markdown and coverage claims, but it may not change the ledger, applicability decisions, accepted behavior set, project snapshot, or planning route.

After repair, both deterministic and semantic audits rerun from scratch. If any required assessment is partial, missing, contradicted, malformed, or unsupported, the portfolio fails closed. The workflow persists the rejected drafts and audits for diagnosis but does not report a passing canonical plan.

Deterministic pruning may remove surplus unsupported evidence quotes from otherwise valid audit results. It may not invent quotes, change statuses, fill missing IDs, or rewrite the plan.

## Negative-transfer rules

Skipping source guidance is valid only under one of these evidence-backed conditions:

1. A source adoption precondition is false in the target project.
2. The target already provides the required behavior and proof.
3. The practice conflicts with a documented architecture, user goal, security requirement, or platform constraint.
4. Only part of the practice fits, and the excluded behaviors have cited contradiction evidence.

Cost, unfamiliarity, weak confidence, or lack of project evidence cannot produce `not-applicable`. Those conditions produce `unknown` or a risk attached to an applicable decision. An unknown practice prevents a fully passing portfolio until the workflow either gathers bounded additional project evidence or reports an explicit unresolved result.

The existing project-research budget remains bounded. The implementation may use one targeted evidence-repair research call for unknown practices, analogous to portfolio repair. That call must request only the missing facts, retain the same project snapshot, and be persisted in the trace. If the practice remains unknown, planning fails closed rather than assuming adoption or rejection.

## Persistence and observability

Each run persists the following artifacts in addition to existing workflow state and plans:

```text
source-practice-ledger.json
project-applicability-matrix.json
opportunity-coverage-map.json
portfolio-plan-draft.json
portfolio-coverage-audit.initial.json
portfolio-plan-repair.json              # only when repair runs
portfolio-coverage-audit.final.json
plan-portfolio.md
```

Every artifact records its schema version and the SHA-256 digests of direct inputs. Replays fail closed when an upstream digest differs.

Langfuse and workflow events record:

- practice counts by applicability status;
- required and covered behavior counts;
- opportunity and promoted-bundle counts;
- direct versus child-synthesis planning route;
- initial audit gap counts by status;
- whether evidence repair or portfolio repair ran;
- final audit status;
- model, latency, token, and estimated-cost metadata for each LLM call.

Quality is evaluated by the BAML judge. Latency, token use, and cost remain separate diagnostics and are never included in the quality score or pass gate.

## Error handling

The workflow fails closed for:

- missing, duplicate, or unknown practice, behavior, proof, obligation, or evidence IDs;
- an applicable or partial practice without project evidence or target layers;
- non-adoption without contradiction evidence;
- uncovered applicable behavior after council selection;
- an unknown practice after the bounded evidence-repair attempt;
- invalid structured output after normal BAML parsing/retry policy;
- plan coverage quotes not found in the canonical Markdown;
- any audit gap remaining after the one portfolio repair;
- digest mismatch during replay or resume.

Transport, parse, audit, and generation failures remain operational failures. They are not converted into a low-quality plan score. Failure artifacts and the last valid upstream representation remain available for diagnosis and resume.

## Compatibility and migration

The implementation evolves the current `SourceAnalysis`, `ProjectBrief`, `Opportunity`, and portfolio-planning path without changing the public benchmark unit.

- BAML-generated types remain canonical for LLM-produced representations.
- Workflow-specific routing, hashes, validation results, and artifact metadata remain local TypeScript types.
- Existing source and project summary fields may remain during a transition, but downstream planning must use the ledger and matrix as authoritative inputs.
- Existing runs without compiler artifacts remain readable for historical dashboards and judge-only replay; they are not resumable into the new compiler stages.
- The canonical output path remains `plan-portfolio.md` or the existing full-portfolio equivalent selected by the evaluator.
- Opportunity-level plans and reviews remain diagnostics and must not become separate leaderboard entries.

## Testing strategy

Implementation follows test-driven development at each boundary.

### Contract and deterministic unit tests

- stable practice, behavior, and proof ID derivation;
- exact-set and referential-integrity validation;
- applicability status/evidence invariants;
- opportunity coverage and bundle promotion invariants;
- direct versus child-synthesis route selection;
- Markdown quote verification and safe rendering;
- one-repair limit and fail-closed state transitions;
- digest verification and legacy-run compatibility.

### Prompt and adapter tests

- source distillation preserves independently adoptable practices;
- project research assesses every practice and cites target evidence;
- opportunity prompts receive and return stable coverage IDs;
- direct and child planners receive the complete required coverage set;
- specialized obligations appear only for the selected change kinds;
- repair prompts cannot alter upstream decisions or widen scope;
- Copilot SDK prompts append the generated `ctx.output_format` contract.

### Workflow integration tests

- a single opportunity still produces and audits a canonical portfolio;
- three overlapping opportunities are bundled without duplicate or lost coverage;
- independent opportunities use child plans and synthesize one portfolio;
- a non-applicable practice with contradiction evidence passes without adoption;
- unsupported non-adoption, unresolved unknowns, and post-repair omissions fail closed;
- workflow state, events, artifacts, hashes, and trace metadata agree.

## Evaluation and acceptance

The feature is not accepted based only on unit tests or the existing todo result. It must be evaluated against immutable cases using the approved BAML judge, with the same source, project snapshot, objective, anti-goals, and baseline-generation policy for all providers.

The initial benchmark matrix contains four case types:

1. Existing todo vertical-slice case.
2. ESLint-to-Oxlint migration case covering configuration, rule compatibility, scripts, CI/editor enforcement, migration, documentation, proof, and rollback.
3. GitHub-repository pattern-transfer case with multiple independently applicable practices.
4. Partial or no-adoption case that rewards evidence-backed restraint and detects negative transfer.

Run three paired trials per case. Each trial collects fresh Weavekit, Codex, and Copilot plans and freezes them before judging. Judge-only replay is allowed for calibration but does not replace the paired generation trials.

The reliability gate passes only when all conditions hold across the twelve trials:

- Weavekit wins a majority of comparisons against Codex and separately against Copilot.
- Weavekit has a positive mean absolute quality-score margin against Codex and separately against Copilot.
- No individual case has a mean Weavekit quality-score deficit greater than `0.02` against either baseline.
- Agreed pairwise wins for Weavekit outnumber agreed pairwise losses against each baseline.
- Every Weavekit plan used in scoring passed the portfolio coverage audit without manual editing.
- Provider failures, invalid judgments, and disputed comparisons are reported separately and do not count as wins.

Quality is the primary acceptance measure. Median latency, p95 latency, token use, and estimated cost are reported by provider and workflow stage as diagnostics. A quality win does not conceal a material efficiency regression.

## Implementation boundaries

The primary implementation surfaces are:

- `baml_src/source_to_project.baml` for ledger, matrix, planning, audit, and repair contracts;
- generated BAML client output under `src/generated/**`;
- `src/macro-workflow/sourceToProject/prompts.ts` for evidence- and coverage-aware prompts;
- `src/macro-workflow/sourceToProject/harnesses.ts` for stage orchestration, route selection, validation, persistence, repair bounds, and trace metadata;
- focused source-to-project modules extracted from `harnesses.ts` when they provide deep interfaces for IDs, coverage validation, planning routes, or artifact persistence;
- source-to-project tests and evaluation case fixtures;
- evaluator configuration only where new cases or result summaries are required, without weakening the approved judge.

Implementation should extract pure deterministic compiler operations from the large harness rather than adding another intertwined block. The harness coordinates those modules; it does not reimplement semantic reasoning that belongs in BAML and the LLM.

## Rollout

1. Add typed ledger and applicability contracts plus deterministic validators behind focused tests.
2. Make opportunity mapping coverage-driven and enforce council coverage invariants.
3. Add deterministic adaptive routing and the structured portfolio draft contract.
4. Add semantic coverage audit, one bounded repair, persistence, and observability.
5. Preserve existing behavior while migrating prompts and canonical output selection.
6. Add the four-case benchmark fixtures and run three paired trials per case.
7. Audit every requirement in this spec against code, tests, artifacts, and benchmark results before declaring the goal complete.

No default path should bypass the ledger, applicability matrix, or final audit after rollout. If the reliability gate fails, use persisted coverage and judge evidence to identify the failing transition, revise the compiler within this design, and rerun the affected paired trials plus the full acceptance matrix before completion.
