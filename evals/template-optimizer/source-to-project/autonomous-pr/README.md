# Autonomous PR Template Optimizer Fixtures

Autonomous PR optimization is intentionally disabled until fixtures cover:

- explicit autonomous PR flag gating
- every included Opportunity confidence >= 0.95
- per-candidate final recommendation review
- parallel worktree creation through the configured Worktree creation provider
- one PR per eligible bundle or remaining individual Opportunity
- failure isolation across parallel PR paths
- no merge or self-approval behavior
