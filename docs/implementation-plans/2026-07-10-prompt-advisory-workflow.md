# Router Workflow Implementation Plan

## Objective

Build a new Weavekit macro-workflow template that accepts any user prompt and returns a decisive next-action recommendation across harnesses, harness abilities, Weavekit workflows, models, and manual Herdr worktree handoff options.

## Decisions captured from grilling

| Decision                                                                         | Plan consequence                                                                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The feature is a new Router workflow, not an expanded Initial router.            | Add a new macro-workflow template and typed advisory contracts instead of replacing `src/initialRouter.ts`. |
| The workflow is advisory by default.                                             | The run must not modify target projects or spawn agents while producing recommendations.                    |
| Herdr handoff is manual for now through a Create Worktree button.                | Dashboard may expose a button only when handoff requirements are complete; no automatic launch path in v1.  |
| Capability catalog and routing preference overlay live in typed Weavekit config. | Extend `src/config.ts` and config tests rather than using workflow entity manifests as the source of truth. |
| Capability refresh is explicit and manually applied.                             | Add a future-facing refresh design seam, but v1 recommendation reads config synchronously.                  |
| The primary output is one recommendation plus two alternatives.                  | BAML output schema must model a primary recommendation and alternatives.                                    |
| The primary recommendation must include a route-specific prompt rewrite.         | BAML contract must require `primary.promptRewrite`.                                                         |
| Ambiguous prompts should recommend `grill-with-docs` from `mattpocock/skills`.   | The route taxonomy includes `grill-with-docs`, and low-confidence/missing-field prompts route there.        |
| Decision Council is a possible recommended route, not an internal dependency.    | The advisory DAG should not call Decision Council for routing.                                              |
| V1 uses a 12-route eval corpus.                                                  | Add provider/eval coverage for all canonical routes.                                                        |

## Requirements

| ID     | Requirement                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PA-001 | WHEN a user submits a prompt to the Router workflow, THE SYSTEM SHALL return one primary next-action recommendation and two alternatives.                                                                          |
| PA-002 | WHEN the workflow returns a primary recommendation, THE SYSTEM SHALL include a route-specific prompt rewrite for that recommendation.                                                                              |
| PA-003 | WHEN the prompt is too ambiguous or missing safe handoff fields, THE SYSTEM SHALL recommend the `grill-with-docs` route rather than inventing missing requirements.                                                |
| PA-004 | WHEN a route candidate is scored, THE SYSTEM SHALL consider task fit, context availability, mutation risk, parallelizability, automation or handoff fit, model specialty, and routing preference overlay match.    |
| PA-005 | WHEN capability catalog entries or routing overlays are configured, THE SYSTEM SHALL load them through typed Weavekit config.                                                                                      |
| PA-006 | WHEN a recommendation includes Herdr worktree handoff, THE SYSTEM SHALL mark Create Worktree eligible only if target project, branch or worktree name, chosen harness or agent, and rewritten prompt are complete. |
| PA-007 | WHEN a Router workflow completes, THE SYSTEM SHALL produce deterministic report artifacts suitable for dashboard display.                                                                                          |
| PA-008 | WHEN v1 is validated, THE SYSTEM SHALL pass a 12-route eval corpus with expected primary routes, plausible harness/model/ability selections, required prompt rewrites, and correct Create Worktree eligibility.    |

## Route taxonomy

| Route                   | Intended use                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `direct-answer`         | Narrow questions or simple guidance that the current harness should answer directly.    |
| `refine-prompt`         | User wants a clearer prompt but not a goal, workflow, or execution handoff.             |
| `goal-prompt`           | User wants durable, persistent goal-mode execution or a prompt rewritten for goal mode. |
| `plan`                  | User needs an implementation plan before coding.                                        |
| `grill-with-docs`       | Prompt is ambiguous or needs structured interrogation plus domain-model updates.        |
| `research`              | Prompt depends on external/current evidence or multi-source synthesis.                  |
| `local-code-change`     | Best handled by a local coding harness in the current worktree.                         |
| `fleet-parallel`        | Work is complex and decomposable into independent parallel subagent tasks.              |
| `remote-delegate-pr`    | Work should be handed to a remote/cloud PR-producing agent.                             |
| `decision-council`      | Prompt needs tradeoff-heavy recommendation or multi-perspective deliberation.           |
| `source-to-project`     | Prompt maps a source artifact against a target project for opportunities and plans.     |
| `manual-herdr-worktree` | Prompt should become a manual Herdr Create Worktree handoff.                            |

## Architecture

Add a new static macro-workflow template, `router`, with two nodes.

| Node            | Kind       | Harness                                           | Behavior                                                                                               |
| --------------- | ---------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `advise-prompt` | `planning` | `reporter` or new deterministic/BAML adapter path | Calls a BAML function that classifies the prompt, ranks candidates, and returns the advisory contract. |
| `report`        | `report`   | `reporter`                                        | Writes deterministic Markdown/JSON artifacts for CLI and dashboard display.                            |

Do not use Decision Council inside this workflow. Do not spawn Herdr worktrees during the run. The dashboard action is a follow-on manual promotion control.

## Data model and BAML contract

Add `baml_src/router.baml` with generated types similar to:

```baml
enum RouterRoute {
  direct_answer
  refine_prompt
  goal_prompt
  plan
  grill_with_docs
  research
  local_code_change
  fleet_parallel
  remote_delegate_pr
  decision_council
  source_to_project
  manual_herdr_worktree
}

class RouterRouteScore {
  dimension string
  score int
  rationale string
}

class RouterHandoff {
  provider string?
  targetProjectId string?
  branchOrWorktreeName string?
  harnessOrAgent string?
  createWorktreeEligible bool
  missingRequirements string[]
}

class RouterRecommendation {
  route RouterRoute
  harness string
  ability string?
  model string?
  modelRationale string
  confidence double
  rationale string
  scores RouterRouteScore[]
  promptRewrite string?
  handoff RouterHandoff?
}

class RouterResult {
  primary RouterRecommendation
  alternatives RouterRecommendation[]
  catalogEvidence string[]
  preferenceEvidence string[]
  warnings string[]
}
```

Implementation note: make `primary.promptRewrite` required in TypeScript validation even if BAML keeps it optional for alternatives.

## Config plan

Extend `src/config.ts` with:

```ts
export type RouterRoute = /* 12-route union */;

export type CapabilityCatalogEntry = {
  id: string;
  route: RouterRoute;
  harness: string;
  ability?: string;
  model?: string;
  taskFit: string[];
  strengths: string[];
  limitations: string[];
  source?: string;
};

export type RoutingPreferenceOverlay = {
  id: string;
  match: string[];
  prefer?: {
    route?: RouterRoute;
    harness?: string;
    ability?: string;
    model?: string;
  };
  weight?: number;
  force?: boolean;
  rationale: string;
};

export type RouterDefaults = {
  primaryModel: string;
  catalog: CapabilityCatalogEntry[];
  preferences: RoutingPreferenceOverlay[];
};
```

Add `router: RouterDefaults` to `WeavekitConfig`. Defaults should include at least Copilot CLI direct/refine/goal/fleet/delegate, Codex local implementation, Claude Opus 4.8 UI/frontend planning preference, Decision Council, source-to-project, and grill-with-docs.

## Implementation phases

### 1. Config and domain types

- Extend `WorkflowPlanTemplateId` with `router`.
- Add typed router config structures in `src/config.ts`.
- Add default catalog and preference overlay entries.
- Add TOML parsing for `[router]`, catalog arrays, and preference overlays.
- Extend `tests/config.test.ts` to verify defaults, user overrides, weighted preferences, and `force=true`.

### 2. BAML advisory contract

- Add `baml_src/router.baml`.
- Update BAML generation.
- Add a small adapter under `src/macro-workflow/router/` that calls the generated BAML function with prompt, route taxonomy, capability catalog, and preference overlay.
- Validate that primary recommendation has a prompt rewrite and at most two alternatives are returned.

### 3. Workflow template and runner integration

- Add `router` to `src/macro-workflow/types.ts`.
- Add `makeRouterPlan` in `src/macro-workflow/templates.ts`.
- Add execution handling for the advisory node in the macro-workflow harness/runner path.
- Ensure output is read-only and max replans is 0 or 1.
- Add deterministic artifacts: JSON result and Markdown report.

### 4. CLI and input handling

- Extend `weavekit workflow plan|run|dashboard --template router`.
- Accept prompt text through existing `--prompt` and input-file paths.
- Ensure missing prompt produces a clear CLI error.
- Include the primary route and rewritten prompt in CLI output.

### 5. Dashboard support

- Extend dashboard state rendering for `router` reports.
- Show primary recommendation, alternatives, score dimensions, evidence, warnings, and rewritten prompt.
- Add a disabled/enabled Create Worktree button for `manual-herdr-worktree` recommendations.
- The button must be enabled only when `RouterHandoff.createWorktreeEligible` is true.
- Reuse the existing Herdr launcher provider shape where possible, but keep the action manual.

### 6. Manual Herdr handoff

- Add a router handoff launch context separate from source-to-project PR launch context.
- Required fields: target project, branch or worktree name, harness or agent, and rewritten prompt.
- Use configured project catalog and prLauncher-style agent options where applicable.
- Do not auto-launch from workflow completion.
- Add tests for eligibility and missing requirements.

### 7. Capability refresh seam

- Add a non-default maintenance command or documented future template shape for capability refresh.
- V1 can produce a cited proposed config patch without applying it.
- Do not wire live web research into normal per-router runs.

### 8. Eval corpus and validation

- Add a router eval provider similar to `src/eval/providers/router.ts`.
- Add 12 eval cases, one per canonical route.
- Assert expected primary route, non-empty prompt rewrite for primary, plausible harness/model/ability, and Create Worktree eligibility behavior.
- Add or extend package script if needed, for example `eval:router`.

## Suggested file map

| File                                                     | Change                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `CONTEXT.md`                                             | Already updated with Router workflow vocabulary.                     |
| `baml_src/router.baml`                                   | New BAML schema and function.                                        |
| `src/config.ts`                                          | Add router config, defaults, and TOML parsing.                       |
| `tests/config.test.ts`                                   | Add config parsing/default tests.                                    |
| `src/macro-workflow/types.ts`                            | Add `router` template id and any needed node capability fields.      |
| `src/macro-workflow/templates.ts`                        | Materialize the new workflow plan.                                   |
| `src/macro-workflow/router/*`                            | New adapter, validation, artifacts, and handoff eligibility helpers. |
| `src/macro-workflow/runner.ts` or harness dispatch files | Execute the advisory BAML node.                                      |
| `src/macro-workflow/artifacts.ts`                        | Publish JSON and Markdown report artifacts.                          |
| `src/macro-workflow/dashboardServer.ts`                  | Add dashboard API and Create Worktree endpoint for router.           |
| `src/macro-workflow/dashboard/*`                         | Render router recommendation and manual handoff button.              |
| `src/eval/providers/router.ts`                           | Eval provider for router outputs.                                    |
| `src/eval/router/*` or existing eval config              | 12-route eval corpus and assertions.                                 |
| `package.json`                                           | Add eval script only if the repo pattern requires one.               |

## Validation gates

Run these after the relevant implementation phases:

```sh
nub run baml-generate
nub run typecheck
nub run test -- tests/config.test.ts
nub run test -- tests/router
nub run eval:router
nub run lint
```

Also run `mise run doctor` after editing workflow entity manifests, prompt Markdown references, BAML output schemas/functions, or skill capability wiring. This plan does not require entity-manifest changes unless implementation chooses to expose router as a workflow entity.

## Deferred scope

- Automatic Herdr handoff after recommendation.
- Live documentation research during every advisory run.
- Auto-applying capability refresh patches.
- Replacing the existing Initial router.
- Using Decision Council internally to decide routes.
- Full autonomous PR creation from router output.

## First implementation slice

Implement phases 1 through 4 first. That delivers a CLI-usable `router` workflow with typed config, BAML output, deterministic report artifacts, and tests. Then implement dashboard and manual Create Worktree support as a second slice.
