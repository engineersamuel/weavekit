# Phoenix vs Promptfoo for Weavekit evals

Date: 2026-07-09
Status: Research note
Scope: Compare Arize Phoenix's evaluation framework with this repo's current
promptfoo-backed eval harness.

## TL;DR

Keep promptfoo as the primary regression harness. It already matches this
repo's needs: repo-owned YAML corpus, custom providers for weavekit execution
paths, weighted rubric grading, pairwise comparison, local JSON/Markdown
artifacts, and simple `nub run eval` / `nub run eval:router` commands.

Treat Phoenix as an optional observability and experiment layer, not a
like-for-like promptfoo replacement. Phoenix is valuable if the problem is
"we need trace-linked eval analysis, persistent experiments, prompt/version
iteration, and human/LLM/code annotations in a UI." It is too much surface area
if the problem is only "run local regression evals in CI."

## Current repo eval shape

The current eval path is intentionally small and code-owned:

- `package.json` exposes `nub run eval` and `nub run eval:router`.
- `src/eval/run.ts` loads corpus YAML, builds a promptfoo suite, calls
  `evaluate()`, disables cache, and writes `report.json` plus `summary.md`.
- `src/eval/buildSuite.ts` emits one prompt (`{{question}}`), configures the
  OpenAI-compatible judge from `EVAL_JUDGE_*`, creates weighted `g-eval`
  assertions per rubric criterion, and adds `select-best` when comparing
  multiple providers.
- `src/eval/schema.ts` owns the repo corpus contract: kebab-case id, domain,
  difficulty, prompt/context/constraints, reference answer, source URLs, and
  rubric weights summing to 1.0.
- Default decision eval compares `weavekit:decision-council` against
  `copilot-cli:vanilla`.
- Router evals add `route-results.json` and `dashboard.html` around the
  promptfoo report.

This is a regression harness around weavekit behavior, not a general eval
platform.

## Phoenix shape

Phoenix is broader than an eval runner. Official docs position it as AI
observability and evaluation: OpenTelemetry/OpenInference tracing, datasets,
experiments, prompt management, prompt playground, span replay, annotations,
and LLM/code/human evals.

Useful Phoenix concepts:

- Evaluators return a `Score` with name, kind, direction, optional score,
  label, explanation, and metadata.
- Evaluators can be LLM-as-judge, deterministic code evaluators, or human
  annotations.
- Experiments run a task over a dataset and record scores/explanations for
  comparison over time.
- Datasets can come from traces, files, or programmatic upload.
- Prompt management versions prompts, parameters, tools, response format, and
  tags.
- Self-hosted Phoenix is a service: web UI, trace collector, and SQL backend
  (SQLite for local/dev, Postgres for production-like use).

Phoenix is free to self-host, but its repository uses ELv2 terms rather than a
permissive MIT/Apache-style license. Do not assume "open source" means
unrestricted hosted-service redistribution.

## Comparison

| Dimension           | Current promptfoo harness                     | Phoenix                                                    |
| ------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| Primary job         | Local regression eval runner                  | Observability, evals, datasets, experiments                |
| Data model          | YAML corpus in repo                           | Projects, traces/spans, datasets, experiments, annotations |
| Judging             | `g-eval`, `select-best`, promptfoo assertions | LLM evaluators, code evaluators, human annotations         |
| Provider model      | Custom promptfoo `ApiProvider` wrappers       | Task functions, SDK/client APIs, tracing instrumentation   |
| Output              | JSON/Markdown, router HTML dashboard          | Persistent UI, trace-linked scores, experiment comparison  |
| CI fit              | Direct and already implemented                | Possible, but adds service/client lifecycle                |
| Debuggability       | Report artifacts and provider metadata        | Stronger trace/span/explanation workflow                   |
| Operational surface | Node dependency only                          | Phoenix server plus storage and auth/deployment choices    |

## Recommendation

Do not migrate the corpus or primary evaluator to Phoenix first. Keep the
promptfoo harness as the canonical regression path.

If eval visibility becomes the bottleneck, add Phoenix incrementally:

1. Emit OpenTelemetry spans or Phoenix annotations for promptfoo eval cells.
2. Export selected promptfoo results into a Phoenix dataset/experiment.
3. Use Phoenix UI to inspect failures, compare experiment runs, and collect
   human annotations.

This preserves the repo-native corpus and existing provider adapters while
testing whether Phoenix's UI and trace linkage add enough value to justify the
service dependency.

## Local gaps to fix before any migration

- `src/eval/routerRunner.ts` computes router dashboard results in a separate
  direct pre-pass instead of deriving them from promptfoo provider output. The
  dashboard can drift from the actual promptfoo eval path.
- `src/eval/schema.ts` accepts `referenceAnswer.sources`, but
  `formatReference()` omits those URLs from the judge block. The LLM judge sees
  the reference answer but not the supporting source list.
- `filterIds` silently ignores unknown ids unless all requested ids miss. A
  partial typo can run a smaller suite without warning.
- `eval-router-cli` validates concurrency later than ideal; invalid values can
  trigger the router pre-pass before `runEval()` rejects them.

## Source pointers

- Phoenix evals: https://arize.com/docs/phoenix/evaluation/how-to-evals
- Phoenix experiments: https://arize.com/docs/phoenix/datasets-and-experiments/how-to-experiments/run-experiments
- Phoenix overview: https://arize.com/docs/phoenix
- Phoenix self-host architecture: https://arize.com/docs/phoenix/self-hosting/architecture
- Promptfoo config reference: https://www.promptfoo.dev/docs/configuration/reference/
- Promptfoo model-graded metrics: https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/
- Promptfoo G-Eval: https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/g-eval/
- Promptfoo Node package: https://www.promptfoo.dev/docs/usage/node-package/
