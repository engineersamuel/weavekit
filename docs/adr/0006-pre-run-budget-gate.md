# Pre-Run Budget Gate

Unattended weavekit paths need an admission check before they dispatch expensive LLM work. Token usage and estimated cost are already recorded after runs, but post-hoc reporting does not prevent runaway spend in Autonomous PR or Template Optimizer flows.

The pre-run budget gate is an in-process, harness-agnostic check that projects token and cost before dispatch. It reuses the pricing logic in `src/macro-workflow/usage.ts`, applies a configurable margin factor, and compares the effective projection against a cost ceiling and optional token ceiling. The default rollout mode is advisory `warn`, not hard blocking, because the estimate is intentionally rough and excludes fees such as tool-call charges, regional uplift, cache writes, and proxy-specific billing.

Configuration lives in the existing typed config:

```toml
[source_to_project.budget_gate]
enabled = true
mode = "warn"
ceiling_usd = 25
margin_factor = 1.5
token_ceiling = 250000

[projects.weavekit.budget_gate]
mode = "block"
ceiling_usd = 40
```

Project overrides merge over global defaults when a project catalog entry is resolved. Invalid values such as `margin_factor = 0.5`, `ceiling_usd = -10`, or `mode = "abort"` fail typed config loading instead of silently disabling the gate.

The gate supports reasoned overrides for legitimate high-cost or emergency runs. Operators may pass `--budget-override "<reason>"` where supported, or set `WEAVEKIT_BUDGET_OVERRIDE=1` with `WEAVEKIT_BUDGET_OVERRIDE_REASON`. Overrides downgrade a would-be block to allow only when a non-empty reason is present, and the launcher/optimizer writes an audit line for warn and override decisions.

Projection quality improves over time through a local JSON history at `~/.weavekit/node-cost-history.json`. Completed macro workflow usage summaries update rolling average tokens and estimated cost by `(harness, model, nodeId)`. Future projections prefer matching historical averages and fall back to conservative static call estimates when no history exists.

For Autonomous PR, the gate runs before Herdr worktree creation or agent dispatch. A block therefore leaves no worktree behind and spends no agent tokens. For the Template Optimizer, the gate runs after fixtures and candidate counts are known but before the optimizer loop generates challengers or judges fixtures. This composes with ADR 0005 iteration and candidate caps; it does not replace those caps and does not introduce a concurrency cap.

This design preserves ADR 0001's no-durable-work-queue constraint. The only persistence is local projection history for operator safety and future estimate quality; orchestration remains an isolated in-process run.

ADR 0007 adds durable snapshots for interrupted macro-workflow Runs, not queued budget-approved
work. Resume restores orchestration state and remaining nodes; admission checks remain launcher
policy and a persisted snapshot never authorizes background dispatch or bypasses a configured
gate.
