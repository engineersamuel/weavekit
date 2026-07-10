# Council of High Intelligence Personas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add all 18 pinned Council of High Intelligence personas to Weavekit's manifest-backed persona catalog and teach the BAML selector to prefer complementary, non-redundant reasoning methods.

**Architecture:** Each imported persona remains a normal `harness_then_baml` entity with a sibling normalized Markdown prompt; the existing catalog and registry provide the only runtime discovery path. Tests define the pinned canonical roster and prompt anchors, while `ChoosePersonasForTask` remains the only selection intelligence and generated BAML code is refreshed from source.

**Tech Stack:** TypeScript, Vitest, YAML entity manifests, Markdown prompts, BAML, Nub, mise.

---

## File map and normalization contract

- `entities/personas/council-*.yaml` owns selector-facing metadata and the existing execution contract.
- `entities/personas/council-*.md` owns normalized analysis instructions only.
- `tests/personas/councilRoster.ts` owns the exact 18-ID roster and expected reasoning anchors for reuse by catalog, registry, and selector tests.
- `tests/entities/catalog.test.ts`, `tests/decision-council/personas.test.ts`, `tests/personas/registry.test.ts`, and `tests/personas/selector.test.ts` prove catalog completeness and runtime availability.
- `baml_src/personas.baml` owns complementary-method and later-round selection instructions.
- `tests/personas/selectorBaml.test.ts` guards the BAML source contract; `src/generated/**` is regenerated, never hand-edited.
- `THIRD_PARTY_NOTICES.md` owns pinned provenance, license text, adaptation disclosure, and named-persona disclaimer.

For every imported prompt, copy and lightly normalize only these upstream sections from the pinned source: `Identity`, `Grounding Protocol`, `Analytical Method`, `What You See That Others Miss`, and `What You Tend to Miss`. Remove YAML frontmatter, tools, models, `/council`, round numbers, peer-engagement requirements, provider routing, word limits, stance lines, and standalone schemas. End every prompt with this local contract:

```markdown
## Weavekit Council Output

Analyze the supplied task independently through this persona's reasoning method. Do not claim to represent the named person's actual views. State uncertainty and the limits of this lens explicitly.

End with four Markdown lists named exactly:

- `claims`: the conclusions supported by this lens;
- `risks`: failure modes, blind spots, and contrary evidence;
- `questions`: missing facts that could change the analysis;
- `recommendations`: concrete next actions justified by the analysis.
```

Every manifest uses `role: advisor`, `archetype: analyst`, at least two tags (domain plus reasoning method), one non-empty `useWhen`, one non-empty `avoidWhen`, and:

```yaml
execution:
  mode: harness_then_baml
  harness: copilot-sdk
  promptRef: ./council-aristotle.md # Every manifest substitutes its own exact sibling ID.
  output:
    normalizeWithBamlFunction: NormalizePersonaCritique
```

The pinned upstream checkout is `/tmp/council-of-high-intelligence-f996d386` at commit `f996d386eb2c33601977915828f5f3ea383e9f49`. If absent, clone `https://github.com/0xNyk/council-of-high-intelligence.git` there and check out that exact commit before reading any source text.

### Task 1: Provenance and foundational six-persona slice

**Files:**

- Create: `THIRD_PARTY_NOTICES.md`
- Create: `entities/personas/council-aristotle.{yaml,md}`
- Create: `entities/personas/council-socrates.{yaml,md}`
- Create: `entities/personas/council-sun-tzu.{yaml,md}`
- Create: `entities/personas/council-ada.{yaml,md}`
- Create: `entities/personas/council-aurelius.{yaml,md}`
- Create: `entities/personas/council-machiavelli.{yaml,md}`
- Modify: `tests/entities/catalog.test.ts`
- Modify: `tests/decision-council/personas.test.ts`

Use this exact metadata:

| ID                    | Name            | Description focus                                          | Tags                                             | Use when                                                        | Avoid when                                                 | Required prompt anchor         |
| --------------------- | --------------- | ---------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| `council-aristotle`   | Aristotle       | Categorization, definitions, and structural analysis       | `categorization`, `taxonomic-decomposition`      | terms, categories, or system structure are ambiguous            | an empirical trial would answer the question more directly | `taxonomic decomposition`      |
| `council-socrates`    | Socrates        | Assumption destruction through elenchic questioning        | `assumptions`, `elenchic-questioning`            | hidden premises or contradictions need examination              | the task needs direct execution with settled premises      | `elenchic questioning`         |
| `council-sun-tzu`     | Sun Tzu         | Adversarial strategy, terrain, and competitive positioning | `strategy`, `adversarial-simulation`             | opponents, incentives, timing, or contested terrain matter      | neutral implementation work has no adversarial actor       | `adversarial simulation`       |
| `council-ada`         | Ada Lovelace    | Formal systems, abstraction boundaries, and mechanization  | `formal-systems`, `formal-stepwise-verification` | invariants, algorithms, or abstraction levels need verification | human dynamics resist useful formalization                 | `formal stepwise verification` |
| `council-aurelius`    | Marcus Aurelius | Resilience, moral clarity, and controllable action         | `resilience`, `negative-visualization`           | consequences, controllability, or ethical steadiness matter     | competitive tactics or technical mechanics dominate        | `negative visualization`       |
| `council-machiavelli` | Machiavelli     | Power dynamics, incentives, and real behavior              | `incentives`, `incentive-backward-induction`     | stakeholder incentives or political behavior drive outcomes     | the problem is purely mechanical and actor-independent     | `incentive backward induction` |

- [ ] **Step 1: Write failing catalog and prompt-contract tests**

Add the six IDs to both exact shipped-persona expectations. In `tests/decision-council/personas.test.ts`, add:

```ts
const foundationalCouncilAnchors = {
  "council-aristotle": "taxonomic decomposition",
  "council-socrates": "elenchic questioning",
  "council-sun-tzu": "adversarial simulation",
  "council-ada": "formal stepwise verification",
  "council-aurelius": "negative visualization",
  "council-machiavelli": "incentive backward induction",
} as const;

it("loads the foundational imported council personas with normalized prompts", () => {
  for (const [id, anchor] of Object.entries(foundationalCouncilAnchors)) {
    const persona = getPersona(id);
    expect(persona.description.trim().length).toBeGreaterThanOrEqual(20);
    expect(persona.useWhen.length).toBeGreaterThan(0);
    expect(persona.avoidWhen.length).toBeGreaterThan(0);
    expect(persona.prompt.length).toBeGreaterThanOrEqual(600);
    expect(persona.prompt.toLowerCase()).toContain(anchor);
    expect(persona.prompt).toContain("## Weavekit Council Output");
    expect(persona.prompt).not.toMatch(/tools:|model:|\/council|Council Round 2/i);
  }
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `rtk nub run test -- tests/entities/catalog.test.ts tests/decision-council/personas.test.ts`

Expected: FAIL because `council-aristotle` and the other five manifests do not exist.

- [ ] **Step 3: Add the six normalized manifest/prompt pairs and notice**

Create each manifest using the exact table and shared execution contract. Normalize each corresponding pinned upstream prompt using the file-map rules. Ensure the human-readable reasoning-method phrase appears verbatim in the local prompt.

Create `THIRD_PARTY_NOTICES.md` with the repository name and URL, pinned commit, retrieval date `2026-07-10`, copyright `2026 nyk`, the full upstream MIT permission and warranty text, a statement that local prompts are normalized adaptations, and this disclaimer: `Named personas are prompted analytical lenses; they are not endorsements or representations of the named individuals' actual views.`

- [ ] **Step 4: Verify GREEN and validate entities**

Run: `rtk nub run test -- tests/entities/catalog.test.ts tests/decision-council/personas.test.ts`

Expected: PASS.

Run: `rtk mise run doctor`

Expected: `Entity catalog valid.` and a zero exit code.

- [ ] **Step 5: Format, self-review, and commit**

Run: `rtk nub run fmt`

Check that only the six requested pairs, notice, and two test files changed; confirm no upstream host/tool/round instructions survived.

Commit: `git add THIRD_PARTY_NOTICES.md entities/personas tests/entities/catalog.test.ts tests/decision-council/personas.test.ts && git commit -m "feat(personas): add foundational intelligence council lenses"`

### Task 2: Practical and reframing six-persona slice

**Files:**

- Create: `entities/personas/council-lao-tzu.{yaml,md}`
- Create: `entities/personas/council-feynman.{yaml,md}`
- Create: `entities/personas/council-torvalds.{yaml,md}`
- Create: `entities/personas/council-musashi.{yaml,md}`
- Create: `entities/personas/council-watts.{yaml,md}`
- Create: `entities/personas/council-karpathy.{yaml,md}`
- Modify: `tests/entities/catalog.test.ts`
- Modify: `tests/decision-council/personas.test.ts`

Use this exact metadata:

| ID                 | Name             | Description focus                                           | Tags                                                  | Use when                                                          | Avoid when                                              | Required prompt anchor            |
| ------------------ | ---------------- | ----------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------- |
| `council-lao-tzu`  | Lao Tzu          | Emergence, non-intervention, and removing forced complexity | `emergence`, `via-negativa`                           | subtraction or non-action may outperform intervention             | urgent corrective action is already established         | `via negativa`                    |
| `council-feynman`  | Richard Feynman  | First-principles reconstruction and explanation testing     | `first-principles`, `first-principles-reconstruction` | complexity, causality, or understanding needs a reality check     | taxonomy or stakeholder politics is the central problem | `first-principles reconstruction` |
| `council-torvalds` | Linus Torvalds   | Pragmatic engineering reduced to working evidence           | `engineering`, `empirical-reduction-to-practice`      | implementation, maintainability, or shipping evidence matters     | philosophical framing is more important than execution  | `empirical reduction to practice` |
| `council-musashi`  | Miyamoto Musashi | Strategic timing, tempo, and decisive action                | `timing`, `timing-tempo-analysis`                     | sequencing, momentum, or a narrow action window matters           | no meaningful timing or execution decision exists       | `timing and tempo analysis`       |
| `council-watts`    | Alan Watts       | Perspective shifts that dissolve false problems             | `reframing`, `frame-dissolution`                      | the framing may be creating the apparent problem                  | concrete operational constraints are already clear      | `frame dissolution`               |
| `council-karpathy` | Andrej Karpathy  | Empirical ML reasoning grounded in training dynamics        | `machine-learning`, `gradient-empiricism`             | model behavior, data, training, or empirical AI iteration matters | the task has no ML or empirical model component         | `gradient empiricism`             |

- [ ] **Step 1: Write the failing six-persona contract test**

Extend both exact shipped-persona arrays. Add a `practicalCouncilAnchors` object and a loop identical to Task 1's test, using the six IDs and anchors in this task's table.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `rtk nub run test -- tests/entities/catalog.test.ts tests/decision-council/personas.test.ts`

Expected: FAIL because the six new manifests are absent.

- [ ] **Step 3: Add the six normalized pairs**

Create the manifests from the exact table and shared contract. Normalize the matching pinned upstream prompts and include each anchor verbatim.

- [ ] **Step 4: Verify GREEN and validate entities**

Run: `rtk nub run test -- tests/entities/catalog.test.ts tests/decision-council/personas.test.ts`

Expected: PASS.

Run: `rtk mise run doctor`

Expected: `Entity catalog valid.` and a zero exit code.

- [ ] **Step 5: Format, self-review, and commit**

Run: `rtk nub run fmt`

Confirm no provider, model, tool, round, peer-engagement, or standalone-schema instructions remain.

Commit: `git add entities/personas tests/entities/catalog.test.ts tests/decision-council/personas.test.ts && git commit -m "feat(personas): add practical intelligence council lenses"`

### Task 3: Risk and systems six-persona slice plus runtime roster proof

**Files:**

- Create: `entities/personas/council-sutskever.{yaml,md}`
- Create: `entities/personas/council-kahneman.{yaml,md}`
- Create: `entities/personas/council-meadows.{yaml,md}`
- Create: `entities/personas/council-munger.{yaml,md}`
- Create: `entities/personas/council-taleb.{yaml,md}`
- Create: `entities/personas/council-rams.{yaml,md}`
- Create: `tests/personas/councilRoster.ts`
- Modify: `tests/entities/catalog.test.ts`
- Modify: `tests/decision-council/personas.test.ts`
- Modify: `tests/personas/registry.test.ts`
- Modify: `tests/personas/selector.test.ts`

Use this exact metadata:

| ID                  | Name                  | Description focus                                            | Tags                                      | Use when                                                          | Avoid when                                             | Required prompt anchor     |
| ------------------- | --------------------- | ------------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ | -------------------------- |
| `council-sutskever` | Ilya Sutskever        | Scaling frontiers, capability discontinuities, and AI safety | `ai-safety`, `scaling-extrapolation`      | scaling trends or capability-risk transitions matter              | the task has no AI scaling or safety dimension         | `scaling extrapolation`    |
| `council-kahneman`  | Daniel Kahneman       | Deliberate System 2 audit of cognitive bias                  | `decision-science`, `system-2-bias-audit` | judgment, forecasts, or cognitive biases may distort a decision   | the issue is a deterministic implementation defect     | `system 2 bias audit`      |
| `council-meadows`   | Donella Meadows       | Feedback loops, delays, and system leverage points           | `systems-thinking`, `causal-loop-mapping` | recurring behavior or unintended effects suggest system structure | a one-off local fix has no systemic feedback           | `causal-loop mapping`      |
| `council-munger`    | Charlie Munger        | Multi-model reasoning and inversion                          | `mental-models`, `multi-model-inversion`  | several disciplines or failure-by-inversion clarify the choice    | a single established technical procedure is sufficient | `multi-model inversion`    |
| `council-taleb`     | Nassim Nicholas Taleb | Fragility, asymmetry, and tail-risk stress testing           | `risk`, `tail-stress-testing`             | rare losses, uncertainty, or asymmetric exposure matter           | bounded average-case optimization is sufficient        | `tail stress testing`      |
| `council-rams`      | Dieter Rams           | User-centered simplicity through subtractive design          | `design`, `subtractive-essentialism`      | usability, essentialism, or removing excess matters               | the task is unrelated to a user-facing design choice   | `subtractive essentialism` |

- [ ] **Step 1: Write the shared roster fixture and failing integration tests**

Create `tests/personas/councilRoster.ts`:

```ts
export const COUNCIL_PERSONA_ANCHORS = {
  "council-aristotle": "taxonomic decomposition",
  "council-socrates": "elenchic questioning",
  "council-sun-tzu": "adversarial simulation",
  "council-ada": "formal stepwise verification",
  "council-aurelius": "negative visualization",
  "council-machiavelli": "incentive backward induction",
  "council-lao-tzu": "via negativa",
  "council-feynman": "first-principles reconstruction",
  "council-torvalds": "empirical reduction to practice",
  "council-musashi": "timing and tempo analysis",
  "council-watts": "frame dissolution",
  "council-karpathy": "gradient empiricism",
  "council-sutskever": "scaling extrapolation",
  "council-kahneman": "system 2 bias audit",
  "council-meadows": "causal-loop mapping",
  "council-munger": "multi-model inversion",
  "council-taleb": "tail stress testing",
  "council-rams": "subtractive essentialism",
} as const;

export const COUNCIL_PERSONA_IDS = Object.keys(COUNCIL_PERSONA_ANCHORS);
```

Refactor the two earlier anchor tests to use this shared object. Update the shipped-catalog exact expectations to all 29 IDs.

In `tests/personas/registry.test.ts`, assert every canonical ID resolves, the set has 18 unique IDs, and every imported persona has non-empty description/tags/useWhen/avoidWhen plus a prompt of at least 600 characters.

In `tests/personas/selector.test.ts`, add a test using the default candidate pool and a mocked `ChoosePersonasForTask` that returns `council-aristotle` and `council-rams`; capture the request and assert all 18 canonical IDs occur among `request.candidates`, then assert the selected results preserve those two IDs.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `rtk nub run test -- tests/entities/catalog.test.ts tests/decision-council/personas.test.ts tests/personas/registry.test.ts tests/personas/selector.test.ts`

Expected: FAIL because the final six manifests are absent and the runtime pool has fewer than 29 personas.

- [ ] **Step 3: Add the final six normalized pairs**

Create the manifests from the exact table and shared execution contract. Normalize the matching pinned upstream prompts and include each anchor verbatim.

- [ ] **Step 4: Verify GREEN and validate the complete catalog**

Run: `rtk nub run test -- tests/entities/catalog.test.ts tests/decision-council/personas.test.ts tests/personas/registry.test.ts tests/personas/selector.test.ts`

Expected: PASS.

Run: `rtk mise run doctor`

Expected: `Entity catalog valid.` and a zero exit code.

- [ ] **Step 5: Format, self-review, and commit**

Run: `rtk nub run fmt`

Confirm the canonical set is exactly 18 unique `council-*` IDs, the full runtime catalog is exactly 29 personas, and the original 11 IDs remain unchanged.

Commit: `git add entities/personas tests/entities/catalog.test.ts tests/decision-council/personas.test.ts tests/personas/registry.test.ts tests/personas/selector.test.ts tests/personas/councilRoster.ts && git commit -m "feat(personas): complete intelligence council roster"`

### Task 4: Complementary BAML selection policy and generated client

**Files:**

- Modify: `tests/personas/selectorBaml.test.ts`
- Modify: `baml_src/personas.baml`
- Regenerate: `src/generated/**`

- [ ] **Step 1: Write the failing BAML source-contract test**

Add this test:

```ts
it("instructs the chooser to prefer complementary methods and fill later-round gaps", async () => {
  const source = await readFile("baml_src/personas.baml", "utf8");

  expect(source).toContain("distinct reasoning methods");
  expect(source).toContain("materially overlapping domains and methods");
  expect(source).toContain("deliberate opposition");
  expect(source).toContain("previousSelectionIds");
  expect(source).toContain("previousRoundSignals");
  expect(source).toContain("missing lens");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `rtk nub run test -- tests/personas/selectorBaml.test.ts`

Expected: FAIL on the first missing complementary-selection phrase.

- [ ] **Step 3: Add the minimal selector rules**

Add these rules to `ChoosePersonasForTask` without changing its input/output schema or model:

```baml
    - After establishing task relevance, prefer distinct reasoning methods that
      complement one another.
    - Avoid candidates with materially overlapping domains and methods unless
      deliberate opposition would expose a useful conflict.
    - On later rounds, use request.previousSelectionIds,
      request.previousRoundSignals, and request.roundFocus to add a missing lens
      instead of mechanically repeating the previous panel.
```

- [ ] **Step 4: Regenerate and verify GREEN**

Run: `rtk nub run baml-generate`

Expected: BAML generation succeeds and updates only generated BAML client artifacts required by the source change.

Run: `rtk nub run test -- tests/personas/selectorBaml.test.ts`

Expected: PASS.

Run: `rtk mise run doctor`

Expected: `Entity catalog valid.` and a zero exit code.

- [ ] **Step 5: Format, self-review, and commit**

Run: `rtk nub run fmt`

Confirm no public schema, CLI flag, model route, stop condition, or orchestration protocol changed.

Commit: `git add baml_src/personas.baml src/generated tests/personas/selectorBaml.test.ts && git commit -m "feat(personas): select complementary council methods"`

## Integrated validation after all implementation tasks

**Files:**

- No new behavior; fix only defects exposed by validation.

- [ ] **Run generated-code and entity validation**

Run: `rtk nub run baml-generate`

Run: `rtk mise run doctor`

Expected: both exit zero; the doctor reports a valid entity catalog.

- [ ] **Run the focused acceptance suite**

Run: `rtk nub run test -- tests/entities/catalog.test.ts tests/decision-council/personas.test.ts tests/personas/registry.test.ts tests/personas/selector.test.ts tests/personas/selectorBaml.test.ts`

Expected: all focused files pass.

- [ ] **Run repository quality gates**

Run in order:

```sh
rtk nub run fmt
rtk nub run lint
rtk nub run typecheck
rtk nub run test
```

Expected: zero exit code for every command; full suite has no failures.

- [ ] **Inspect final scope and commit validation-only repairs if needed**

Run: `rtk git status --short` and `rtk git diff HEAD~4..HEAD --stat`.

Expected: only the design/plan, 18 entity pairs, shared roster fixture, four existing test files plus selector tests, BAML source/generated artifacts, and third-party notice are present. If validation required a repair, commit only that repair with `git commit -m "fix(personas): satisfy council integration validation"`; otherwise create no empty commit.
