# Council of High Intelligence Persona Integration Design

## Objective

Make all 18 members from `0xNyk/council-of-high-intelligence` available to Weavekit's existing deliberation council as dynamically selectable personas. Preserve Weavekit's orchestration boundaries: the entity catalog owns persona definitions, BAML chooses a small task-relevant council, the Copilot SDK runs selected personas, and BAML normalizes and reduces their critiques.

## Source and research basis

The upstream source is pinned to commit [`f996d386eb2c33601977915828f5f3ea383e9f49`](https://github.com/0xNyk/council-of-high-intelligence/commit/f996d386eb2c33601977915828f5f3ea383e9f49), retrieved on 2026-07-10. Its 18 canonical persona files live under [`agents/`](https://github.com/0xNyk/council-of-high-intelligence/tree/f996d386eb2c33601977915828f5f3ea383e9f49/agents).

Exa-assisted research used current upstream sources and peer-reviewed work on multi-agent debate, dynamic agent selection, role diversity, aggregation, and failure modes. The evidence supports:

- blind independent first responses before peer influence;
- selecting a small task-specific subset instead of invoking every available persona;
- preferring distinct reasoning methods and low redundancy;
- treating persona names as prompted analytical lenses, not validated expertise or faithful simulations;
- preserving dissent and avoiding the assumption that agreement proves correctness;
- retaining Weavekit's bounded rounds and structured reducer instead of copying a second orchestration protocol.

Relevant research includes [Du et al., ICML 2024](https://proceedings.mlr.press/v235/du24e.html), [ChatEval, ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/hash/25cc3adf8c85f7c70989cb8a97a691a7-Abstract-Conference.html), [ReConcile, ACL 2024](https://aclanthology.org/2024.acl-long.381/), [Multi-LLM Debate, NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/file/32e07a110c6c6acf1afbf2bf82b614ad-Paper-Conference.pdf), [persona prompting evidence, EMNLP 2024](https://aclanthology.org/2024.findings-emnlp.888/), and [Zhu et al., ACL 2026](https://aclanthology.org/2026.findings-acl.1694/).

## Canonical roster

All 18 personas retain upstream canonical IDs so completeness and provenance are directly auditable:

| ID                    | Figure                | Distinct reasoning method       |
| --------------------- | --------------------- | ------------------------------- |
| `council-aristotle`   | Aristotle             | taxonomic decomposition         |
| `council-socrates`    | Socrates              | elenchic questioning            |
| `council-sun-tzu`     | Sun Tzu               | adversarial simulation          |
| `council-ada`         | Ada Lovelace          | formal stepwise verification    |
| `council-aurelius`    | Marcus Aurelius       | negative visualization          |
| `council-machiavelli` | Machiavelli           | incentive backward induction    |
| `council-lao-tzu`     | Lao Tzu               | via negativa                    |
| `council-feynman`     | Richard Feynman       | first-principles reconstruction |
| `council-torvalds`    | Linus Torvalds        | empirical reduction to practice |
| `council-musashi`     | Miyamoto Musashi      | timing and tempo analysis       |
| `council-watts`       | Alan Watts            | frame dissolution               |
| `council-karpathy`    | Andrej Karpathy       | gradient empiricism             |
| `council-sutskever`   | Ilya Sutskever        | scaling extrapolation           |
| `council-kahneman`    | Daniel Kahneman       | System 2 bias audit             |
| `council-meadows`     | Donella Meadows       | causal-loop mapping             |
| `council-munger`      | Charlie Munger        | multi-model inversion           |
| `council-taleb`       | Nassim Nicholas Taleb | tail stress testing             |
| `council-rams`        | Dieter Rams           | subtractive essentialism        |

## Chosen approach

Add the roster as 18 source-distinct, namespaced entities alongside the 11 existing local personas. The resulting candidate pool has 29 personas. Namespacing preserves every canonical upstream member without renaming or replacing stable local IDs such as `socratic` and `sun-tzu`.

The selector will explicitly avoid choosing substantially redundant perspectives in the same round unless the task benefits from a deliberate polarity pair. This prevents the two overlapping figures from degrading a small council while retaining both local and source-derived contracts.

Alternatives rejected:

1. Merging upstream Socrates and Sun Tzu into the existing local personas would produce a cleaner pool but would lose two canonical IDs and make exact upstream completeness harder to prove.
2. Porting upstream triads, provider detection, confidence voting, and coordinator prompts would duplicate Weavekit's orchestration layer and broaden the task beyond making the personas available. Research does not establish that more rounds or static panels are universally better.

## Architecture

### Persona entities

Each new member is one sibling pair under `entities/personas/`:

- `council-<member>.yaml` contains selector-facing identity, description, role, archetype, domain and reasoning-method tags, use conditions, avoid conditions, and the existing `harness_then_baml` execution contract.
- `council-<member>.md` contains the normalized local prompt.

No new runtime registry or parallel configuration source will be introduced. `src/entities/catalog.ts` already turns valid persona manifests into runtime definitions, and `src/personas/registry.ts` already exposes the entire catalog to the decision council.

### Prompt normalization boundary

The external Markdown is source material, not a privileged runtime contract. Each local prompt will retain the upstream member's:

- identity and epistemic stance;
- grounding protocol;
- analytical method;
- characteristic strengths;
- explicit blind spots.

Each local prompt will omit or rewrite upstream host-specific material:

- Claude/Codex tool permissions and model choices;
- `/council` command behavior;
- upstream round numbers, word limits, stance lines, and standalone output schema;
- instructions to engage peer text that Weavekit has not supplied;
- provider-routing and Chairman behavior.

This keeps the persona responsible for analysis while `composePersonaPrompt`, the Copilot SDK worker, and `NormalizePersonaCritique` remain responsible for runtime context and output structure.

### Dynamic selection

`baml_src/personas.baml` remains the only selection intelligence. Its candidate card already contains `id`, `name`, `description`, `archetype`, `tags`, `useWhen`, and `avoidWhen`, which is sufficient for this integration.

The chooser instructions will add three requirements:

1. Select distinct reasoning methods that complement one another after establishing task relevance.
2. Avoid redundant candidates with materially overlapping domains and methods unless deliberate opposition is useful.
3. On later rounds, use unresolved signals and the round focus to add a missing lens rather than mechanically repeating the previous panel.

The output contract remains `personaIds` plus one rationale sentence. The existing validation continues to reject unknown, duplicate, and out-of-range IDs.

### Runtime data flow

1. The entity catalog validates and loads all 29 persona definitions.
2. `runDecisionCouncil` passes that complete pool to `createBamlPersonaSelector`.
3. BAML selects 2–6 relevant, complementary personas for the round.
4. `runDecisionCouncilRound` invokes only the selected members in parallel, preserving blind independent responses within the round.
5. Existing BAML adapters normalize critiques, assess convergence and diminishing returns, and synthesize the final report.

No public CLI flags, state schemas, artifact schemas, model routing contracts, or stop conditions change.

## Provenance and licensing

The upstream repository currently conflicts with itself: its root `LICENSE`, GitHub metadata, plugin manifest, and header badge say MIT, while a stale README footer says CC0. The conservative implementation will treat MIT as operative.

Add `THIRD_PARTY_NOTICES.md` containing:

- project and repository name;
- pinned upstream commit and retrieval date;
- copyright `2026 nyk`;
- the complete MIT permission and warranty notice;
- an explicit statement that local prompts are normalized adaptations;
- a statement that named personas are prompted analytical lenses and not endorsements or representations of the named individuals' actual views.

## Error handling and invariants

- Missing, empty, misnamed, or schema-invalid entity files fail `mise run doctor` and catalog loading.
- Every canonical roster ID must resolve through `getPersona` and appear in `listPersonas`.
- The 18-member set must contain no duplicates and must be a subset of the runtime candidate pool.
- Every imported prompt must contain its declared reasoning method or an unambiguous human-readable equivalent.
- Every imported manifest must contain non-empty selector metadata.
- The BAML chooser must continue to reject unknown, duplicate, and out-of-range selections.
- Existing local personas and their stable IDs remain unchanged.
- External tool permissions, model choices, and instruction-priority changes must not be copied into local prompts.

## Test-driven implementation strategy

Implementation begins with failing tests:

1. Add an exact canonical 18-ID expectation and assert all 18 are present in the loaded catalog.
2. Assert each imported persona has selector metadata, a substantial normalized prompt, and its expected reasoning-method anchor.
3. Update exact shipped-catalog expectations from 11 to 29 without weakening duplicate-ID or schema validation.
4. Add a BAML-source contract test for complementary-method selection and redundancy avoidance.
5. Run the focused tests and observe the expected failures before adding production entities or chooser instructions.

After implementation:

```sh
nub run baml-generate
mise run doctor
nub run test -- tests/entities/catalog.test.ts tests/decision-council/personas.test.ts tests/personas/registry.test.ts tests/personas/selectorBaml.test.ts
nub run fmt
nub run lint
nub run typecheck
nub run test
```

Because entity and BAML files change, `nub run baml-generate` and the post-edit `mise run doctor` are mandatory. Generated files under `src/generated/**` are regenerated rather than hand-edited.

## Acceptance criteria

- All 18 canonical `council-*` IDs exist as valid entity manifests with sibling normalized prompts.
- `listPersonas()` exposes all 18 to the same candidate pool used by `runDecisionCouncil`.
- The BAML chooser receives all 18 candidate cards and can return any of their IDs.
- Selection instructions prefer relevant, complementary reasoning methods and avoid redundant perspectives.
- The 11 existing personas remain available and unchanged.
- Third-party provenance and MIT terms are recorded.
- Entity validation, generated BAML consistency, formatting, linting, type checking, focused tests, and the full test suite pass.

## Out of scope

- Static triad/profile CLI flags.
- Upstream provider auto-detection or provider-affinity routing.
- Confidence-weighted voting or a new stance schema.
- A replacement Chairman/reducer.
- Cross-examination protocol changes.
- Claims that the named personas faithfully simulate the corresponding people.
