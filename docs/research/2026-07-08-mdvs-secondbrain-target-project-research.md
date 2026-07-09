# Target project research: applying `edochi/mdvs` lessons to `secondbrain`

## Project-identity check (this run)

Prior same-day research runs for this exact source/target pair
(`edochi/mdvs` → `secondbrain`) documented a recurring defect where the
Project JSON supplied to the research node resolved to Weavekit's own
catalog entry (`workingTree: .../projects/personal/weavekit`) instead of
`secondbrain`, tracing to `.mise/tasks/source-to-project` hardcoding
`--project weavekit`. **This run's supplied Project JSON is correct**:
`id: "secondbrain"`, `workingTree: /Users/smendenhall/projects/microsoft/secondbrain`,
matching `contextDocs` (`README.md`, `00-system/schema.md`, `AGENTS.md`) and
`validationCommands` (`bash scripts/vault-health-check.sh`,
`qmd --index secondbrain status`). Research below is scoped entirely to that
vault, verified directly from its working tree. Whether the upstream
task-script defect was actually fixed or this run simply avoided it is out of
scope for target-project research; flag it for the orchestrator if opportunity
mapping needs to account for prior mistargeted plan artifacts (see
`runs/7e3a98f7-.../raw-plans/plan-opportunity-opp-1-schema-only-validator-cli.md`
and `runs/56160fde-.../workflow-report.md` in the Weavekit repo history).

## Target project architecture (`secondbrain` vault)

Obsidian Markdown vault, folder-per-concern under
`/Users/smendenhall/projects/microsoft/secondbrain`: `00-system`, `01-inbox`,
`02-daily`, `03-sources`, `04-captures`, `05-projects`, `06-areas`, `07-wiki`,
`08-actions`, `09-outputs`, `90-archive`, `99-private`. Every meaningful note
carries YAML frontmatter governed by `00-system/schema.md`: a shared core
schema (`type`, `status`, `created`/`updated`, `project`, `area`, `people`,
`source_type`, `ingest_status`, `source_url`/`m365_link`/`github_link`/
`ado_link`/`source_origin`, `classification`, `agent_access`, `confidence`,
`review_after`, `tags`) plus a **required-fields-by-type table** — e.g.
`source` requires `source_type`, `ingest_status`, one of `source_url`/
`m365_link`/`github_link`/`ado_link`/`source_origin`, `classification`,
`agent_access`; `project` requires `status`, `project`, `review_after`;
`decision` requires `project`, `people`, `confidence`, `classification`.
`schema.md` also documents allowed enum values for `classification`,
`agent_access`, `reuse_review_status`, `source_origin`, and `ingest_status`,
plus naming conventions and lint expectations. This is close to a direct match
for mdvs's schema-inference and required-fields-by-type model — except the
vault's schema is hand-authored and documented in a single Markdown file
rather than inferred by scanning directory structure.

Search/indexing is already `qmd` (v2.5.3, confirmed installed and on `PATH`),
a local hybrid BM25 + vector index named `secondbrain`, confirmed live and
healthy: 127 files indexed, 1,292 vectors embedded, updated 17h ago
(`~/.cache/qmd/secondbrain.sqlite`, 8.5 MB). It is operationally integrated —
`scripts/qmd-refresh-secondbrain.sh` and `scripts/qmd-watch-secondbrain.sh`
run under a macOS `launchd` agent (documented in
`07-wiki/concepts/qmd-filesystem-monitoring.md`) that polls
`00-system/`, `05-projects/`, `06-areas/`, `07-wiki/`, `08-actions/`,
`09-outputs/` every 5 seconds and debounces refresh/embed. `AGENTS.md` and
`00-system/design.md` both codify qmd as the adopted local retrieval
accelerator, with Obsidian CLI as the primary read/write bridge; `design.md`
(section "Local search, Obsidian CLI, and MCP") explicitly evaluated
alternatives (`obsidian-hybrid-search`, `vault-search`) before choosing qmd,
so any comparison should note qmd is the incumbent, not a green-field choice.
mdvs was not among the alternatives considered in that design doc (it likely
postdates that decision).

Current validation is `scripts/vault-health-check.sh` — a hand-rolled bash
script doing **existence checks** (required top-level files:
`AGENTS.md`, `README.md`, `00-system/index.md`, `00-system/schema.md`,
`00-system/log.md`), a **substring grep** over `03-sources/*.md`
(`grep -Eq '^classification:|^agent_access:'`), dashboard-file existence
checks, and a `qmd --index secondbrain status` health call. It has **no
enum/type/required-field-by-type enforcement**, no per-`type` schema
awareness, and no machine-readable/JSON output — it prints human-readable
`ok:`/`warn:`/`missing:` lines and returns an aggregate `status` exit code
(0/1) that is not schema-driven. Deeper "lint" (orphan notes, stale claims,
contradictions, missing backlinks) is delegated to an LLM-run skill,
`.agents/skills/sb-weekly-lint/SKILL.md`, which explicitly runs
`vault-health-check.sh` and `qmd --index secondbrain status` first as
deterministic pre-checks, then performs semantic review, writing advisory
findings to `00-system/dashboards/lint-report.md`. This two-tier
(deterministic-then-semantic) structure is itself close to mdvs's own
staged pipeline framing (scan → infer/update → validate → classify → embed →
write/search), just split across a bash script and an LLM skill instead of
one binary.

## Where mdvs's lessons map cleanly

1. **Schema-only validation, separated from expensive/semantic work.** The
   vault already documents a required-fields-by-type schema
   (`00-system/schema.md`) but enforces almost none of it programmatically —
   `vault-health-check.sh` only checks two literal keys exist on
   `03-sources/*.md`, not their allowed enum values or the full
   required-field set per `type` across all note types. This is the single
   cleanest mdvs transferable lesson: a fast, deterministic validator against
   the documented schema (required fields per `type`, allowed enum values for
   `classification`/`agent_access`/`status`/etc.), run before/independent of
   any qmd or LLM-lint work, emitting structured JSON with a distinct exit
   code for schema violations vs. operational errors — directly mirroring
   mdvs's `--output json` / deterministic `0/1/2` exit-code convention (E2)
   and its validate stage preceding classify/embed (E3).
2. **Metadata-aware filtering for search.** `AGENTS.md` ("qmd maintenance")
   and `07-wiki/concepts/qmd-filesystem-monitoring.md` both state
   `03-sources/` is intentionally excluded from the qmd index "until
   metadata-aware filtering exists" — a known, explicitly named gap that
   matches mdvs's "typed metadata filters over frontmatter" capability (E8).
   A schema-aware filter (e.g., only index/return `03-sources/` notes where
   `classification != restricted` and `agent_access != no-read`) is a second
   concrete, source-grounded opportunity that would let raw sources join the
   qmd index safely.
3. **Path-scoped schema rules** (mdvs's DirectoryTree glob collapsing, E5)
   loosely maps to the vault's folder-per-note-type layout (e.g. `03-sources/`
   vs `08-actions/` vs `05-projects/`), but the vault already achieves this
   via its required-fields-by-type table rather than needing directory-glob
   inference — lower-value to port since the schema is hand-authored, not
   inferred.
4. **Incremental build / delta classification** is low priority here: qmd
   already does incremental refresh (confirmed via live `qmd status` showing
   a current, healthy index with a debounced watcher), so mdvs's
   content-hash-driven re-embedding lesson (E7) is not a differentiator for
   this vault.

## Where mdvs's lessons do not apply / should be rejected

- **Do not replace or duplicate qmd.** qmd is operationally embedded
  (launchd watcher, refresh scripts, documented in `AGENTS.md` and a
  dedicated wiki concept note) and already does hybrid BM25+vector search
  with a healthy, current index. Introducing mdvs's compiled Rust binary as
  a second search/index engine would be tool sprawl, not an improvement.
- **No Rust toolchain or compiled-binary dependency exists in this vault's
  toolchain today** (bash for health checks; Python/`uv`/pytest for the
  DeepEval eval suite in `tests/evals/`). Adopting mdvs literally as an
  installed binary introduces a new build/install requirement
  disproportionate to the actual need, which is "enforce the schema that's
  already documented in `00-system/schema.md`."
- **No CI** exists in this vault (no `.github/workflows` directory found) to
  consume deterministic exit codes at a pipeline level — any exit-code
  contract benefits local/manual invocation of `vault-health-check.sh` only,
  not automated gating, unless CI is added separately.
- **Hybrid vector+BM25+RRF search with SQL-style `--where` filters (E8)** is
  already delivered by qmd; there is no unmet search-capability gap here,
  only an unmet _metadata-filtering_ gap (see mapped lesson 2 above) — the
  distinction matters because it scopes the opportunity to "add a filter,"
  not "replace the search engine."
- The real change surface is **"port mdvs's schema-validation and
  metadata-filtering patterns in a small, dependency-appropriate way,"** not
  literal mdvs tool adoption.

## Existing implementation state (as of this run)

No `schema_validate.py` or any `*schema_validate*` file exists anywhere in
the `secondbrain` working tree — confirmed via direct search. Prior Weavekit
runs (in the Weavekit repo, not this vault) drafted an unimplemented Python +
PyYAML schema-only validator plan
(`runs/7e3a98f7-.../raw-plans/plan-opportunity-opp-1-schema-only-validator-cli.md`)
targeting exactly this gap — required-fields-by-type + enum checks synced
against `00-system/schema.md`, deterministic JSON output, exit codes 0/1/2,
proposed files `scripts/schema_validate.py` and
`tests/test_schema_validate.py`, explicitly deferring `vault-health-check.sh`
integration to a follow-up and explicitly rejecting an mdvs/Rust dependency.
That plan is directly on-target for this vault and should be reused/verified
rather than re-derived from scratch if opportunity mapping proceeds.

## Validation commands (secondbrain)

- `bash scripts/vault-health-check.sh` — current hand-rolled deterministic
  check; a schema-only validator should be invocable alongside or from
  within this script, not replace it.
- `qmd --index secondbrain status` — confirms index health; unaffected by a
  validation-only change; live-verified healthy in this run (127 files,
  1,292 vectors, 17h old).
- `uv run --python .venv-evals/bin/python pytest tests/evals` — existing
  Python/`uv` DeepEval harness for Copilot CLI end-to-end evals; relevant
  only if a Python-side validation or metadata-filtering helper is added and
  needs coverage, or if changes affect agent-facing behavior the evals check.

## Risks

- **Tool-sprawl risk** if mdvs is adopted as a literal compiled dependency
  rather than as a pattern to port (schema-only check + JSON output + exit
  codes, hand-implemented against `00-system/schema.md`).
- **Scope discipline**: prior Weavekit-side plan drafts for this vault
  already establish the right non-goals (no qmd replacement, no compiled
  mdvs dependency, no immediate `vault-health-check.sh` rewiring); any new
  opportunity should build on that scoping rather than re-derive it.
- **Cross-repo confusion**: because this exact source/target objective has
  previously mis-resolved to Weavekit's own repo in other runs, any
  downstream plan or PR must state explicitly and verifiably which
  repository it modifies (`secondbrain` vault vs. Weavekit tooling) before
  execution, especially under `autonomousPrAllowed: true`.

## Recommendation for opportunity mapping

Two concrete, source-grounded opportunities for the `secondbrain` vault, in
priority order:

1. **Schema-only frontmatter validator.** Port mdvs's validate-stage pattern
   (not the tool itself): a small script — reuse the already-drafted
   Python + PyYAML approach if available from prior Weavekit planning
   artifacts, or author fresh — that checks every note's frontmatter against
   `00-system/schema.md`'s required-fields-by-type table and documented enum
   values, emits deterministic JSON, and uses distinct exit codes for
   "schema violations found" vs. "validator error." Wire it in alongside
   (not replacing) `scripts/vault-health-check.sh`.
2. **Metadata-aware qmd filtering for `03-sources/`.** Use the existing
   `classification`/`agent_access` frontmatter fields (already required on
   every source note per schema) to safely lift the current blanket
   exclusion of `03-sources/` from the qmd index, directly answering mdvs's
   "typed metadata filters over frontmatter" lesson and closing a gap the
   vault's own docs already name as open.

Both are additive, dependency-light (no Rust/compiled binary), and consistent
with the vault's documented local-first, advisory-by-default maintenance
philosophy (`AGENTS.md` "Lint workflow": advisory findings, human approval
before destructive changes).
