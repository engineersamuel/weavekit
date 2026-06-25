# Decision Council Evaluation Corpus & Harness Design

## Goal

Build a small, high-quality corpus of technical **decision questions with detailed reference
answers**, plus a thin reproducible **grading harness**, so we can measure whether the Decision
Council (multi-persona deliberation + BAML typed fan-in) produces materially better guidance than
**just asking Copilot directly** with no extra prompting.

The corpus is the durable artifact (ground-truth Q&A). The harness makes it immediately testable
end-to-end: for each question it runs the Council and the bare Copilot CLI, then has a
reference-guided LLM judge compare them and score each against the reference answer.

## Background & prior art

EXA research (2026-06-25) confirmed substantial prior work; we reuse schema and grading
methodology rather than reinventing them, and focus original authoring on the Council's niche.

- **The hypothesis is already contested — and under-studied for *design* decisions.**
  - `DeliberationBench` (arXiv 2601.08835, "When Do More Voices Hurt?"): a 5-model council *lost*
    to a "best-single" baseline 13.8% vs 82.5% win rate (6x gap) at 1.5–2.5x cost — but on
    **verifiable** answers.
  - Counterweight: Du et al. "Improving Factuality and Reasoning through Multiagent Debate" found
    gains. Cluster: "Debate or Vote", "Voting or Consensus?", "Can LLM Agents Really Debate?",
    "The Cost of Consensus", "Demystifying Multi-Agent Debate (confidence & diversity)". Net: value
    depends on task type, candidate disagreement, and protocol. **Open-ended architecture decisions
    are the gap** — exactly the Council's domain.
- **Reusable QA schema + rubric:** `CAKE` (arXiv 2604.05755; fields `question / expected_answer /
  rubric / topic / skill / difficulty`; LLM-as-judge), `ArchEval` (`evaluation_inputs` +
  `ground_truth_outputs`: recommendations/risks/tradeoffs), `ArchBench` (ADR generation),
  "LLMs Choose the Right Stack" (ise2025-llm.pdf, tech/pattern selection).
- **Grading methodology:** MT-Bench / FastChat (`pairwise-baseline` *is* council-vs-vanilla;
  **reference-guided judging cut judge failure 70%→15%**), Arena-Hard-Auto (separability metrics),
  pairwise-vs-rubric tradeoffs, **swap augmentation** for position bias.
- **Ground-truth reference-architecture sources to anchor answers:** `cristoslc/architecture-reference`
  (78 O'Reilly Architecture Katas + AOSA narratives + decision navigator), AWS Well-Architected
  (e.g. PERF4 database selection), curated tech-selection decision trees.

**Key design consequence:** these decisions have **no single verifiable answer**. Exact-match
grading (as in DeliberationBench) would be invalid here. "Ground truth" = a defensible
recommendation **plus the tradeoffs and conditions a good answer must surface**. The rubric grades
*reasoning quality*, not string match. This is deliberately the regime where the Council is most
likely to add value.

## Scope

- Author ~15 original decision questions with rich reference answers across 8 domains.
- Define a Zod-validated corpus schema; store one YAML file per question.
- Build a **promptfoo-based** harness (TS-native): the Council and the Copilot CLI as custom
  providers, judged with promptfoo `select-best` (pairwise) + weighted reference-anchored
  `g-eval`/`llm-rubric` assertions.
- Unit tests (vitest) for schema + the suite builder (pure), with the providers' LLM/CLI calls mocked.
- An `npm run eval` entrypoint and a Markdown/JSON results report.

## Non-goals

- No large benchmark (hundreds of items). YAGNI — 15 is enough for signal at v0.
- No human-labeling pipeline, no leaderboard/web UI.
- No automated corpus *generation* (BenchBuilder-style). Authored by hand, anchored to cited sources.
- No changes to Council persona behavior, rounds, BAML policy, or the in-progress
  Weavekit→Glueplane / Council→Decision Council rename. The eval module is rename-neutral.
- No committing of real run outputs (`evals/results/` is gitignored).

## Corpus design

### Format & validation

- **One YAML file per question** under `evals/corpus/` (e.g. `evals/corpus/data-store-001.yaml`).
  Rationale: rich multi-line prose and nested arrays are far more authorable and diff-friendly in
  YAML than JSON/JSONL. A `src/eval/schema.ts` Zod schema loads and validates every file; loading
  fails loudly on schema drift.
- New dependency: `yaml` (parser). No other new runtime deps for the corpus.

### Per-question schema

```yaml
id: data-store-001                 # unique, kebab: <domain>-<nnn>
domain: data-store                 # enum of the 8 domains below
difficulty: medium                 # easy | medium | hard
title: "Primary datastore for a multi-tenant B2B SaaS with reporting"
prompt: |                          # fed verbatim to BOTH Council and Copilot baseline
  <full, self-contained question text>
context: ["~50 tenants", "..."]    # optional; mirrors DecisionCouncilInput.context
constraints: ["Postgres team expertise", "..."]   # optional; mirrors .constraints
referenceAnswer:
  recommendation: "PostgreSQL (single primary + read replica) ..."
  rationale: ["ACID + relational fit ...", "..."]
  strongestObjections: ["At >10TB hot data ...", "..."]   # counterpoints a good answer must surface
  conditions: ["Switch to Citus/Cockroach when ...", "Add ClickHouse when reporting ..."]
  viableAlternatives:
    - { choice: "...", whenPreferred: "..." }
  redFlags: ["Reaching for Mongo 'for flexibility' without access-pattern analysis", "..."]
  sources: ["AWS Well-Architected PERF4", "O'Reilly Architecture Katas", "..."]
rubric:                            # analytic, weighted; weights sum to 1.0
  - { criterion: recommendationFit,  weight: 0.25, levels: { "5": "...", "3": "...", "1": "..." } }
  - { criterion: tradeoffCoverage,   weight: 0.25 }   # surfaced the key objections?
  - { criterion: conditionAwareness, weight: 0.20 }   # stated when the answer changes?
  - { criterion: rationaleQuality,   weight: 0.15 }
  - { criterion: calibration,        weight: 0.10 }   # appropriate confidence / hedging
  - { criterion: actionability,      weight: 0.05 }   # concrete next step
```

Notes:
- `prompt` is the single source the harness feeds to both contestants — guarantees a fair,
  identical question.
- The rubric intentionally rewards surfacing objections and stating conditions, **not** matching the
  exact recommendation, because multiple recommendations can be defensible.

### Coverage (~15 questions)

| Domain | Count | Tiers (examples) |
|---|---|---|
| orchestration-framework | 2 | easy + hard (seed: existing `examples/design-question.md` — Flue vs Mastra vs LangGraph) |
| data-store | 2 | medium + hard |
| language-runtime | 2 | easy + medium |
| architecture-style | 2 | medium (monolith vs microservices vs modular monolith) + hard |
| api-protocol | 2 | easy (REST vs GraphQL vs gRPC) + medium |
| build-vs-buy | 2 | medium (auth) + medium (search/observability) |
| messaging-async | 1 | medium (Kafka vs SQS vs Redis Streams) |
| deploy | 2 | medium (serverless vs containers/k8s) + hard |

Reference answers are anchored to the cited sources above (AWS Well-Architected, O'Reilly
Architecture Katas, curated decision trees) so they are defensible, not merely the author's opinion.

## Harness design

### Per-question flow

```
                 ┌─ council:  runDecisionCouncil({ prompt, context, constraints },
                 │              { deps: { writeArtifacts: false } })
                 │              → DecisionCouncilReport + cost(rounds, personaCalls, latencyMs)
corpus item ───→ ┤
                 └─ baseline: copilot --allow-all -p "<prompt>" --no-color   (isolated temp CWD, timeout)
                              → stdout answer string
                                          │
                    promptfoo JUDGE (grader → local Copilot proxy; sees referenceAnswer):
                      • g-eval/llm-rubric: one weighted assertion per rubric criterion, scored
                        against the reference → per-provider weighted composite  (PRIMARY signal)
                      • select-best: council vs baseline → pairwise winner       (corroborating)
                                          │
        aggregate (promptfoo Eval + summary) → council vs baseline composite delta, win-rate,
                    cost-quality ratio (à la DeliberationBench) → evals/results/<ts>/report.{json,md}
```

### Contestant 1 — Decision Council

- Call the public seam `runDecisionCouncil(input, { deps: { writeArtifacts: false } })` from
  `src/index.ts`. Use the **typed return value in memory** — no artifact files parsed — so the
  harness is insulated from the Weavekit→Glueplane artifact-filename rename and leaves no litter in
  `runs/`.
- Capture cost signals from the report/run for the cost-quality metric: round count, persona-call
  count, wall-clock latency.

### Contestant 2 — bare Copilot CLI (the "vanilla" baseline)

- Invoke the **real Copilot CLI** so the baseline is faithful to how a human would actually use the
  Copilot harness — not a hand-rolled API call:
  `copilot --allow-all -p "<prompt>" --no-color`.
- Flag rationale (verified against `copilot --help`):
  - `-p/--prompt` runs **non-interactive** mode (executes, prints, exits) — required so the harness
    can capture stdout and terminate. `-i/--interactive` was the user's first instinct but it stays
    interactive and never exits, so it is unusable for scripted capture. `-p` runs the same agent,
    same default model and tools, with memory off by default — i.e. genuinely "no additional
    prompting."
  - `--allow-all` is required for non-interactive mode (no permission prompts).
  - `--no-color` yields clean captured text.
- Run each baseline in an **isolated temporary working directory** (`-C <tmpdir>`) with a timeout, so
  the agent cannot modify the weavekit repo/corpus even though `--allow-all` is set. The temp dir is
  removed after capture.
- **Faithfulness vs control tradeoff (explicit):** this compares the real Council against the real
  Copilot agent (ecologically valid: the user's actual tools), *not* a single-variable ablation —
  the baseline uses Copilot's own default model, which may differ from the Council's
  `BAML_MODEL`/persona model. An optional `--baseline-model <m>` knob (maps to `copilot --model`)
  can pin the model when a controlled comparison is wanted. Default: Copilot's own default.

### Judge — promptfoo (TS-native)

Both contestants are promptfoo **custom providers**; a single corpus item becomes one promptfoo
test whose assertions do the grading. The corpus YAML is the source of truth — a suite builder
(`src/eval/buildSuite.ts`) translates each item into promptfoo `tests[]` programmatically (no
duplicated config).

- **Reference-anchored rubric (PRIMARY).** Each `rubric[]` criterion maps to one weighted
  `g-eval` (CoT) or `llm-rubric` assertion whose prompt scores the answer against the item's
  `referenceAnswer` (interpolated via `{{reference}}`). promptfoo aggregates the per-criterion
  scores into a per-provider weighted composite using each assertion's `weight` (= the criterion
  weight). Because each answer is scored independently against the reference (no A/B positioning),
  this signal is largely free of position bias.
- **Pairwise (CORROBORATING).** A `select-best` assertion compares the Council vs Copilot outputs
  for the same item and names a head-to-head winner — mirroring MT-Bench `pairwise-baseline` /
  Arena preference.
- **Grader model.** Configured via `defaultTest.options.provider` to an OpenAI-compatible provider
  pointed at the **local Copilot proxy** (`http://127.0.0.1:8080/v1`), model from `EVAL_JUDGE_MODEL`
  — a strong model, ideally *different* from the answer model to reduce self-preference bias. No
  external API key; everything stays on the proxy.
- **Rubric levels.** The corpus `rubric[].levels` (5/3/1 descriptions) become the rubric/`g-eval`
  assertion text, so grading criteria live in the corpus, not the harness.

### Aggregation & report

- Per item: pairwise net verdict, rubric scores (council & baseline), council cost, judge reasoning.
- Across corpus: council win-rate (position-bias-controlled), mean rubric by criterion and overall,
  **cost-quality ratio** (quality delta per unit of extra cost, echoing DeliberationBench), plus
  per-domain and per-difficulty breakdowns.
- Output: `evals/results/<timestamp>/report.json` + `report.md` (human-readable summary table).

### File layout

```
evals/corpus/*.yaml              # the QA pairs (committed)
evals/results/<ts>/...           # promptfoo run outputs (gitignored)
src/eval/schema.ts               # Zod schema + YAML loader/validator
src/eval/providers/council.ts    # promptfoo ApiProvider: callApi() → runDecisionCouncil(writeArtifacts:false)
                                 #   → answer string; returns cost (rounds/personaCalls/latency) in metadata
src/eval/providers/copilot.ts    # promptfoo ApiProvider: callApi() → spawn copilot --allow-all -p (temp CWD) → stdout
src/eval/buildSuite.ts           # PURE: corpus → promptfoo EvaluateTestSuite (providers, prompt, weighted
                                 #   g-eval/llm-rubric per criterion + select-best) — unit-tested
src/eval/run.ts                  # import { evaluate } from 'promptfoo'; run suite; write report.{json,md}
src/eval-cli.ts                  # `npm run eval -- --corpus evals/corpus [--ids ...] [--baseline-model m]`
tests/eval/*.test.ts             # vitest; mocks runDecisionCouncil + the CLI spawn; unit-tests buildSuite
```

### Configuration / environment

- Real runs require (same as the Council): the Copilot proxy on `127.0.0.1:8080`, `COPILOT_PROXY_BASE_URL`,
  `COPILOT_PROXY_API_KEY`, `BAML_MODEL`, Copilot SDK auth, and the `copilot` CLI on `PATH`.
- New: `EVAL_JUDGE_MODEL` (optional; the promptfoo grader model on the local proxy; defaults to a
  strong model distinct from the answer model).
- New `package.json` script: `"eval": "tsx src/eval-cli.ts"`.
- New dev deps: `promptfoo` and `yaml`. No BAML changes for the harness.
- `.gitignore`: add `evals/results/`.

## Testing & verification

- **Hermetic unit tests** (`tests/eval/`): schema validation (good + malformed YAML) and the **pure
  suite builder** (`buildSuite`: correct providers, per-criterion weighted assertions, `select-best`,
  `{{reference}}` interpolation), plus the custom providers with `runDecisionCouncil` and the CLI
  spawn mocked — mirroring the existing `tests/decision-council/*` dependency-injection/mock pattern.
  promptfoo's own judging runs only in the manual smoke run, not in CI. No network/LLM in CI.
- **Verify**: `npm test`, `npm run typecheck`, `npm run build` all pass.
- **Manual smoke** (requires proxy + Copilot auth): `npm run eval -- --ids orchestration-framework-001`
  produces a results report.

## Risks & open decisions

- **Judge bias / reliability.** Mitigated by reference-anchored independent rubric scoring as the
  primary signal (no A/B positioning), `select-best` only as corroboration, and a grader model
  distinct from the answer model. Residual risk acknowledged; not chasing human calibration at v0.
- **Baseline non-determinism / side effects.** Copilot `--allow-all` could in principle act; mitigated
  by isolated temp CWD + timeout, and questions phrased as advice (not "edit my repo").
- **Small N (15).** Enough for directional signal and to validate the loop; not for statistical
  claims. Expansion is a follow-up.
- **Corpus format (decided): YAML-per-file.** Alternative single JSONL rejected for authorability.
- **Eval framework (decided): promptfoo** (TS-native: `select-best` + weighted `g-eval`/`llm-rubric`).
  DeepEval (`ArenaGEval` + `GEval`) was the alternative but is Python-only — rejected to keep the
  harness in weavekit's TypeScript stack.

## References

- DeliberationBench — arXiv:2601.08835
- Improving Factuality and Reasoning through Multiagent Debate (Du et al.); Debate or Vote; Voting or
  Consensus?; Can LLM Agents Really Debate?; The Cost of Consensus; Demystifying Multi-Agent Debate
- CAKE — arXiv:2604.05755; github.com/timadam03/CAKE-benchmark
- ArchBench — arXiv:2603.17833; github.com/sa4s-serc/archbench-cli
- ArchEval — github.com/sa4s-serc/ArchEval
- LLMs Choose the Right Stack — ohohlfeld.com/paper/ise2025-llm.pdf
- Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena — arXiv:2306.05685; github.com/lm-sys/FastChat
- Arena-Hard-Auto / BenchBuilder — github.com/lmarena/arena-hard-auto
- promptfoo — promptfoo.dev (LLM-as-a-judge: `select-best`, `g-eval`, `llm-rubric`; custom providers)
- DeepEval (considered) — deepeval.com (`ArenaGEval`, `GEval`); github.com/confident-ai/deepeval
- Evidence-based architecture reference — github.com/cristoslc/architecture-reference-repo
- AWS Well-Architected — Performance Efficiency PERF4 (database selection)
