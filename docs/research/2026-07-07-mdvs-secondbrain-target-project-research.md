# Target project research: applying `edochi/mdvs` lessons to `secondbrain`

## Critical framing issue: Project JSON mismatch (confirmed root cause, recurring across 3+ runs)

The Project JSON supplied for this research call is Weavekit's **own** catalog
entry (`id: "weavekit"`, `workingTree: /Users/smendenhall/projects/personal/weavekit`,
`validationCommands: ["nub run typecheck", "nub run test"]`), not the
`secondbrain` project named in the objective ("Apply
https://github.com/edochi/mdvs to project: secondbrain"). I did not force-fit
mdvs's lessons onto Weavekit's own repo; I traced the real target (the
`secondbrain` Obsidian vault) and researched it directly, per
`~/.weavekit/config.toml` (verified current, not stale):

```toml
[projects.weavekit]
display_name = "Weavekit"
working_tree = "~/projects/personal/weavekit"
...
[projects.secondbrain]
display_name = "Second Brain"
working_tree = "~/projects/microsoft/secondbrain"
context_docs = ["README.md", "00-system/schema.md", "AGENTS.md"]
validation_commands = ["bash scripts/vault-health-check.sh", "qmd --index secondbrain status"]
```

Both catalog entries are correct and distinct. The mismatch is **not** a
catalog-config problem (that was a prior run's now-fixed hypothesis) — I
traced it to the actual root cause this time:

**Root cause, confirmed in this repo:** `.mise/tasks/source-to-project` (the
`nub run source-to-project "<prompt>"` entry point) hardcodes
`args+=(--project weavekit)` unconditionally, on every invocation, regardless
of what project the prompt/objective text names:

```bash
# .mise/tasks/source-to-project
args=(--template source-to-project --prompt "$prompt" --mode advisory --output runs)
args+=(--project weavekit)   # <-- always weavekit, never parsed from "$prompt"
```

`src/cli.ts` (`resolveProjectCatalogEntry`, `src/cli.ts:700,712`) only resolves
whatever `--project <id>` it's handed — it has no bug of its own and no
prompt-parsing logic; the task wrapper never extracts `project: secondbrain`
from the objective string and never exposes a way to override `--project` when
invoking via `mise run source-to-project`. This is why every run of this exact
objective — this one included — is handed `id: "weavekit"` as the target
Project JSON no matter what the prompt says. This is a genuine, reproducible
defect in Weavekit's own `source-to-project` orchestration (in-scope for the
Project JSON actually supplied, since it lives at
`/Users/smendenhall/projects/personal/weavekit/.mise/tasks/source-to-project`),
independent of anything about mdvs or secondbrain.

**Confirmed recurring across three separate runs in this repo's `runs/`
history**, all for this same source/target pair:

- `runs/6b6710ab-.../` — original run; flagged the mismatch as a catalog-config
  risk (now shown to be a red herring — config was already correct).
- `runs/7e3a98f7-.../raw-plans/plan-opportunity-opp-1-schema-only-validator-cli.md`
  — a later plan that correctly self-corrected mid-plan ("Target repo
  (critical): the secondbrain vault ... not weavekit") and produced a fully
  scoped, unimplemented Python validator plan for the vault.
- `runs/56160fde-.../workflow-report.md` (most recent, same day) — the
  workflow's own project-research node again resolved `Target project:
Weavekit` and the run's top recommendation became **"Retarget validation
  plans to the vault via the catalog"** (`opp-002-fix-project-identity-in-plans`),
  i.e. the workflow tried to patch around the symptom (mistargeted plans)
  without locating this task-script root cause.

## Prior runs already exist for this exact source/target pair

Three complete prior Weavekit runs exist for this same objective
(`edochi/mdvs` → `secondbrain`) under `runs/`, summarized in the root-cause
section above. Because this appears to be a repeated re-execution of the same
objective (same-day, same source/target), **the new node output should build
on/reconcile with the prior briefs and plans rather than silently duplicate
them** — flag this as an open question for the orchestrator (idempotency /
resumption policy for source-to-project Runs is out of scope for this research
call, but the repeated wasted work is itself evidence for prioritizing the
task-script fix below).

## Target project architecture (`secondbrain` vault)

Obsidian Markdown vault, folder-per-concern: `00-system`, `01-inbox`,
`02-daily`, `03-sources`, `04-captures`, `05-projects`, `06-areas`, `07-wiki`,
`08-actions`, `09-outputs`, `90-archive`, `99-private`. Every meaningful note
carries YAML frontmatter governed by `00-system/schema.md`: a shared core
schema (`type`, `status`, `classification`, `agent_access`, `confidence`,
`created`/`updated`, etc.) plus **required-fields-by-type** — e.g. `source`
requires `source_type`, `ingest_status`, one of
`source_url`/`m365_link`/`github_link`/`ado_link`/`source_origin`,
`classification`, `agent_access`; `project` requires `status`, `project`,
`review_after`; `decision` requires `project`, `people`, `confidence`,
`classification`. This is close to a direct match for mdvs's schema-inference
and required-fields-by-type model, except the vault's schema is
hand-authored/documented (`schema.md`) rather than inferred from scanning.

Search/indexing is `qmd`, a local hybrid (BM25 + vector) index named
`secondbrain`, confirmed live and healthy: 123 files indexed, 1207 vectors,
updated 5h ago (`~/.cache/qmd/secondbrain.sqlite`, 8.4 MB). `qmd` is the
adopted, operationally integrated search layer (has a refresh/watch flow via
`scripts/qmd-refresh-secondbrain.sh` / `scripts/qmd-watch-secondbrain.sh`,
referenced from this session's own custom instructions).

Current validation is `scripts/vault-health-check.sh` — a hand-rolled bash
script doing **existence checks** (required top-level files) and **substring
greps** (`grep -Eq '^classification:|^agent_access:'` on files under
`03-sources/`) with **no enum/type/required-field-by-type enforcement** and no
machine-readable/JSON output. It does emit an aggregate `status` exit code, but
the checks themselves are not schema-driven.

## Where mdvs's lessons map cleanly

1. **Schema-only validation, separated from expensive work.** The vault
   already documents a required-fields-by-type schema (`00-system/schema.md`)
   but enforces almost none of it programmatically — `vault-health-check.sh`
   only checks two literal keys exist, not their allowed enum values or the
   full required-field set per `type`. This is the single cleanest mdvs
   transferable lesson: a fast, JSON-Schema-style validator against the
   documented schema, run before/independent of any qmd/embedding work,
   emitting structured JSON with a distinct exit code for violations vs.
   operational errors.
2. **Metadata-aware filtering for search.** `00-system/search-mcp.md` (line 42, 130) explicitly states `03-sources/` is excluded from qmd until
   "metadata-aware qmd filtering exists" — i.e., the vault has a
   known, named gap that matches mdvs's "typed metadata filters over
   frontmatter" capability. A schema-aware filter (e.g., only index/return
   `03-sources/` notes where `classification != restricted` and `agent_access
!= no-read`) is a second concrete, source-grounded opportunity.
3. **Incremental build / delta classification** is lower priority: qmd already
   does incremental refresh (confirmed via `qmd status` showing an existing,
   current index), so mdvs's build-classification lesson is not a
   differentiator here.

## Where mdvs's lessons do not apply / should be rejected

- **Do not replace or duplicate qmd.** qmd is operationally embedded (watcher,
  refresh scripts, MCP-level guidance in this very session's custom
  instructions) and already does hybrid BM25+vector search. Introducing mdvs's
  compiled Rust binary as a second search/index engine would be tool sprawl,
  not an improvement — this was correctly rejected in the prior run's
  `projectBrief.risks` and remains correct today.
- **No Rust toolchain or compiled-binary dependency currently exists in this
  vault's toolchain** (bash + Python/uv/pytest for evals). Adopting mdvs
  literally (as an installed binary) introduces a new build/install
  requirement disproportionate to the actual need, which is "enforce the
  schema that's already documented."
- **No CI** (no `.github/workflows`) consumes exit codes today — any
  deterministic exit-code contract benefits local/manual runs and
  `scripts/vault-health-check.sh` invocation only, not a CI pipeline, until/
  unless one is added.
- The real change surface is **"port mdvs's schema-validation and
  metadata-filtering approach"**, not literal mdvs tool adoption — this is
  exactly the scoping decision already recorded in the `opp-1` plan draft's
  ("no mdvs/Rust dependency") non-goals, which this research affirms.

## Existing implementation state (important: not yet built)

There is **no** `plans/` directory in this repo (verified: `find plans` finds
nothing) — a plan draft referencing `plans/opp-001-schema-only-validation/plan.mdx`
targeting Weavekit's own `entities/*.yaml` catalog does not currently exist
here; if it existed in an earlier state of this repo it is gone now. What does
exist and is current:

- `runs/7e3a98f7-.../raw-plans/plan-opportunity-opp-1-schema-only-validator-cli.md`
  — a fully scoped, **self-correcting** plan draft ("Target repo (critical):
  the secondbrain vault ... not weavekit ... The instruction forbids modifying
  the weavekit codebase"). It specifies Python + PyYAML, a typed
  enum/required-field constant synced against `00-system/schema.md`, JSON to
  stdout, exit codes 0/1/2, files `scripts/schema_validate.py`,
  `tests/test_schema_validate.py`, and an ADR — explicitly **not** wired into
  `vault-health-check.sh` yet (deferred to a follow-up bundle) and explicitly
  **not** an mdvs/Rust dependency. **Confirmed not yet implemented**: no
  `schema_validate.py` or any `*schema_validate*` file exists anywhere in
  `~/projects/microsoft/secondbrain` today.
- `runs/56160fde-.../workflow-report.md` (most recent run) — instead of
  building on the opp-1 plan above, this run's top-ranked opportunity was
  `opp-002-fix-project-identity-in-plans`: retarget validation plans via the
  catalog and add CI assertions that plans don't point at weavekit. It treated
  the symptom (mistargeted plan text) rather than the cause identified above
  (the hardcoded `--project weavekit` in `.mise/tasks/source-to-project`).

Weavekit's own entity-catalog CLI (`src/cli.ts`, `src/entities/catalog.ts`) has
no `schemaOnly`/`--output json` support and is unrelated to either opportunity
— confirmed by grep, zero matches for `schemaOnly` in `src/cli.ts` or
`src/entities/catalog.ts`.

## Validation commands (secondbrain, the actual target)

- `bash scripts/vault-health-check.sh` (current hand-rolled check; the
  candidate schema-only validator should be invoked alongside or from within
  this script)
- `qmd --index secondbrain status` (confirms index health; unaffected by a
  validation-only change)
- `uv run --python .venv-evals/bin/python pytest tests/evals` (existing
  Python/uv eval suite; relevant if any Python-side validation or filtering
  helper is added)

## Risks

- **Project-identity confusion is recurring, not a one-off, and has a known
  root cause.** It appeared in (a) an original run's flagged (and
  since-disproven) catalog-config hypothesis, (b) this Run's node-input
  Project JSON (still wrong), and (c) the most recent prior run's own
  project-research node again resolving `Target project: Weavekit`. The actual
  cause — `.mise/tasks/source-to-project` hardcoding `--project weavekit` —
  has not yet been fixed in any prior run. Any opportunity/plan produced from
  this research must state explicitly which repo it touches (`secondbrain`
  vault vs. Weavekit's own `.mise/tasks/`) to avoid a fourth recurrence, and
  should prioritize the task-script fix over re-patching symptoms.
- **Tool-sprawl risk** if mdvs is adopted as a literal dependency rather than
  as a pattern to port (schema-only check + JSON output + exit codes,
  hand-implemented in Python against `00-system/schema.md`, per the existing
  `opp-1` plan draft).
- **Scope discipline**: the existing `opp-1` plan draft already shows the
  right non-goals (no qmd replacement, no compiled mdvs dependency, no
  `vault-health-check.sh` rewiring yet); a secondbrain-side opportunity from
  this research should build on that draft rather than re-derive it from
  scratch.
- **Wasted re-derivation**: three same-day runs against this identical
  objective, each re-doing project-research and opportunity-mapping from
  scratch, is itself a signal that a resumption/idempotency mechanism (or at
  minimum, the task-script fix so runs stop mis-resolving the project) would
  have material value independent of mdvs.

## Recommendation for opportunity mapping

Two viable framings, in priority order:

1. **Fix the actual root cause, in-scope for the Project JSON as supplied**
   (`workingTree: /Users/smendenhall/projects/personal/weavekit`): make
   `.mise/tasks/source-to-project` (and/or `src/cli.ts`'s prompt handling)
   parse a `project: <id>` (or `--project <id>` passthrough) out of the
   objective/prompt instead of hardcoding `--project weavekit`, so this exact
   class of mismatch stops recurring for every future `secondbrain`-or-other
   non-weavekit objective. This directly resolves the Risk above and is
   lower-risk/higher-leverage than re-deriving `opp-002`'s catalog-retargeting
   idea, since it fixes the cause rather than papering over mistargeted plan
   text.
2. **Continue the already-drafted `secondbrain`-side opportunities** (source-
   grounded in mdvs, not duplicative of the above):
   - **Schema-only frontmatter validator** for the vault: complete/verify the
     `opp-1` plan draft already in `runs/7e3a98f7-.../raw-plans/` (Python +
     PyYAML, required-fields-by-type + enum checks from `00-system/schema.md`,
     deterministic JSON, exit codes 0/1/2), rather than starting a new plan.
   - **Metadata-aware qmd filtering for `03-sources/`**: use the documented
     `classification`/`agent_access` frontmatter fields to safely unblock
     `03-sources/` indexing in qmd (currently excluded per
     `00-system/search-mcp.md:42,130` — verified still current), directly
     answering the "typed metadata filters over frontmatter" transferable
     lesson from the source.

Both `secondbrain`-side opportunities should be flagged in the handoff as
depending on resolving the project-identity mismatch first (opportunity 1),
since an Autonomous PR mode run against the wrong `workingTree` would modify
Weavekit instead of the vault — this has now happened, in effect, across three
runs' worth of research/plan artifacts that assumed the wrong target.
