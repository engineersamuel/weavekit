# Decision Council Eval Corpus & Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a committed corpus of ~15 open-ended technical *decision* questions, each with a detailed reference answer and rubric, plus a thin promptfoo harness that runs the Decision Council and a vanilla Copilot CLI baseline against each question and grades both with a reference-guided LLM judge.

**Architecture:** A Zod-validated YAML corpus (`evals/corpus/*.yaml`) is loaded into typed `CorpusItem`s. Two promptfoo custom providers answer each question — `CouncilProvider` (in-memory `runDecisionCouncil`) and `CopilotCliProvider` (spawns `copilot -p` in an isolated temp dir, the no-extra-prompting baseline). `buildSuite` turns each corpus item into a promptfoo `EvaluateTestSuite` with one weighted `g-eval` assertion per rubric criterion (reference-guided) plus a corroborating `select-best` pairwise assertion. `runEval` executes the suite and writes a timestamped report under `evals/results/` (gitignored).

**Tech Stack:** TypeScript (NodeNext ESM), Zod, `yaml`, `promptfoo`, Vitest, `tsx`, the existing Decision Council (`@github/copilot-sdk` + BAML), and the `copilot` CLI.

## Global Constraints

- **NodeNext ESM:** every relative import MUST end in `.js` (e.g. `import { x } from "./schema.js"`). The repo is `"module": "NodeNext"`, `"strict": true`.
- **Tests location:** Vitest only collects `tests/**/*.test.ts` (see `vitest.config.ts`). All new tests go under `tests/eval/`. Use the globals `describe`/`it`/`expect` (configured via `"types": ["node","vitest/globals"]`) — do NOT import them.
- **Test → src import convention:** tests import source with a relative path and `.js` extension, e.g. `import { loadCorpus } from "../../src/eval/schema.js"`.
- **Council public API (verified):** `import { runDecisionCouncil } from "../../index.js"`. Signature: `runDecisionCouncil(input: { prompt: string; context?: string[]; constraints?: string[]; personaSetName?: string }, options?: RunDecisionCouncilOptions): Promise<DecisionCouncilReport>`. Pass `{ deps: { writeArtifacts: false } }` to avoid writing to `runs/`.
- **`DecisionCouncilReport` fields (verified):** `recommendation: string`, `rationale: string[]`, `strongestObjections: string[]`, `unresolvedQuestions: string[]`, `confidence: number`, `convergence: number`, `nextExperiment: string`, `finalReportMarkdown: string`, `failedPersonas: DecisionPersonaFailure[]`.
- **Vanilla baseline command (verified, copilot 1.0.65):** `copilot -p <prompt> --allow-all --no-color --model <model> -C <tempdir>`. Run in an isolated temp CWD with a hard timeout; capture stdout only. No memory/extra prompting in `-p` mode — this is the "just ask the LLM" baseline.
- **Grader:** an OpenAI-compatible judge, default `http://127.0.0.1:8080/v1` (the local Copilot proxy), overridable via env `EVAL_JUDGE_BASE_URL` / `EVAL_JUDGE_API_KEY` / `EVAL_JUDGE_MODEL`. Judge temperature 0.
- **Results are ephemeral:** `evals/results/` is gitignored; `evals/corpus/*.yaml` is committed.
- **Package name stays `weavekit`** (the Glueplane rename is not applied to `package.json`; do not touch it here).
- **Methodology source of truth:** `docs/superpowers/specs/2026-06-25-decision-council-eval-corpus-design.md` (prior art: CAKE rubric schema, MT-Bench reference-guided + pairwise judging, DeliberationBench council-vs-single framing).
- DRY, YAGNI, TDD, frequent commits.

## Prerequisite (already satisfied)

Baseline is green on branch `safe-gale`: `npm run typecheck`, `npm test` (64 passing), and `npm run build` all succeed, and `runDecisionCouncil` is the live exported symbol. Do NOT start if these are red — re-run them first.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `evals/corpus/*.yaml` | One decision question + reference answer + rubric per file (committed data). |
| `evals/results/<ts>/` | Per-run `report.json` + `summary.md` (gitignored). |
| `src/eval/schema.ts` | `CorpusItem` Zod schema, `loadCorpusItem`/`loadCorpus`, `formatQuestion`/`formatReference`. |
| `src/eval/providers/council.ts` | `CouncilProvider` — promptfoo provider wrapping `runDecisionCouncil`. |
| `src/eval/providers/copilot.ts` | `CopilotCliProvider` — promptfoo provider spawning `copilot -p`. |
| `src/eval/buildSuite.ts` | Pure: `CorpusItem[]` → promptfoo `EvaluateTestSuite` (assertions + judge config). |
| `src/eval/run.ts` | `runEval` — load corpus, build suite, call `evaluate`, write report. |
| `src/eval-cli.ts` | Thin CLI entry (`npm run eval [id ...]`). |
| `tests/eval/*.test.ts` | Unit tests for schema, providers, buildSuite, run. |

---

## Task 1: Scaffolding — dependencies, script, gitignore

**Files:**
- Modify: `package.json` (dependencies + scripts)
- Modify: `.gitignore`

**Interfaces:**
- Produces: the `promptfoo` and `yaml` packages on disk; the `eval` npm script; `evals/results/` ignored.

- [ ] **Step 1: Add deps and the `eval` script to `package.json`**

Edit the `"scripts"` block to add the `eval` line (keep existing scripts):

```json
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "baml-generate": "baml-cli generate",
    "build": "npm run baml-generate && tsc -p tsconfig.json",
    "council": "tsx src/cli.ts",
    "eval": "tsx src/eval-cli.ts"
  },
```

- [ ] **Step 2: Install the new dependencies**

Run: `npm install yaml promptfoo`
Expected: both added under `dependencies` in `package.json`; `node_modules/promptfoo` and `node_modules/yaml` exist. (promptfoo is large; allow a minute.)

- [ ] **Step 3: Ignore the results directory**

Append to `.gitignore`:

```
evals/results/
```

- [ ] **Step 4: Verify baseline still compiles**

Run: `npm run typecheck`
Expected: exits 0 (adding deps must not break the build).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore(eval): add promptfoo + yaml deps and eval script"
```

---

## Task 2: Corpus schema, loader, and formatters

**Files:**
- Create: `src/eval/schema.ts`
- Test: `tests/eval/schema.test.ts`

**Interfaces:**
- Produces:
  - `type CorpusItem = { id, domain, difficulty, title, prompt, context: string[], constraints: string[], referenceAnswer: ReferenceAnswer, rubric: RubricCriterion[] }`
  - `type ReferenceAnswer = { recommendation, rationale[], strongestObjections[], conditions[], viableAlternatives[], redFlags[], sources[] }`
  - `type RubricCriterion = { criterion: string; weight: number; levels: string }`
  - `loadCorpusItem(yamlText: string): CorpusItem`
  - `loadCorpus(dir: string): CorpusItem[]` (sorted, unique-id checked)
  - `formatQuestion(item: CorpusItem): string`
  - `formatReference(ref: ReferenceAnswer): string`

- [ ] **Step 1: Write the failing test**

Create `tests/eval/schema.test.ts`:

```ts
import { loadCorpusItem, formatQuestion, formatReference } from "../../src/eval/schema.js";

const VALID = `
id: sample-001
domain: sample
difficulty: intermediate
title: Sample decision
prompt: Should we use A or B?
context:
  - We are a small team.
constraints:
  - Keep it simple.
referenceAnswer:
  recommendation: Use A for simple cases.
  rationale:
    - A is simpler.
  strongestObjections:
    - B scales better.
  conditions:
    - Choose B at very large scale.
  viableAlternatives:
    - B
  redFlags:
    - Do not pick C for this.
  sources:
    - https://example.com/a-vs-b
rubric:
  - criterion: defensible-recommendation
    weight: 0.5
    levels: Full credit for a clear, defensible pick.
  - criterion: tradeoffs-and-objections
    weight: 0.5
    levels: Full credit for surfacing the key tradeoffs.
`;

describe("loadCorpusItem", () => {
  it("parses a valid item", () => {
    const item = loadCorpusItem(VALID);
    expect(item.id).toBe("sample-001");
    expect(item.referenceAnswer.sources).toEqual(["https://example.com/a-vs-b"]);
  });

  it("rejects rubric weights that do not sum to 1", () => {
    const bad = VALID.replace("weight: 0.5\n    levels: Full credit for surfacing the key tradeoffs.",
      "weight: 0.9\n    levels: Full credit for surfacing the key tradeoffs.");
    expect(() => loadCorpusItem(bad)).toThrow(/weights must sum/i);
  });

  it("rejects a missing recommendation", () => {
    const bad = VALID.replace("recommendation: Use A for simple cases.", "");
    expect(() => loadCorpusItem(bad)).toThrow();
  });

  it("formats the question with context and constraints", () => {
    const q = formatQuestion(loadCorpusItem(VALID));
    expect(q).toContain("Should we use A or B?");
    expect(q).toContain("We are a small team.");
    expect(q).toContain("Keep it simple.");
  });

  it("formats the reference into a grader block", () => {
    const r = formatReference(loadCorpusItem(VALID).referenceAnswer);
    expect(r).toContain("Recommendation: Use A for simple cases.");
    expect(r).toContain("B scales better.");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/eval/schema.test.ts`
Expected: FAIL — cannot find module `../../src/eval/schema.js`.

- [ ] **Step 3: Implement the schema and helpers**

Create `src/eval/schema.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const DIFFICULTIES = ["intro", "intermediate", "advanced"] as const;

export const ReferenceAnswerSchema = z.object({
  recommendation: z.string().min(1),
  rationale: z.array(z.string().min(1)).min(1),
  strongestObjections: z.array(z.string().min(1)).min(1),
  conditions: z.array(z.string().min(1)).default([]),
  viableAlternatives: z.array(z.string().min(1)).default([]),
  redFlags: z.array(z.string().min(1)).default([]),
  sources: z.array(z.string().url()).default([]),
});

export type ReferenceAnswer = z.infer<typeof ReferenceAnswerSchema>;

export const RubricCriterionSchema = z.object({
  criterion: z.string().min(1),
  weight: z.number().gt(0).le(1),
  levels: z.string().min(1),
});

export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export const CorpusItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be kebab-case"),
  domain: z.string().min(1),
  difficulty: z.enum(DIFFICULTIES),
  title: z.string().min(1),
  prompt: z.string().min(1),
  context: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  referenceAnswer: ReferenceAnswerSchema,
  rubric: z
    .array(RubricCriterionSchema)
    .min(1)
    .refine(
      (rubric) => Math.abs(rubric.reduce((sum, c) => sum + c.weight, 0) - 1) < 1e-3,
      { message: "rubric weights must sum to 1.0" },
    ),
});

export type CorpusItem = z.infer<typeof CorpusItemSchema>;

export function loadCorpusItem(yamlText: string): CorpusItem {
  return CorpusItemSchema.parse(parseYaml(yamlText));
}

export function loadCorpus(dir: string): CorpusItem[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  const items = files.map((file) => {
    try {
      return loadCorpusItem(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      throw new Error(`Failed to load corpus item ${file}: ${(error as Error).message}`);
    }
  });
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate corpus id: ${item.id}`);
    seen.add(item.id);
  }
  return items;
}

export function formatQuestion(item: CorpusItem): string {
  const parts = [item.prompt];
  if (item.context.length > 0) {
    parts.push("\nContext:\n" + item.context.map((c) => `- ${c}`).join("\n"));
  }
  if (item.constraints.length > 0) {
    parts.push("\nConstraints:\n" + item.constraints.map((c) => `- ${c}`).join("\n"));
  }
  return parts.join("\n");
}

export function formatReference(ref: ReferenceAnswer): string {
  const lines = [
    `Recommendation: ${ref.recommendation}`,
    `Rationale: ${ref.rationale.join("; ")}`,
    `Strongest objections to weigh: ${ref.strongestObjections.join("; ")}`,
  ];
  if (ref.conditions.length > 0) {
    lines.push(`Conditions favoring an alternative: ${ref.conditions.join("; ")}`);
  }
  if (ref.viableAlternatives.length > 0) {
    lines.push(`Viable alternatives: ${ref.viableAlternatives.join("; ")}`);
  }
  if (ref.redFlags.length > 0) {
    lines.push(`Anti-patterns / red flags to avoid: ${ref.redFlags.join("; ")}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/eval/schema.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/eval/schema.ts tests/eval/schema.test.ts
git commit -m "feat(eval): add corpus schema, loader, and formatters"
```

---

## Task 3: Seed corpus item + whole-corpus validation test

**Files:**
- Create: `evals/corpus/orchestration-framework-001.yaml`
- Test: `tests/eval/corpus.test.ts`

**Interfaces:**
- Consumes: `loadCorpus` from Task 2.
- Produces: the first committed corpus item and a guard test that loads the entire `evals/corpus/` directory (every later corpus task is validated by re-running this test).

**The standard rubric block (REUSED VERBATIM in every corpus item from here on):**

```yaml
rubric:
  - criterion: defensible-recommendation
    weight: 0.35
    levels: >-
      Full credit when the answer commits to a clear recommendation that matches
      the reference recommendation or a well-reasoned equivalent; half credit for
      a vague or weakly justified pick; no credit for no decision or an
      indefensible one.
  - criterion: tradeoffs-and-objections
    weight: 0.3
    levels: >-
      Full credit when the answer surfaces the major tradeoffs and the strongest
      objections in the reference; half credit for partial coverage; no credit
      when tradeoffs are ignored.
  - criterion: conditions-and-alternatives
    weight: 0.2
    levels: >-
      Full credit when the answer states the conditions under which a different
      choice (the reference alternatives) would be better; half credit for naming
      alternatives without conditions; no credit for none.
  - criterion: red-flags-avoided
    weight: 0.15
    levels: >-
      Full credit when the answer avoids the reference red flags / known
      anti-patterns; no credit when it recommends a flagged anti-pattern.
```

- [ ] **Step 1: Write the failing test**

Create `tests/eval/corpus.test.ts`:

```ts
import { loadCorpus } from "../../src/eval/schema.js";

describe("evals/corpus", () => {
  const items = loadCorpus("evals/corpus");

  it("loads at least one item", () => {
    expect(items.length).toBeGreaterThan(0);
  });

  it("has unique kebab-case ids", () => {
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("every rubric sums to 1.0", () => {
    for (const item of items) {
      const sum = item.rubric.reduce((s, c) => s + c.weight, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-3);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/eval/corpus.test.ts`
Expected: FAIL — `loadCorpus("evals/corpus")` throws (directory does not exist yet).

- [ ] **Step 3: Create the seed corpus item**

Create `evals/corpus/orchestration-framework-001.yaml` (derived from `examples/design-question.md`):

```yaml
id: orchestration-framework-001
domain: orchestration-framework
difficulty: advanced
title: Orchestration layer for a typed multi-persona Copilot-SDK council
prompt: >-
  We are building a v0 "design council" that fans out a decision prompt to
  several GitHub Copilot SDK persona sessions, then fans their critiques back in
  through BAML-typed contracts and a judge step. Which workflow/agent
  orchestration layer should we build on: Flue, Mastra, or LangGraph?
context:
  - The workflow is finite fan-out/fan-in with at most three rounds.
  - Outputs must be strongly typed via BAML for the fan-in/judge contracts.
  - The team wants a small public interface and Markdown + JSON artifacts.
constraints:
  - Keep the public interface small.
  - Stop in no more than three rounds.
  - Must emit Markdown and JSON artifacts.
  - Needs observability and the ability to manage multiple workflows.
referenceAnswer:
  recommendation: >-
    Build on a thin, typed finite-workflow runtime (Flue, or a small hand-rolled
    fan-out/fan-in loop) rather than a heavyweight agent framework, because the
    requirements are a bounded, finite workflow with typed BAML fan-in and a
    small surface. Reserve LangGraph/Mastra for when you actually need their
    heavier capabilities.
  rationale:
    - The workflow is finite (<=3 rounds) and well-structured, so a small typed
      runtime matches the problem without framework lock-in.
    - BAML already owns the typed contracts, so the orchestrator only needs
      reliable fan-out/fan-in, retries, and artifact emission.
    - A small public interface and easy multi-workflow management argue for
      minimal abstraction surface.
  strongestObjections:
    - LangGraph offers durable, cyclic graphs with checkpointing and a large
      ecosystem you would have to reimplement if requirements grow.
    - Mastra ships batteries-included agent primitives, memory, and hosting that
      could speed up later workflows.
    - A hand-rolled runtime risks reinventing retry/observability plumbing.
  conditions:
    - Choose LangGraph if you need durable execution, cyclic/branching graphs,
      human-in-the-loop checkpoints, or replay across many long-running flows.
    - Choose Mastra if you want an opinionated agent platform with built-in
      memory, tools, and deployment rather than a minimal seam.
  viableAlternatives:
    - LangGraph (durable cyclic graphs + checkpointing)
    - Mastra (batteries-included agent framework)
  redFlags:
    - Adopting LangGraph or Mastra purely for popularity when the workflow is a
      simple bounded fan-out/fan-in that a thin runtime handles.
  sources:
    - https://github.com/langchain-ai/langgraph
    - https://mastra.ai/
    - https://docs.boundaryml.com/
  # rubric: paste the standard rubric block here
rubric:
  - criterion: defensible-recommendation
    weight: 0.35
    levels: >-
      Full credit when the answer commits to a clear recommendation that matches
      the reference recommendation or a well-reasoned equivalent; half credit for
      a vague or weakly justified pick; no credit for no decision or an
      indefensible one.
  - criterion: tradeoffs-and-objections
    weight: 0.3
    levels: >-
      Full credit when the answer surfaces the major tradeoffs and the strongest
      objections in the reference; half credit for partial coverage; no credit
      when tradeoffs are ignored.
  - criterion: conditions-and-alternatives
    weight: 0.2
    levels: >-
      Full credit when the answer states the conditions under which a different
      choice (the reference alternatives) would be better; half credit for naming
      alternatives without conditions; no credit for none.
  - criterion: red-flags-avoided
    weight: 0.15
    levels: >-
      Full credit when the answer avoids the reference red flags / known
      anti-patterns; no credit when it recommends a flagged anti-pattern.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/eval/corpus.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add evals/corpus/orchestration-framework-001.yaml tests/eval/corpus.test.ts
git commit -m "feat(eval): add seed corpus item and corpus validation test"
```

---

## Tasks 4–7: Author the remaining 14 corpus items

For each item below: create `evals/corpus/<id>.yaml` with the fields shown, **append the standard rubric block verbatim** (from Task 3), then run `npx vitest run tests/eval/corpus.test.ts` (must stay green) and commit. Each YAML follows the exact shape of the seed item. Keep arrays to the bullets given; they are complete, not placeholders. `difficulty` is one of `intro` | `intermediate` | `advanced`.

### Task 4: data-store + second orchestration item (3 items)

**Files:** Create `evals/corpus/orchestration-framework-002.yaml`, `evals/corpus/data-store-001.yaml`, `evals/corpus/data-store-002.yaml`. Test: re-run `tests/eval/corpus.test.ts`.

- [ ] **Step 1 — `orchestration-framework-002.yaml`**

```yaml
id: orchestration-framework-002
domain: orchestration-framework
difficulty: intermediate
title: Durable long-running workflow engine
prompt: >-
  We need to run multi-step business workflows that can take hours to days, with
  retries, timeouts, and occasional human approval steps. Should we use Temporal,
  a cron + work-queue setup, or Airflow?
context:
  - Steps call external APIs that fail intermittently and must be retried.
  - Some workflows pause for human approval before continuing.
constraints:
  - Must survive process restarts without losing in-flight work.
  - Team is comfortable operating one new stateful system.
referenceAnswer:
  recommendation: >-
    Use Temporal (or an equivalent durable-execution engine) for stateful,
    long-running workflows that need retries, timers, and signals for
    human-in-the-loop steps.
  rationale:
    - Durable execution persists workflow state, so in-flight work survives
      restarts without bespoke checkpointing.
    - Built-in retries, timeouts, and signals directly model the retry and
      human-approval requirements.
  strongestObjections:
    - Temporal is a heavy stateful system to operate and learn.
    - For simple periodic jobs it is over-engineered.
  conditions:
    - Use cron + a work queue when workflows are short, mostly stateless periodic
      tasks.
    - Use Airflow when the work is scheduled batch/data-pipeline DAGs rather than
      per-request business workflows.
  viableAlternatives:
    - cron + durable work queue (SQS/RabbitMQ)
    - Airflow (DAG-oriented batch scheduling)
  redFlags:
    - Hand-rolling durable retries and state machines on a bare cron job for
      complex long-running workflows.
  sources:
    - https://docs.temporal.io/
    - https://airflow.apache.org/docs/
```

- [ ] **Step 2 — `data-store-001.yaml`**

```yaml
id: data-store-001
domain: data-store
difficulty: intermediate
title: Primary datastore for a transactional SaaS app
prompt: >-
  We are building a multi-tenant transactional SaaS app with clearly relational
  data (users, orgs, subscriptions, invoices) and moderate scale. Should our
  primary datastore be PostgreSQL, MongoDB, or DynamoDB?
context:
  - Data is highly relational with many cross-entity queries and reports.
  - Scale is moderate (thousands of tenants), not hyperscale.
constraints:
  - Strong consistency and transactions across related rows are required.
  - The team knows SQL.
referenceAnswer:
  recommendation: >-
    Use PostgreSQL as the primary datastore: it gives ACID transactions,
    relational integrity, rich querying, and JSONB for the occasional flexible
    field, which fits relational SaaS data at moderate scale.
  rationale:
    - Relational data with cross-entity queries and reporting is exactly the
      relational model's strength.
    - ACID transactions cover the consistency requirement out of the box.
    - JSONB provides schema flexibility without leaving Postgres.
  strongestObjections:
    - DynamoDB offers near-infinite scale and predictable latency with low ops.
    - MongoDB's flexible document model speeds early schema iteration.
  conditions:
    - Choose DynamoDB when access patterns are few and known up front and you
      need hyperscale on AWS with single-digit-ms latency.
    - Choose MongoDB when data is genuinely document-shaped with few cross-entity
      joins.
  viableAlternatives:
    - DynamoDB (single-table, hyperscale, known access patterns)
    - MongoDB (document model, flexible schema)
  redFlags:
    - Picking DynamoDB for ad-hoc relational/analytical queries it cannot serve
      efficiently.
  sources:
    - https://www.postgresql.org/docs/
    - https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html
```

- [ ] **Step 3 — `data-store-002.yaml`**

```yaml
id: data-store-002
domain: data-store
difficulty: advanced
title: Vector storage for RAG retrieval
prompt: >-
  We are adding retrieval-augmented generation over our docs. We already run
  PostgreSQL. Should we store and search embeddings in pgvector, or stand up a
  dedicated vector database like Qdrant or Pinecone?
context:
  - Corpus is on the order of a few hundred thousand chunks today.
  - We need metadata filtering alongside similarity search.
constraints:
  - Prefer to minimize new infrastructure if quality is comparable.
referenceAnswer:
  recommendation: >-
    Start with pgvector inside the existing PostgreSQL since the corpus is modest
    and you need metadata filtering next to your relational data; move to a
    dedicated vector DB only when scale or ANN features demand it.
  rationale:
    - At a few hundred thousand vectors, pgvector with an HNSW index performs
      well and avoids new infrastructure.
    - Co-locating embeddings with relational metadata makes filtered search a
      simple SQL join.
  strongestObjections:
    - Dedicated vector DBs (Qdrant, Pinecone) offer faster filtered ANN, sharding,
      and hybrid search at large scale.
    - pgvector can strain a primary OLTP database under heavy vector load.
  conditions:
    - Move to a dedicated vector DB when you exceed millions of vectors, need
      high-QPS filtered ANN, or want hybrid (keyword+vector) search built in.
  viableAlternatives:
    - Qdrant (self-hostable filtered ANN)
    - Pinecone (managed vector DB)
  redFlags:
    - Adding a separate vector database on day one for a small corpus you already
      could serve from Postgres.
  sources:
    - https://github.com/pgvector/pgvector
    - https://qdrant.tech/documentation/
```

- [ ] **Step 4: Validate and commit**

Run: `npx vitest run tests/eval/corpus.test.ts` → PASS.
```bash
git add evals/corpus/orchestration-framework-002.yaml evals/corpus/data-store-001.yaml evals/corpus/data-store-002.yaml
git commit -m "feat(eval): add orchestration-002 and data-store corpus items"
```

### Task 5: language-runtime + architecture-style (4 items)

**Files:** Create `language-runtime-001.yaml`, `language-runtime-002.yaml`, `architecture-style-001.yaml`, `architecture-style-002.yaml`. Test: re-run `tests/eval/corpus.test.ts`.

- [ ] **Step 1 — `language-runtime-001.yaml`**

```yaml
id: language-runtime-001
domain: language-runtime
difficulty: intermediate
title: Language for a high-throughput network service
prompt: >-
  We are writing a high-throughput, latency-sensitive network proxy/service.
  Should we write it in Go, Rust, or Node.js/TypeScript?
context:
  - Workload is heavily concurrent I/O with some CPU-bound parsing.
  - The team is mixed and ships on a deadline.
constraints:
  - Predictable tail latency matters.
  - Operational simplicity is valued.
referenceAnswer:
  recommendation: >-
    Default to Go: its goroutine concurrency, garbage collection, and simple
    deployment fit a high-throughput network service while keeping the team
    productive on a deadline.
  rationale:
    - Go's concurrency model and standard library suit network services with
      minimal ceremony.
    - Single static binary and mature tooling keep operations simple.
  strongestObjections:
    - Rust delivers the best tail latency and memory safety with no GC pauses for
      the hottest paths.
    - Node/TS maximizes team velocity if the team is JS-first and the work is
      I/O-bound.
  conditions:
    - Choose Rust when you need maximum performance, no GC pauses, or fine-grained
      memory control in the hot path and can absorb the learning curve.
    - Choose Node/TS when the service is I/O-bound glue and the team is JS-first.
  viableAlternatives:
    - Rust (max performance, no GC)
    - Node.js/TypeScript (team velocity, I/O-bound)
  redFlags:
    - Choosing Rust for a deadline-driven CRUD-ish service mainly for performance
      bragging rights.
  sources:
    - https://go.dev/doc/effective_go
    - https://doc.rust-lang.org/book/
```

- [ ] **Step 2 — `language-runtime-002.yaml`**

```yaml
id: language-runtime-002
domain: language-runtime
difficulty: intro
title: Language for an ML-adjacent backend with a web API
prompt: >-
  We are building a backend that does some data/ML work (feature processing,
  model inference) and also exposes a web API. Should we use Python, TypeScript,
  or Go?
context:
  - The ML/data ecosystem we depend on is Python-first.
  - The web API surface is modest.
constraints:
  - Reuse existing data-science code where possible.
referenceAnswer:
  recommendation: >-
    Use Python: the data/ML ecosystem is Python-first, so co-locating model code
    and a modest web API (FastAPI) avoids cross-language glue.
  rationale:
    - The ML libraries and existing data-science code are Python-native.
    - FastAPI gives a perfectly capable modern web API in the same language.
  strongestObjections:
    - TypeScript offers a stronger type system and is better if the product is
      web-first.
    - Go gives better raw performance and operational simplicity.
  conditions:
    - Choose TypeScript when the system is web-first with only light ML.
    - Choose Go when throughput/ops dominate and ML is offloaded to a service.
  viableAlternatives:
    - TypeScript (web-first)
    - Go (performance/ops)
  redFlags:
    - Splitting into two languages prematurely and paying serialization/glue cost
      for a modest API.
  sources:
    - https://fastapi.tiangolo.com/
    - https://docs.python.org/3/
```

- [ ] **Step 3 — `architecture-style-001.yaml`**

```yaml
id: architecture-style-001
domain: architecture-style
difficulty: intermediate
title: Monolith vs microservices for an early-stage product
prompt: >-
  We are an early-stage startup (3 engineers) building a new product. Should we
  start with a monolith, microservices, or a modular monolith?
context:
  - Requirements are still changing weekly.
  - No proven scaling bottlenecks yet.
constraints:
  - Optimize for shipping speed and low operational overhead.
referenceAnswer:
  recommendation: >-
    Start with a modular monolith: one deployable with clear internal module
    boundaries. Extract services later at proven seams when scaling or team
    boundaries demand it.
  rationale:
    - A single deployable minimizes operational overhead for a tiny team.
    - Internal module boundaries preserve the option to extract services later
      without distributed-systems cost now.
  strongestObjections:
    - Microservices give independent scaling and deployment and team autonomy.
    - Refactoring a monolith into services later is real work.
  conditions:
    - Move toward microservices when you have independent scaling needs, multiple
      teams needing deploy autonomy, or clear bounded contexts under load.
  viableAlternatives:
    - Microservices (independent scaling/teams)
    - Plain monolith (even simpler, weaker internal boundaries)
  redFlags:
    - Adopting microservices on day one with a 3-person team and unstable
      requirements.
  sources:
    - https://martinfowler.com/bliki/MonolithFirst.html
    - https://martinfowler.com/articles/microservices.html
```

- [ ] **Step 4 — `architecture-style-002.yaml`**

```yaml
id: architecture-style-002
domain: architecture-style
difficulty: advanced
title: Event-driven vs request/response for order processing
prompt: >-
  We are designing an order-processing system spanning checkout, payment,
  inventory, and fulfillment. Should the services communicate via event-driven
  messaging, synchronous request/response, or a hybrid?
context:
  - Some steps need an immediate answer to the user (payment authorization).
  - Other steps are side effects that can complete asynchronously.
constraints:
  - Must not lose orders if a downstream service is briefly down.
referenceAnswer:
  recommendation: >-
    Use a hybrid: synchronous request/response for the user-facing path that
    needs an immediate, consistent answer (e.g. payment authorization), and
    asynchronous events for cross-service side effects (inventory, fulfillment)
    to decouple and tolerate downstream outages.
  rationale:
    - User-facing steps need immediate, consistent responses, which sync calls
      provide simply.
    - Side effects benefit from event decoupling and durable queues so a brief
      outage does not lose orders.
  strongestObjections:
    - A hybrid means operating both styles and reasoning about eventual
      consistency.
    - Fully event-driven maximizes decoupling and auditability.
  conditions:
    - Lean fully event-driven when nearly everything is async and you need a
      replayable event log/audit trail.
    - Lean mostly synchronous when the domain is simple and strong consistency is
      paramount.
  viableAlternatives:
    - Fully event-driven (max decoupling, eventual consistency)
    - Mostly synchronous request/response (simplicity, strong consistency)
  redFlags:
    - Going fully event-driven everywhere and pushing eventual-consistency
      complexity onto flows that needed a simple synchronous answer.
  sources:
    - https://martinfowler.com/articles/201701-event-driven.html
    - https://microservices.io/patterns/data/saga.html
```

- [ ] **Step 5: Validate and commit**

Run: `npx vitest run tests/eval/corpus.test.ts` → PASS.
```bash
git add evals/corpus/language-runtime-001.yaml evals/corpus/language-runtime-002.yaml evals/corpus/architecture-style-001.yaml evals/corpus/architecture-style-002.yaml
git commit -m "feat(eval): add language-runtime and architecture-style corpus items"
```

### Task 6: api-protocol + build-vs-buy (4 items)

**Files:** Create `api-protocol-001.yaml`, `api-protocol-002.yaml`, `build-vs-buy-001.yaml`, `build-vs-buy-002.yaml`. Test: re-run `tests/eval/corpus.test.ts`.

- [ ] **Step 1 — `api-protocol-001.yaml`**

```yaml
id: api-protocol-001
domain: api-protocol
difficulty: intermediate
title: API protocol for a public API with diverse clients
prompt: >-
  We are exposing a public API consumed by web, mobile, and third-party
  developers. Should the primary interface be REST, GraphQL, or gRPC?
context:
  - Third-party developers want something familiar and cacheable.
  - Clients fetch widely varying subsets of data.
constraints:
  - Must be easy for external developers to adopt.
referenceAnswer:
  recommendation: >-
    Use REST over HTTP as the public interface: it is the most familiar,
    cacheable, and tooling-friendly choice for diverse external clients. Consider
    GraphQL where varied client data-shaping is the dominant need.
  rationale:
    - REST's ubiquity, HTTP caching, and tooling lower the adoption barrier for
      third parties.
    - It works uniformly across web, mobile, and server clients.
  strongestObjections:
    - GraphQL eliminates over/under-fetching when clients need very different data
      shapes.
    - gRPC offers the best performance and typed contracts for service-to-service.
  conditions:
    - Choose GraphQL when client-driven data shaping across many views is the core
      problem and you can handle caching/complexity.
    - Choose gRPC for internal, low-latency, strongly-typed service-to-service
      calls, not public browser traffic.
  viableAlternatives:
    - GraphQL (client-shaped queries)
    - gRPC (internal, high-performance, typed)
  redFlags:
    - Forcing gRPC as a public browser-facing API where it is awkward to consume
      and cache.
  sources:
    - https://graphql.org/learn/
    - https://grpc.io/docs/what-is-grpc/introduction/
```

- [ ] **Step 2 — `api-protocol-002.yaml`**

```yaml
id: api-protocol-002
domain: api-protocol
difficulty: intermediate
title: Real-time update mechanism for clients
prompt: >-
  Clients need near-real-time updates when server-side data changes. Should we
  use polling, webhooks, or a push channel like WebSockets/SSE?
context:
  - Updates are user-facing and should feel live in the browser.
  - There are also server-to-server integrations that need notifications.
constraints:
  - Keep it operationally manageable.
referenceAnswer:
  recommendation: >-
    Use a server push channel (SSE for one-way live updates, WebSockets for
    bidirectional) for the live browser UX, and webhooks for server-to-server
    event delivery; reserve polling as a simple fallback.
  rationale:
    - SSE/WebSockets deliver low-latency live updates without busy polling.
    - Webhooks are the right fit for delivering events to other servers.
  strongestObjections:
    - WebSockets add stateful connection management and scaling concerns.
    - Polling is trivially simple and robust at low update rates.
  conditions:
    - Use SSE over WebSockets when updates are one-directional (server to client).
    - Use polling when update frequency is low and simplicity beats latency.
  viableAlternatives:
    - Webhooks (server-to-server push)
    - Polling (simple fallback)
  redFlags:
    - Tight-interval polling as the primary mechanism for a UI that must feel
      live, wasting resources and adding latency.
  sources:
    - https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
    - https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API
```

- [ ] **Step 3 — `build-vs-buy-001.yaml`**

```yaml
id: build-vs-buy-001
domain: build-vs-buy
difficulty: intermediate
title: Build vs buy authentication
prompt: >-
  We need user authentication (signup, login, MFA, SSO) for our product. Should
  we build it ourselves or adopt a managed provider like Auth0, Clerk, or
  Cognito?
context:
  - We are a small team without dedicated security staff.
  - Customers will eventually ask for SSO and MFA.
constraints:
  - Security and compliance posture must be strong.
referenceAnswer:
  recommendation: >-
    Buy a managed authentication provider. Auth, MFA, and SSO are security-
    critical, commoditized, and easy to get subtly wrong; a managed provider
    gives a stronger posture for a small team without security staff.
  rationale:
    - Managed providers handle MFA, SSO, password hashing, and breach mitigations
      maintained by specialists.
    - It frees a small team to focus on product rather than security plumbing.
  strongestObjections:
    - Managed auth adds per-user cost and some vendor lock-in.
    - Deep custom auth flows can be constrained by the provider.
  conditions:
    - Build in-house only with strong security expertise and a genuine need that
      no provider meets.
  viableAlternatives:
    - Open-source self-hosted IdP (e.g. Keycloak) if you must self-host
  redFlags:
    - Rolling your own session/password/crypto stack as a small team without
      security expertise.
  sources:
    - https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
    - https://auth0.com/docs
```

- [ ] **Step 4 — `build-vs-buy-002.yaml`**

```yaml
id: build-vs-buy-002
domain: build-vs-buy
difficulty: intermediate
title: Self-host vs managed observability
prompt: >-
  We need logging, metrics, and tracing. Should we self-host an open-source stack
  (Prometheus/Grafana/Loki/OpenTelemetry) or buy a managed platform like Datadog?
context:
  - Small platform team, early in the product's life.
  - Data volumes are currently modest but may grow.
constraints:
  - Minimize operational burden now; control cost as we scale.
referenceAnswer:
  recommendation: >-
    Buy a managed observability platform early to minimize operational burden,
    while instrumenting with vendor-neutral OpenTelemetry so you can migrate or
    self-host later if cost demands it.
  rationale:
    - A small team avoids running and scaling a stateful observability stack.
    - OpenTelemetry instrumentation keeps you portable and avoids lock-in at the
      instrumentation layer.
  strongestObjections:
    - Managed observability bills can grow steeply with data volume.
    - Self-hosting gives full control over retention and data residency.
  conditions:
    - Self-host when data volume makes managed cost prohibitive, or compliance
      requires data residency, and you have the team to operate it.
  viableAlternatives:
    - Self-hosted Prometheus/Grafana/Loki + OpenTelemetry
  redFlags:
    - Standing up and operating a full self-hosted observability cluster with a
      tiny team before it is justified.
  sources:
    - https://opentelemetry.io/docs/
    - https://grafana.com/docs/
```

- [ ] **Step 5: Validate and commit**

Run: `npx vitest run tests/eval/corpus.test.ts` → PASS.
```bash
git add evals/corpus/api-protocol-001.yaml evals/corpus/api-protocol-002.yaml evals/corpus/build-vs-buy-001.yaml evals/corpus/build-vs-buy-002.yaml
git commit -m "feat(eval): add api-protocol and build-vs-buy corpus items"
```

### Task 7: messaging-async + deploy (3 items)

**Files:** Create `messaging-async-001.yaml`, `messaging-async-002.yaml`, `deploy-001.yaml`. Test: re-run `tests/eval/corpus.test.ts`.

- [ ] **Step 1 — `messaging-async-001.yaml`**

```yaml
id: messaging-async-001
domain: messaging-async
difficulty: intermediate
title: Message broker for async work
prompt: >-
  We need asynchronous messaging between services. Should we use Amazon SQS,
  RabbitMQ, or Apache Kafka?
context:
  - Most traffic is task queues; one feature needs an event stream others replay.
  - We run on AWS.
constraints:
  - Prefer the least operational overhead that meets the need.
referenceAnswer:
  recommendation: >-
    Use SQS for the simple managed task queues, and reach for Kafka only for the
    event-stream feature that needs replay and high-throughput retention. Avoid
    standing up Kafka for everything.
  rationale:
    - SQS is fully managed and ideal for decoupled task queues on AWS with minimal
      ops.
    - Kafka's durable, replayable log fits the one stream-with-replay use case.
  strongestObjections:
    - Running two messaging systems adds operational surface.
    - RabbitMQ offers flexible routing and could serve both needs in one system.
  conditions:
    - Choose RabbitMQ when you need rich routing topologies, priorities, or
      request/reply and want one self-managed broker.
    - Choose Kafka broadly only when high-throughput streaming with replay is
      central, not incidental.
  viableAlternatives:
    - RabbitMQ (flexible routing, self-managed)
    - Kafka everywhere (if streaming dominates)
  redFlags:
    - Adopting Kafka as a general-purpose task queue for low-volume work where SQS
      suffices.
  sources:
    - https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html
    - https://kafka.apache.org/documentation/
```

- [ ] **Step 2 — `messaging-async-002.yaml`**

```yaml
id: messaging-async-002
domain: messaging-async
difficulty: advanced
title: Reliable event publishing from a database transaction
prompt: >-
  When a service commits a database change it must also publish an event, without
  losing events if the broker is briefly unavailable. Should we use a dual-write,
  the transactional outbox pattern, or two-phase commit (2PC)?
context:
  - The database and message broker are separate systems.
  - Losing or duplicating events causes downstream inconsistency.
constraints:
  - Atomicity between the state change and the event is required.
referenceAnswer:
  recommendation: >-
    Use the transactional outbox pattern: write the event to an outbox table in
    the same database transaction as the state change, then a relay (polling or
    CDC) publishes it to the broker with at-least-once delivery.
  rationale:
    - Writing state and outbox row in one transaction makes them atomic without
      distributed transactions.
    - A relay decouples publishing from the broker's availability and gives
      at-least-once delivery.
  strongestObjections:
    - The outbox adds a relay/CDC component and at-least-once means consumers must
      be idempotent.
    - It introduces some publish latency versus a direct write.
  conditions:
    - 2PC is only justifiable when both systems support it and you truly need
      synchronous atomic commit despite its availability/performance cost.
  viableAlternatives:
    - Change-data-capture streaming the outbox (e.g. Debezium)
    - Two-phase commit (rarely justified)
  redFlags:
    - Dual-writing to the DB and broker in app code, which loses events whenever
      the second write fails.
  sources:
    - https://microservices.io/patterns/data/transactional-outbox.html
    - https://debezium.io/documentation/
```

- [ ] **Step 3 — `deploy-001.yaml`**

```yaml
id: deploy-001
domain: deploy
difficulty: intermediate
title: Deployment platform for a small team's web service
prompt: >-
  A two-person team is launching a web service. Should we deploy on Kubernetes, a
  serverless platform (AWS Lambda / Cloud Run), or a PaaS (Fly.io / Render /
  Heroku)?
context:
  - No dedicated platform/ops engineer.
  - Traffic is unknown and likely spiky early on.
constraints:
  - Minimize operational overhead; keep a clear path to scale.
referenceAnswer:
  recommendation: >-
    Deploy on a PaaS or a container-serverless platform (Cloud Run / Render /
    Fly.io) so a two-person team avoids cluster operations while keeping
    autoscaling and an easy path to grow.
  rationale:
    - PaaS/serverless removes cluster management, patching, and scaling toil from
      a team with no ops engineer.
    - Container-based PaaS keeps a portable path to Kubernetes later if needed.
  strongestObjections:
    - Kubernetes offers maximum flexibility and portability and avoids some PaaS
      constraints/cost.
    - Serverless can hit cold-start and runtime limits for some workloads.
  conditions:
    - Adopt Kubernetes when you have genuine platform requirements (many services,
      complex networking) and the team to operate it.
  viableAlternatives:
    - AWS Lambda (event-driven, true serverless)
    - Kubernetes (when platform needs and staffing justify it)
  redFlags:
    - Running a self-managed Kubernetes cluster for a two-person team's first CRUD
      service.
  sources:
    - https://cloud.google.com/run/docs
    - https://kubernetes.io/docs/concepts/overview/
```

- [ ] **Step 4: Validate full corpus and commit**

Run: `npx vitest run tests/eval/corpus.test.ts` → PASS.
Confirm 15 files: `ls evals/corpus/*.yaml | wc -l` → `15`.
```bash
git add evals/corpus/messaging-async-001.yaml evals/corpus/messaging-async-002.yaml evals/corpus/deploy-001.yaml
git commit -m "feat(eval): add messaging-async and deploy corpus items"
```

---

## Task 8: Council provider

**Files:**
- Create: `src/eval/providers/council.ts`
- Test: `tests/eval/council-provider.test.ts`

**Interfaces:**
- Consumes: `runDecisionCouncil`, `DecisionCouncilReport` from `../../index.js`.
- Produces: `class CouncilProvider implements ApiProvider` with constructor `new CouncilProvider({ run?: typeof runDecisionCouncil })`, `id(): string`, `callApi(prompt, context?): Promise<ProviderResponse>`. Reads `context.vars.prompt` / `context.vars.contextItems` / `context.vars.constraints`; returns `{ output: report.finalReportMarkdown, metadata }` or `{ error }`.

- [ ] **Step 1: Write the failing test**

Create `tests/eval/council-provider.test.ts`:

```ts
import { CouncilProvider } from "../../src/eval/providers/council.js";
import type { DecisionCouncilReport } from "../../src/index.js";

function fakeReport(overrides: Partial<DecisionCouncilReport> = {}): DecisionCouncilReport {
  return {
    recommendation: "Use A",
    rationale: ["because simple"],
    strongestObjections: ["B scales"],
    unresolvedQuestions: [],
    confidence: 0.8,
    convergence: 0.9,
    nextExperiment: "spike B",
    finalReportMarkdown: "# Report\nUse A.",
    failedPersonas: [],
    ...overrides,
  };
}

describe("CouncilProvider", () => {
  it("maps vars to council input and returns the report markdown", async () => {
    let received: unknown;
    const provider = new CouncilProvider({
      run: async (input, options) => {
        received = { input, options };
        return fakeReport();
      },
    });
    const res = await provider.callApi("ignored", {
      vars: { prompt: "A or B?", contextItems: ["small team"], constraints: ["simple"] },
    });
    expect(received).toEqual({
      input: { prompt: "A or B?", context: ["small team"], constraints: ["simple"] },
      options: { deps: { writeArtifacts: false } },
    });
    expect(res.output).toBe("# Report\nUse A.");
    expect(res.metadata).toMatchObject({ recommendation: "Use A", confidence: 0.8 });
  });

  it("returns an error string when the council throws", async () => {
    const provider = new CouncilProvider({
      run: async () => {
        throw new Error("boom");
      },
    });
    const res = await provider.callApi("ignored", { vars: { prompt: "A or B?" } });
    expect(res.error).toMatch(/boom/);
    expect(res.output).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/eval/council-provider.test.ts`
Expected: FAIL — cannot find `../../src/eval/providers/council.js`.

- [ ] **Step 3: Implement the provider**

Create `src/eval/providers/council.ts`:

```ts
import type { ApiProvider, ProviderResponse } from "promptfoo";
import { runDecisionCouncil } from "../../index.js";

export interface CouncilProviderDeps {
  run?: typeof runDecisionCouncil;
}

interface CallContext {
  vars?: Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

export class CouncilProvider implements ApiProvider {
  private readonly run: typeof runDecisionCouncil;

  constructor(deps: CouncilProviderDeps = {}) {
    this.run = deps.run ?? runDecisionCouncil;
  }

  id(): string {
    return "weavekit:decision-council";
  }

  async callApi(prompt: string, context?: CallContext): Promise<ProviderResponse> {
    const vars = context?.vars ?? {};
    const input = {
      prompt: String(vars.prompt ?? prompt),
      context: toStringArray(vars.contextItems),
      constraints: toStringArray(vars.constraints),
    };
    try {
      const report = await this.run(input, { deps: { writeArtifacts: false } });
      return {
        output: report.finalReportMarkdown,
        metadata: {
          recommendation: report.recommendation,
          confidence: report.confidence,
          convergence: report.convergence,
          failedPersonas: report.failedPersonas.length,
        },
      };
    } catch (error) {
      return { error: `decision-council failed: ${(error as Error).message}` };
    }
  }
}
```

Note: `callApi`'s `context` is typed structurally (`CallContext`) rather than importing promptfoo's `CallApiContextParams`; TypeScript method-parameter bivariance makes this assignable to `ApiProvider`. If the implementing `ApiProvider` interface rejects it, replace `CallContext` with `import type { CallApiContextParams } from "promptfoo"` and use that type.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/eval/council-provider.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/eval/providers/council.ts tests/eval/council-provider.test.ts
git commit -m "feat(eval): add Decision Council promptfoo provider"
```

---

## Task 9: Copilot CLI provider

**Files:**
- Create: `src/eval/providers/copilot.ts`
- Test: `tests/eval/copilot-provider.test.ts`

**Interfaces:**
- Consumes: Node `child_process.spawn`.
- Produces: `class CopilotCliProvider implements ApiProvider` with constructor `new CopilotCliProvider({ model?, timeoutMs?, spawnFn? })`, `id(): string`, `callApi(prompt): Promise<ProviderResponse>`. Spawns `copilot -p <prompt> --allow-all --no-color --model <model> -C <tempdir>`; resolves stdout on exit 0, else `{ error }`.

- [ ] **Step 1: Write the failing test**

Create `tests/eval/copilot-provider.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { CopilotCliProvider } from "../../src/eval/providers/copilot.js";

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (sig?: string) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

describe("CopilotCliProvider", () => {
  it("passes the prompt and required flags and returns stdout", async () => {
    const child = makeFakeChild();
    let calledWith: { cmd: string; args: string[] } | undefined;
    const provider = new CopilotCliProvider({
      model: "auto",
      spawnFn: ((cmd: string, args: string[]) => {
        calledWith = { cmd, args };
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from("Use A.\n"));
          child.emit("close", 0);
        });
        return child as never;
      }) as never,
    });
    const res = await provider.callApi("A or B?");
    expect(calledWith?.cmd).toBe("copilot");
    expect(calledWith?.args).toContain("-p");
    expect(calledWith?.args).toContain("A or B?");
    expect(calledWith?.args).toContain("--allow-all");
    expect(calledWith?.args).toContain("--no-color");
    expect(res.output).toBe("Use A.");
  });

  it("returns an error on non-zero exit", async () => {
    const child = makeFakeChild();
    const provider = new CopilotCliProvider({
      spawnFn: (() => {
        queueMicrotask(() => {
          child.stderr.emit("data", Buffer.from("nope"));
          child.emit("close", 1);
        });
        return child as never;
      }) as never,
    });
    const res = await provider.callApi("A or B?");
    expect(res.error).toMatch(/exit 1/);
    expect(res.error).toMatch(/nope/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/eval/copilot-provider.test.ts`
Expected: FAIL — cannot find `../../src/eval/providers/copilot.js`.

- [ ] **Step 3: Implement the provider**

Create `src/eval/providers/copilot.ts`:

```ts
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiProvider, ProviderResponse } from "promptfoo";

export interface CopilotProviderOptions {
  model?: string;
  timeoutMs?: number;
  spawnFn?: typeof spawn;
}

export class CopilotCliProvider implements ApiProvider {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly spawnFn: typeof spawn;

  constructor(options: CopilotProviderOptions = {}) {
    this.model = options.model ?? process.env.EVAL_COPILOT_MODEL ?? "auto";
    this.timeoutMs = options.timeoutMs ?? Number(process.env.EVAL_COPILOT_TIMEOUT_MS ?? 180_000);
    this.spawnFn = options.spawnFn ?? spawn;
  }

  id(): string {
    return "copilot-cli:vanilla";
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    const cwd = await mkdtemp(join(tmpdir(), "weavekit-eval-copilot-"));
    try {
      const output = await this.invoke(prompt, cwd);
      return { output };
    } catch (error) {
      return { error: `copilot-cli failed: ${(error as Error).message}` };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private invoke(prompt: string, cwd: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = this.spawnFn(
        "copilot",
        ["-p", prompt, "--allow-all", "--no-color", "--model", this.model, "-C", cwd],
        { cwd, env: process.env },
      );
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`exit ${code}: ${stderr.trim() || stdout.trim()}`));
        }
      });
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/eval/copilot-provider.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/eval/providers/copilot.ts tests/eval/copilot-provider.test.ts
git commit -m "feat(eval): add vanilla Copilot CLI promptfoo provider"
```

---

## Task 10: buildSuite (pure corpus → promptfoo suite)

**Files:**
- Create: `src/eval/buildSuite.ts`
- Test: `tests/eval/buildSuite.test.ts`

**Interfaces:**
- Consumes: `CorpusItem`, `formatQuestion`, `formatReference` from `./schema.js`; promptfoo types.
- Produces:
  - `buildAssertions(item: CorpusItem): Assertion[]` — one `g-eval` per rubric criterion (with `weight`, `metric`, `threshold: 0.7`, reference-templated `value`) plus one `select-best`.
  - `buildSuite(items: CorpusItem[], options: { providers: ApiProvider[]; judge?: { model; apiBaseUrl; apiKey } }): EvaluateTestSuite` — `prompts: ["{{question}}"]`, per-item `vars`, `defaultTest.options.provider` = judge.

- [ ] **Step 1: Write the failing test**

Create `tests/eval/buildSuite.test.ts`:

```ts
import { buildSuite, buildAssertions } from "../../src/eval/buildSuite.js";
import { loadCorpusItem } from "../../src/eval/schema.js";
import type { ApiProvider } from "promptfoo";

const ITEM = loadCorpusItem(`
id: t-001
domain: sample
difficulty: intro
title: T
prompt: A or B?
context:
  - small team
constraints:
  - simple
referenceAnswer:
  recommendation: Use A.
  rationale:
    - simple
  strongestObjections:
    - B scales
rubric:
  - criterion: defensible-recommendation
    weight: 0.6
    levels: clear pick
  - criterion: tradeoffs-and-objections
    weight: 0.4
    levels: surfaces tradeoffs
`);

const fakeProvider: ApiProvider = { id: () => "fake", callApi: async () => ({ output: "x" }) };

describe("buildAssertions", () => {
  it("creates one weighted g-eval per criterion plus a select-best", () => {
    const asserts = buildAssertions(ITEM);
    expect(asserts).toHaveLength(3);
    const gevals = asserts.filter((a) => a.type === "g-eval");
    expect(gevals.map((a) => a.weight)).toEqual([0.6, 0.4]);
    expect(gevals.map((a) => a.metric)).toEqual([
      "defensible-recommendation",
      "tradeoffs-and-objections",
    ]);
    expect(gevals[0].value).toContain("{{reference}}");
    expect(asserts.some((a) => a.type === "select-best")).toBe(true);
  });
});

describe("buildSuite", () => {
  it("wires providers, prompt template, vars, and judge config", () => {
    const suite = buildSuite([ITEM], {
      providers: [fakeProvider],
      judge: { model: "judge-x", apiBaseUrl: "http://localhost:9/v1", apiKey: "k" },
    });
    expect(suite.providers).toEqual([fakeProvider]);
    expect(suite.prompts).toEqual(["{{question}}"]);
    expect(suite.tests).toHaveLength(1);
    const test = suite.tests![0];
    expect(test.vars!.prompt).toBe("A or B?");
    expect(test.vars!.contextItems).toEqual(["small team"]);
    expect(String(test.vars!.reference)).toContain("Recommendation: Use A.");
    const judge = suite.defaultTest!.options!.provider as { id: string };
    expect(judge.id).toBe("openai:chat:judge-x");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/eval/buildSuite.test.ts`
Expected: FAIL — cannot find `../../src/eval/buildSuite.js`.

- [ ] **Step 3: Implement buildSuite**

Create `src/eval/buildSuite.ts`:

```ts
import type { ApiProvider, Assertion, EvaluateTestSuite, TestCase } from "promptfoo";
import { type CorpusItem, formatQuestion, formatReference } from "./schema.js";

export interface JudgeConfig {
  model: string;
  apiBaseUrl: string;
  apiKey: string;
}

export interface BuildSuiteOptions {
  providers: ApiProvider[];
  judge?: JudgeConfig;
}

function defaultJudge(): JudgeConfig {
  return {
    model: process.env.EVAL_JUDGE_MODEL ?? "gpt-4o",
    apiBaseUrl: process.env.EVAL_JUDGE_BASE_URL ?? "http://127.0.0.1:8080/v1",
    apiKey: process.env.EVAL_JUDGE_API_KEY ?? "sk-local",
  };
}

export function buildAssertions(item: CorpusItem): Assertion[] {
  const rubric: Assertion[] = item.rubric.map((criterion) => ({
    type: "g-eval",
    value: `${criterion.criterion}: ${criterion.levels}\n\nReference answer for grading:\n{{reference}}`,
    weight: criterion.weight,
    metric: criterion.criterion,
    threshold: 0.7,
  }));
  const pairwise: Assertion = {
    type: "select-best",
    value:
      "Which answer is the more useful and defensible engineering decision, judged against this reference:\n{{reference}}",
  };
  return [...rubric, pairwise];
}

export function buildSuite(items: CorpusItem[], options: BuildSuiteOptions): EvaluateTestSuite {
  const judge = options.judge ?? defaultJudge();
  const tests: TestCase[] = items.map((item) => ({
    description: `${item.id} — ${item.title}`,
    vars: {
      prompt: item.prompt,
      contextItems: item.context,
      constraints: item.constraints,
      question: formatQuestion(item),
      reference: formatReference(item.referenceAnswer),
    },
    assert: buildAssertions(item),
  }));

  return {
    providers: options.providers,
    prompts: ["{{question}}"],
    defaultTest: {
      options: {
        provider: {
          id: `openai:chat:${judge.model}`,
          config: {
            apiBaseUrl: judge.apiBaseUrl,
            apiKey: judge.apiKey,
            temperature: 0,
          },
        },
      },
    },
    tests,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/eval/buildSuite.test.ts`
Expected: PASS (2 tests).

If TypeScript rejects the `Assertion` literal (e.g. it requires extra fields or a different `provider` shape on `defaultTest.options`), reconcile against the installed promptfoo types: run `npx tsc --noEmit` and adjust field names to match the version installed in Task 1 (the assertion `type` values `g-eval` and `select-best` and the `weight`/`metric`/`threshold` fields are stable across recent promptfoo).

- [ ] **Step 5: Commit**

```bash
git add src/eval/buildSuite.ts tests/eval/buildSuite.test.ts
git commit -m "feat(eval): build promptfoo suite from corpus with weighted rubric"
```

---

## Task 11: Runner + CLI entry

**Files:**
- Create: `src/eval/run.ts`
- Create: `src/eval-cli.ts`
- Test: `tests/eval/run.test.ts`

**Interfaces:**
- Consumes: `loadCorpus` (`./schema.js`), `buildSuite` (`./buildSuite.js`), `CouncilProvider`/`CopilotCliProvider` (`./providers/*.js`), `evaluate` from `promptfoo`.
- Produces: `runEval(options?: RunEvalOptions, deps?: RunEvalDeps): Promise<string>` returning the results directory path. `RunEvalOptions = { corpusDir?, resultsDir?, filterIds?: string[], maxConcurrency? }`. `RunEvalDeps = { providers?: ApiProvider[]; evaluateFn?: typeof evaluate }`.

- [ ] **Step 1: Write the failing test**

Create `tests/eval/run.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval } from "../../src/eval/run.js";
import type { ApiProvider } from "promptfoo";

function tempCorpus(): { corpusDir: string; resultsDir: string } {
  const base = mkdtempSync(join(tmpdir(), "weavekit-eval-run-"));
  const corpusDir = join(base, "corpus");
  const resultsDir = join(base, "results");
  mkdirSync(corpusDir, { recursive: true });
  writeFileSync(
    join(corpusDir, "x-001.yaml"),
    `id: x-001
domain: sample
difficulty: intro
title: X
prompt: A or B?
referenceAnswer:
  recommendation: Use A.
  rationale: [simple]
  strongestObjections: [B scales]
rubric:
  - criterion: defensible-recommendation
    weight: 1.0
    levels: clear pick
`,
  );
  return { corpusDir, resultsDir };
}

describe("runEval", () => {
  it("builds a suite, evaluates, and writes a report", async () => {
    const { corpusDir, resultsDir } = tempCorpus();
    let evaluatedItems = 0;
    const fakeProvider: ApiProvider = { id: () => "fake", callApi: async () => ({ output: "x" }) };
    const dir = await runEval(
      { corpusDir, resultsDir },
      {
        providers: [fakeProvider],
        evaluateFn: (async (suite: { tests?: unknown[] }) => {
          evaluatedItems = suite.tests?.length ?? 0;
          return { toEvaluateSummary: async () => ({ stats: { successes: 1, failures: 0 } }) };
        }) as never,
      },
    );
    expect(evaluatedItems).toBe(1);
    expect(existsSync(join(dir, "report.json"))).toBe(true);
    expect(existsSync(join(dir, "summary.md"))).toBe(true);
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain("Items: 1");
  });

  it("filters by id and throws when nothing matches", async () => {
    const { corpusDir, resultsDir } = tempCorpus();
    await expect(
      runEval({ corpusDir, resultsDir, filterIds: ["does-not-exist"] }, { providers: [], evaluateFn: (async () => ({ toEvaluateSummary: async () => ({}) })) as never }),
    ).rejects.toThrow(/No corpus items/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/eval/run.test.ts`
Expected: FAIL — cannot find `../../src/eval/run.js`.

- [ ] **Step 3: Implement the runner**

Create `src/eval/run.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "promptfoo";
import type { ApiProvider } from "promptfoo";
import { type CorpusItem, loadCorpus } from "./schema.js";
import { buildSuite } from "./buildSuite.js";
import { CouncilProvider } from "./providers/council.js";
import { CopilotCliProvider } from "./providers/copilot.js";

export interface RunEvalOptions {
  corpusDir?: string;
  resultsDir?: string;
  filterIds?: string[];
  maxConcurrency?: number;
}

export interface RunEvalDeps {
  providers?: ApiProvider[];
  evaluateFn?: typeof evaluate;
}

interface SummaryLike {
  stats?: { successes?: number; failures?: number };
}

function renderSummary(items: CorpusItem[], summary: SummaryLike): string {
  const stats = summary.stats ?? {};
  return [
    "# Decision Council Eval Summary",
    "",
    `- Items: ${items.length}`,
    `- Successes: ${stats.successes ?? "n/a"}`,
    `- Failures: ${stats.failures ?? "n/a"}`,
    "",
    "Per-criterion (weighted g-eval) and pairwise (select-best) results are in report.json.",
    "",
    "## Items",
    ...items.map((item) => `- ${item.id} — ${item.title}`),
  ].join("\n");
}

export async function runEval(options: RunEvalOptions = {}, deps: RunEvalDeps = {}): Promise<string> {
  const corpusDir = options.corpusDir ?? "evals/corpus";
  let items = loadCorpus(corpusDir);
  if (options.filterIds && options.filterIds.length > 0) {
    const wanted = new Set(options.filterIds);
    items = items.filter((item) => wanted.has(item.id));
  }
  if (items.length === 0) {
    throw new Error("No corpus items selected.");
  }

  const providers = deps.providers ?? [new CouncilProvider(), new CopilotCliProvider()];
  const evaluateFn = deps.evaluateFn ?? evaluate;
  const suite = buildSuite(items, { providers });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(options.resultsDir ?? "evals/results", stamp);
  mkdirSync(outDir, { recursive: true });

  const result = await evaluateFn(suite, {
    maxConcurrency: options.maxConcurrency ?? 1,
    cache: false,
  });
  const summary = (await result.toEvaluateSummary()) as SummaryLike;

  writeFileSync(join(outDir, "report.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, "summary.md"), renderSummary(items, summary));
  return outDir;
}
```

- [ ] **Step 4: Create the CLI entry**

Create `src/eval-cli.ts`:

```ts
import { runEval } from "./eval/run.js";

const filterIds = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

runEval({ filterIds: filterIds.length > 0 ? filterIds : undefined })
  .then((dir) => {
    console.log(`Eval complete. Results written to ${dir}`);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/eval/run.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/eval/run.ts src/eval-cli.ts tests/eval/run.test.ts
git commit -m "feat(eval): add eval runner and CLI entry"
```

- [ ] **Step 7: Manual smoke test (documented, not automated)**

Prerequisites: the local Copilot proxy is serving an OpenAI-compatible endpoint at `EVAL_JUDGE_BASE_URL` (default `http://127.0.0.1:8080/v1`), and `copilot` is logged in.

Run a single item end to end:
```bash
EVAL_JUDGE_MODEL=<judge-model> npm run eval -- orchestration-framework-001
```
Expected: a new `evals/results/<timestamp>/` directory containing `report.json` and `summary.md`; `summary.md` shows `Items: 1`. This invokes the real council and a real `copilot -p` baseline, so it may take a few minutes and incur model calls. Do NOT commit anything under `evals/results/` (it is gitignored).

---

## Task 12: Documentation + final verification + self-review

**Files:**
- Modify: `README.md` (add an "Evaluating the Decision Council" section)

- [ ] **Step 1: Document the harness in `README.md`**

Append this section to `README.md`:

```markdown
## Evaluating the Decision Council

`evals/corpus/*.yaml` holds open-ended technical *decision* questions, each with a
detailed reference answer and a weighted rubric. The eval harness runs two
providers against every question — the Decision Council (`runDecisionCouncil`,
in-memory) and a vanilla `copilot -p` baseline (no extra prompting) — and grades
both with a reference-guided LLM judge via promptfoo.

```bash
# Grade every corpus item (council vs vanilla Copilot CLI):
npm run eval

# Grade specific items by id:
npm run eval -- orchestration-framework-001 data-store-001
```

Judge configuration (OpenAI-compatible) via env: `EVAL_JUDGE_BASE_URL`
(default `http://127.0.0.1:8080/v1`), `EVAL_JUDGE_API_KEY`, `EVAL_JUDGE_MODEL`.
Baseline model via `EVAL_COPILOT_MODEL` (default `auto`). Results are written to
`evals/results/<timestamp>/` (gitignored).
```

- [ ] **Step 2: Full verification of the eval module**

Run each and confirm:
```bash
npx vitest run tests/eval        # all eval tests PASS
npm run typecheck                # exits 0 (whole repo still compiles)
npm run build                    # exits 0
```
Expected: all green. If `npm run typecheck` surfaces promptfoo type mismatches, fix them in `buildSuite.ts`/providers to match the installed promptfoo version (see Task 10 Step 4 note) and re-run.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(eval): document the Decision Council eval harness"
```

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-06-25-decision-council-eval-corpus-design.md`):
- Corpus schema (id/domain/difficulty/title/prompt/context/constraints/referenceAnswer/rubric) → Task 2. ✔
- ~15 questions across 8 domains → seed (Task 3) + Tasks 4–7 = 15 items, 8 domains (orchestration ×2, data-store ×2, language-runtime ×2, architecture-style ×2, api-protocol ×2, build-vs-buy ×2, messaging-async ×2, deploy ×1). ✔
- Council provider (in-memory, `writeArtifacts:false`) → Task 8. ✔
- Vanilla Copilot CLI provider (`copilot -p` in temp CWD, timeout) → Task 9. ✔
- Weighted per-criterion g-eval + select-best pairwise + reference templating + judge on local proxy → Task 10. ✔
- Runner writing timestamped report; `evals/results/` gitignored → Tasks 11 + 1. ✔
- File layout (`evals/corpus`, `src/eval/*`, `src/eval-cli.ts`, `tests/eval/*`) and new deps/script → Tasks 1–11. ✔
- Config/env (`EVAL_JUDGE_*`, `EVAL_COPILOT_*`) → Tasks 10, 9, 12. ✔

**2. Placeholder scan:** No `TBD`/`implement later`/"add error handling"/"write tests for the above". Every corpus field has concrete content; every code step shows full code; corpus items reuse the explicit standard rubric block. ✔

**3. Type consistency:**
- `runDecisionCouncil(input, { deps: { writeArtifacts: false } })` and `DecisionCouncilReport.finalReportMarkdown` match the verified runner/types. ✔
- `CouncilProvider`/`CopilotCliProvider` both `implements ApiProvider`, return `ProviderResponse` (`output` | `error` | `metadata`); used as `ApiProvider[]` by `buildSuite` and `runEval`. ✔
- `buildSuite(items, { providers, judge? })` ↔ `runEval` calls `buildSuite(items, { providers })`; `buildAssertions` returns `Assertion[]` consumed inside `buildSuite`. ✔
- `loadCorpus(dir)` / `loadCorpusItem(text)` / `formatQuestion` / `formatReference` names consistent across schema, buildSuite, run, and tests. ✔
- `RunEvalDeps.evaluateFn: typeof evaluate`; test fakes return `{ toEvaluateSummary }`, matching `runEval`'s use of `result.toEvaluateSummary()`. ✔

**Known integration risk (flagged, not a blocker):** promptfoo's exact `Assertion`/`EvaluateTestSuite`/`ProviderResponse` field names can drift between versions. Tasks 10 and 12 instruct reconciling against the installed version via `npm run typecheck`. The provider/runner seams are injected (`run`, `spawnFn`, `evaluateFn`, `providers`) so unit tests never touch promptfoo internals or the network.
