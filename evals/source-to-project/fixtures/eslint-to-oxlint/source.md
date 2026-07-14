# Safe ESLint-to-Oxlint migration

Treat a linter replacement as a behavior migration, not a dependency rename. Install Oxlint through its documented package and CLI, then use its native configuration and ignore mechanisms.

Before removing ESLint, inventory every enabled core rule, plugin rule, preset, global, ignore, warning threshold, editor action, and CI command. Classify each rule as supported-equivalent, supported-but-semantically-different, unsupported, or obsolete. Retain a narrowly scoped ESLint compatibility layer for unsupported rules rather than silently dropping checks.

Stage coexistence: add Oxlint, run both tools, translate configuration, fix code or document deliberate differences, update stable project scripts, CI and editor integration, then clean up only obsolete dependencies and files. Validate the real Oxlint CLI, the compatibility command, tests and typecheck. Document rollback criteria and the exact script/dependency reversal.
