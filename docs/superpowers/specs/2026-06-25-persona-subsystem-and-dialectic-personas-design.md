# Persona Subsystem & Dialectic Personas Design

## Goal

Extract personas from the Decision Council into a **reusable, workflow-agnostic persona subsystem**,
and seed it with a set of **dialectic personas** derived from the Electric Monks of the
[hegelian-dialectic-skill](https://github.com/KyleAMathews/hegelian-dialectic-skill).

Two outcomes:

1. **Integrate with the Decision Council now** — a new `dialectic` persona set drops into the
   existing fan-out/fan-in council via the current `--persona-set` selection path, with no change to
   the council loop, BAML normalization, Judge, or router.
2. **Reusable across future workflows** — personas become first-class, typed, registry-loaded
   objects whose canonical specs declare multiple **modes** (ANALYZE / GRADE / RED-TEAM / ADVISE /
   SYNTHESIZE / BELIEVE) with **output contracts**, so a future RED-TEAM, GRADE, or paired
   thesis/antithesis dialectic workflow reuses the same personas by invoking a different mode.

The persona content (TOML definitions + Markdown canonical specs) is the durable artifact. The
shared module makes it loadable, validatable, and composable from any workflow.

## Background & prior art

This builds directly on conventions already established in this repo by the
`strategic-game-theorist` work (commit `30e81ce`, `0b47297`):

- **Canonical spec = rich Markdown** at `personas/<id>.md` — identity paragraph, `Knowledge Core`,
  a `The Four Modes — With Output Contracts` section (ANALYZE / GRADE / RED-TEAM / ADVISE), an
  `Output Contract` (a **Council Output Contract** = always end with claims/risks/questions/
  recommendations, plus standalone contracts), `Guardrails`, and `Usage Examples`.
- **Runtime = distilled flat prompt** in `personas.ts`, registered in an in-code
  `personaSetRegistry` and selected via `resolvePersonaSetByName()` / the `--persona-set` CLI flag.

The hegelian-dialectic-skill supplies the dialectic archetypes and discipline:

- **Electric Monks (Phase 2/3):** two subagents that *fully believe* opposing positions
  (thesis/antithesis). Prompt structure: ROLE ("you ARE this position", not "argue for it") →
  **framing corrections** (preempt strawman framings) → context briefing → argument skeleton
  (ontological claim → opponent's strongest case → determinate negation → deeper principle → push to
  extreme → reasoning skeleton) → **anti-hedging** ("if you hedge, the human has to carry the belief
  load"). Quality lever: **decorrelation** — monks must occupy genuinely different conceptual frames.
- **Determinate negation (Phase 4):** each position fails in a *specific, complementary* way that
  reveals what the other is missing; surface shared assumptions and the hidden question.
- **Hostile Auditor (Phase 6 Stage B):** "be correct, not fair"; attack a candidate on *its own*
  standard (compare to status quo not the ideal; undercutting > self-defeating > rebutting; prospective
  hindsight; compromise detection; closure check).
- **Sublation:** the orchestrator (belief-free) synthesizes a richer position from the contradiction.

EXA research (2026-06-25) confirms the industry direction and is reused rather than reinvented:

- **Cognitive/epistemic personas as the unit of design.** Consilium Protocol ("engineered epistemic
  postures … reusable across models, sessions, and pipeline stages") and CHAL (arXiv 2605.12718:
  "epistemic personas … as independently configurable hyperparameters", framed as "a lens for
  analysis rather than conclusions to defend") both treat personas as composable, reusable postures —
  validating the structured-schema direction.
- **Registry-backed portable persona configs.** `larva` (PersonaSpec: validate/assemble/register/
  resolve), `persona-object-protocol`, `PersonaNexus` (declarative YAML → multi-target compile),
  `ethos` `FilePersonalityRegistry` (disk-backed `get/list/getDefault/setDefault`), `ai-infra`
  (YAML-driven personas + directory registry). Common API: load-directory, get(id), list, resolve(id).
- **Adversarial panels & decorrelation.** `advocate` (6-persona adversarial engine; "disagreements
  are signal"), `firing-squad` (7-persona architecture panel; every persona has an explicit
  *"What you ignore"* section as the anti-overlap mechanism), `the-tribunal`, `spectra`
  (blackboard multi-persona deliberation → ADR with dissent). Du et al. (multiagent debate) and
  Debate-to-Write (persona = description + stance) underpin the believer model. The `ignores` field
  below is the direct encoding of firing-squad's "What you ignore" decorrelation lever.

## Scope

- A new shared module `src/personas/` (`schema.ts`, `composer.ts`, `registry.ts`, `index.ts`),
  workflow-agnostic and decoupled from `decision-council`.
- A **structured, backward-compatible** `PersonaDefinition` schema (new fields optional) with
  `archetype`, `stance`, `framingCorrections`, `antiHedging`, `ignores` (decorrelation), `modes`,
  `tags`, `specRef`.
- A deterministic **composer** that assembles structured fields into the runtime prompt, producing
  byte-identical output to today's `buildPersonaPrompt` for flat personas.
- **TOML-backed content** in `personas/`: required `personas/<id>.toml` (machine source) + optional
  `personas/<id>.md` (rich canonical spec) + `personas/sets.toml` (named sets), loaded synchronously
  at module init via a `smol-toml` parser.
- **Migration** of the existing 5 personas (`socratic`, `deep-module-dry`, `pragmatic`, `skeptic`,
  `game-theorist`) and the `default`/`strategic` sets into the TOML system, so there is **one**
  source of truth. Public exports and CLI behavior are preserved.
- **Four dialectic personas**: `dialectic-advocate`, `dialectic-adversary`, `hostile-auditor`,
  `synthesist` (each with `.toml` + `.md`), and a council `dialectic` set =
  `[dialectic-advocate, dialectic-adversary, hostile-auditor]`. `synthesist` is authored standalone
  (registry-loadable, reusable) but **not** in the council set.
- Tests for schema, composer, registry, the dialectic set, and the migrated council path; plus
  `npm test` / `npm run typecheck` / `npm run build` green.

## Non-goals

- **No new dialectic *workflow*.** The paired thesis/antithesis loop with determinate-negation and
  sublation aggregation (the full Electric-Monk engine) is a *future* workflow that will *reuse*
  these personas + `synthesist`. This spec only delivers the personas and the reusable subsystem.
- **No change to the council loop, BAML functions, Judge, artifacts, or router logic.** The believer
  personas function as strong advocate/adversary critics inside the existing N-critic + Judge
  structure; the Judge continues to synthesize.
- **No Markdown frontmatter parsing.** The `.md` is a human-facing canonical reference; the `.toml`
  is the machine source. They are linked by `specRef`, not parsed into each other.
- **No cross-framework/portable persona protocol.** Internal weavekit module only (the file-based
  schema keeps the door open to exporting later).
- **No dialectic-specific eval corpus item** (optional follow-up; the harness already supports it).

## Persona subsystem design

### Module layout

```
src/personas/
  schema.ts      # PersonaDefinition, PersonaSet, PersonaArchetype, PersonaMode (zod)
  composer.ts    # composePersonaPrompt(persona, { mode?, brief })
  registry.ts    # sync TOML loader + index; get/list/resolve APIs; eager default registry
  index.ts       # public exports
```

The council depends on `src/personas/`; `src/personas/` depends on nothing in `decision-council`
except the shared `RoundBrief` type (which moves or is imported as a small shared shape — see
Back-compat).

### Schema (`src/personas/schema.ts`)

New fields are optional or default to empty, so every existing flat persona parses unchanged.

```ts
export const PersonaArchetypeSchema = z.enum([
  "believer", "auditor", "synthesist", "critic", "analyst",
]);

export const PersonaModeSchema = z.enum([
  "analyze", "grade", "red-team", "advise", "synthesize", "believe",
]);

export const PersonaDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),                          // distilled runtime body (kept required)
  archetype: PersonaArchetypeSchema.optional(),
  stance: z.string().min(1).optional(),               // the position held with conviction
  framingCorrections: z.array(z.string().min(1)).default([]),
  antiHedging: z.string().min(1).optional(),
  ignores: z.array(z.string().min(1)).default([]),    // decorrelation / "what you ignore"
  modes: z.array(PersonaModeSchema).default([]),
  tags: z.array(z.string().min(1)).default([]),
  specRef: z.string().min(1).optional(),              // path (relative to personas/) to canonical .md
});

export const PersonaSetSchema = z.object({
  name: z.string().min(1),
  personas: z.array(PersonaDefinitionSchema).min(2),
});
```

### Composer (`src/personas/composer.ts`)

`composePersonaPrompt(persona, { mode?, brief })` assembles the per-round message, including only the
sections that are present:

1. `You are ${persona.name}.`
2. *(if `stance`)* `You hold this position with full conviction: ${stance}`
3. *(if `framingCorrections`)* `Framing corrections:` + bulleted list
4. `${persona.prompt}`  *(the body)*
5. *(if `antiHedging`)* the anti-hedging directive verbatim
6. *(if `ignores`)* `Stay in your lane — defer these to other personas; do not critique them:` + list
7. *(if `mode`)* `Operate in ${mode.toUpperCase()} mode per your specification.`
8. `Round ${brief.roundNumber}` / `Focus: ${brief.focus}`
9. `Design/question:` / `${brief.prompt}`
10. `Return a concise critique with claims, risks, questions, and recommendations.`

**Back-compat guarantee:** for a flat persona (`stance`/`framingCorrections`/`antiHedging`/`ignores`/
`mode` all absent), the output is byte-identical to the current `buildPersonaPrompt`. This is locked
by a snapshot test.

The persona's `customAgents[].prompt` in `CopilotPersonaWorker` stays `persona.prompt` (the system
body is unchanged); only the per-round message is enriched. Moving identity/belief into the
customAgent system prompt is a noted future refinement, not in scope.

### Registry (`src/personas/registry.ts`)

- `loadPersonas(dir)` reads every `*.toml` except `sets.toml`, parses with `smol-toml`, validates each
  with `PersonaDefinitionSchema`, and indexes by `id` (duplicate id → throw).
- `loadSets(dir, personasById)` reads `sets.toml`, validates each set's `personas` id list resolves,
  and builds `PersonaSet` objects.
- A **default registry is built eagerly at module load** using `fs.readFileSync` over a personas
  directory resolved relative to the module via `import.meta.url` (`new URL("../../personas/",
  import.meta.url)`), with a `WEAVEKIT_PERSONAS_DIR` env override. Sync I/O preserves the synchronous
  `resolvePersonaSetByName` contract that `runner.ts`, the CLI, and the eval `council` provider depend
  on (no async ripple).
- Public API:
  - `getPersona(id): PersonaDefinition` (throws on miss, lists available ids)
  - `getPersonaSet(name): PersonaSet` (throws on miss, lists available names)
  - `listPersonaSets(): string[]`
  - `resolvePersonaSet(set = defaultPersonaSet): PersonaSet` (validates + `structuredClone`, as today)
  - `resolvePersonaSetByName(name?): PersonaSet` (defaults to `default`; same error message shape)

### Content layout (`personas/`)

```
personas/
  socratic.toml
  deep-module-dry.toml
  pragmatic.toml
  skeptic.toml
  game-theorist.toml             # specRef -> "strategic-game-theorist.md" (existing file kept as-is)
  strategic-game-theorist.md     # existing canonical spec (unchanged)
  dialectic-advocate.toml   + dialectic-advocate.md
  dialectic-adversary.toml  + dialectic-adversary.md
  hostile-auditor.toml      + hostile-auditor.md
  synthesist.toml           + synthesist.md
  sets.toml
```

`sets.toml`:

```toml
[sets.default]
personas = ["socratic", "deep-module-dry", "pragmatic", "skeptic"]

[sets.strategic]
personas = ["socratic", "deep-module-dry", "pragmatic", "skeptic", "game-theorist"]

[sets.dialectic]
personas = ["dialectic-advocate", "dialectic-adversary", "hostile-auditor"]
```

`synthesist` has a `.toml`/`.md` and is registry-loadable via `getPersona("synthesist")`, but is
referenced by no set — reserved for the future dialectic workflow.

Example structured persona (`personas/dialectic-advocate.toml`), using TOML triple-quoted strings for
the prose fields:

```toml
id = "dialectic-advocate"
name = "Dialectic Advocate"
description = "An Electric Monk that fully believes the proposal is sound and makes the strongest committed case for adopting it."
archetype = "believer"
stance = "This proposal is fundamentally sound; the strongest, most committed case is FOR adopting it as-is."
modes = ["believe", "analyze", "advise"]
tags = ["dialectic", "thesis"]
specRef = "dialectic-advocate.md"

framingCorrections = [
  "Your case is NOT naive boosterism. Both advocate and adversary want a good outcome; the real tension is which risks are load-bearing.",
]

antiHedging = """
You are an Electric Monk: your one job is to believe this position fully so the reader doesn't have to. Do not hedge, do not say "both sides have merit," do not produce a balanced comparison. Make the maximal committed case and inhabit it.
"""

ignores = [
  "Cost and downside-risk framing — defer that to the Adversary and Hostile Auditor.",
]

prompt = """
You are the Dialectic Advocate. Believe, with full conviction, that the design under review is sound, and build the strongest committed case for adopting it. Name the ontological claim (what the design fundamentally IS and why that is right), state the opponent's strongest objection in terms they would endorse and show specifically why it fails, push your thesis to its strongest uncomfortable form, and make your reasoning skeleton explicit (premises, key steps, where the argument is load-bearing). Do not produce a balanced comparison. End with four lists: claims, risks, questions, recommendations.
"""
```

## Dialectic personas

Each persona gets a distilled `prompt` (council/ANALYZE-tuned) plus a rich `.md` canonical spec
mirroring the game-theorist format (Knowledge Core, Four Modes with Output Contracts, Guardrails,
Usage Examples). All end with the **Council Output Contract** (claims/risks/questions/recommendations)
for lossless BAML normalization.

| id | archetype | stance / role | primary modes | `ignores` (decorrelation) |
|---|---|---|---|---|
| `dialectic-advocate` | believer | Proposal is sound — maximal committed case FOR | believe, analyze, advise | downside-risk framing → Adversary/Auditor |
| `dialectic-adversary` | believer | Proposal is flawed — maximal committed case AGAINST | believe, analyze, red-team | benefits/advocacy framing → Advocate |
| `hostile-auditor` | auditor | "Be correct, not fair"; attack on the proposal's own standard | red-team, grade | proposing alternatives → Synthesist; cheerleading |
| `synthesist` | synthesist | Belief-free: shared assumptions → determinate negation → hidden question → sublation candidates | synthesize, analyze | committing to a side; advocacy |

Discipline encoded across the believers: **full belief, anti-hedging, framing corrections, push to the
extreme, explicit reasoning skeleton**, and **decorrelation** via complementary `ignores` so Advocate
and Adversary occupy genuinely different frames rather than "same frame, opposite conclusion."

The `hostile-auditor` `.md` encodes the Phase-6 auditor moves: compare to the status quo (not the
ideal), undercutting > self-defeating > rebutting defeaters, prospective hindsight, compromise
detection, reversibility/closure checks, and "if it's genuinely strong, say so and stop."

The `synthesist` `.md` encodes Phase-4/5: self-sublation (internal tensions), surface contradiction,
shared assumptions, determinate negation (complementary failures), the hidden question, and a
`SYNTHESIZE` mode that proposes sublation candidates. In the council it would overlap the Judge
reducer, so it is intentionally excluded from the `dialectic` set and reserved for the future
dialectic workflow.

## Council integration & back-compat

No behavioral change to the council; only the persona *source* moves.

- **`src/decision-council/types.ts`** re-exports `PersonaDefinition`, `PersonaSet`,
  `PersonaDefinitionSchema`, `PersonaSetSchema` from `../personas/schema.js` (existing imports keep
  working). `RoundBrief` is shared with the composer (define in `src/personas` or a small shared
  module and re-export from `types.ts`).
- **`src/decision-council/personas.ts`** becomes a thin re-export layer that preserves the current
  public surface, now sourced from the registry:
  - `resolvePersonaSet`, `resolvePersonaSetByName` ← `../personas/registry.js`
  - `defaultPersonaSet = getPersonaSet("default")`, `strategicPersonaSet = getPersonaSet("strategic")`,
    `gameTheorist = getPersona("game-theorist")`
  - `personaSetRegistry` = record of loaded sets (`default`, `strategic`, `dialectic`)
- **`src/decision-council/personaWorker.ts`** `buildPersonaPrompt(persona, brief)` delegates to
  `composePersonaPrompt(persona, { brief })`. `customAgents[].prompt` stays `persona.prompt`.
- **`src/index.ts`** keeps exporting the same symbols
  (`defaultPersonaSet, gameTheorist, personaSetRegistry, resolvePersonaSet, resolvePersonaSetByName,
  strategicPersonaSet` + the two types); it may additionally export the new `src/personas` surface.
- **`src/cli.ts`** / **`runner.ts`** unchanged; `--persona-set dialectic` now resolves.
- **Router:** unchanged. New `personaId`s (`dialectic-advocate`, etc.) fall back to the router's
  default policy; per-persona routing policies are a possible later addition.
- **Migrated data fidelity:** `default` must reproduce the existing names/order
  (`Socratic Questioner`, `Deep Module/DRY Architect`, `Pragmatic Builder`, `Skeptic`) and
  `strategic` = those four + `Strategic Game Theorist`, so existing assertions in
  `personas.test.ts` / `runner.test.ts` / `types.test.ts` stay green (with minor updates only where
  they referenced in-code construction).

### Dependency

Add `smol-toml` (runtime dependency; ESM/TS-native, TOML 1.0.0 compliant).

## Testing & verification

New tests:

- `tests/personas/schema.test.ts` — valid parse, defaults applied, invalid rejected, flat persona
  back-compat.
- `tests/personas/composer.test.ts` — **snapshot/equality test** that a flat persona composes
  byte-identically to the previous `buildPersonaPrompt`; structured persona includes stance, framing,
  anti-hedging, ignores, and mode lines in order.
- `tests/personas/registry.test.ts` — loads the `personas/` dir, indexes by id, resolves
  `default`/`strategic`/`dialectic`, throws on unknown set/persona with available-names message,
  `synthesist` loadable but in no set, `WEAVEKIT_PERSONAS_DIR` override.

Updated tests:

- `tests/decision-council/personas.test.ts`, `runner.test.ts`, `types.test.ts`,
  `personaWorker.test.ts` — keep passing against the migrated registry; assert `dialectic` set
  contents and that `--persona-set dialectic` is accepted in `tests/cli.test.ts`.

Commands (must be green): `npm test`, `npm run typecheck`, `npm run build`.

## Risks & open decisions

- **Sync file I/O at module load.** Small TOML files read once via `readFileSync`; preserves the sync
  `resolvePersonaSetByName` contract. Risk: a missing/invalid `personas/` dir fails at import — fail
  fast with a clear error naming the resolved path.
- **Personas dir path resolution** across dev (`tsx` over `src/`), build (`dist/`), and the eval
  provider (different cwd). Mitigation: resolve relative to `import.meta.url` (file-relative, not
  cwd-relative) + `WEAVEKIT_PERSONAS_DIR` override; covered by a registry test.
- **id/filename mismatch:** the existing canonical file is `strategic-game-theorist.md` while the id is
  `game-theorist`. Decision: keep the file and point `game-theorist.toml.specRef` at it (no rename, no
  churn). Open: rename to `game-theorist.md` for consistency if preferred.
- **Believers without an orchestrator.** In the N-critic council there is no determinate-negation/
  sublation step; Advocate/Adversary act as strong opposed critics and the Judge synthesizes. The full
  dialectic engine is a future workflow (non-goal here).
- **Decorrelation is authored, not enforced.** `ignores` encodes "what you ignore" but does not
  guarantee non-overlap; quality depends on the `.md`/`prompt` authoring. A future check could measure
  cross-persona overlap.
- **Migration churn.** Moving the just-added in-code `default`/`strategic`/`gameTheorist` into TOML
  rewrites recent code, but yields a single source of truth and is covered by preserved tests.

## References

- hegelian-dialectic-skill (KyleAMathews): `README.md`, `SKILL.md`, and
  `reference/phase2-monk-prompts.md`, `phase4-determinate-negation.md`,
  `phase6-stage-b-hostile-auditor.md`.
- EXA research (2026-06-25): Consilium Protocol (cognitive personas); CHAL (arXiv 2605.12718, epistemic
  personas as hyperparameters); `larva`, `persona-object-protocol`, `PersonaNexus`, `ethos`
  `FilePersonalityRegistry`, `ai-infra` (registry-backed persona configs); `advocate`, `firing-squad`,
  `the-tribunal`, `spectra` (adversarial/deliberation panels; "what you ignore" decorrelation);
  Du et al. "Improving Factuality and Reasoning through Multiagent Debate"; "Debate-to-Write"
  (persona = description + stance).
- Repo prior art: `personas/strategic-game-theorist.md`; `src/decision-council/personas.ts`,
  `personaWorker.ts`, `runner.ts` (commits `30e81ce`, `0b47297`, `764246f`);
  `docs/superpowers/specs/2026-06-25-decision-council-eval-corpus-design.md`.
