/**
 * Compatibility re-export. Herdr worktree provisioning moved to `src/herdr/` (ADR 0011) so
 * `submind-poc` and `rlm-poc`'s `invoke_trellage` share one implementation instead of forking it.
 */
export * from "../herdr/provision.js";
