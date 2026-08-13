/**
 * Compatibility re-export. The Herdr socket client moved to `src/herdr/` (ADR 0011) so
 * `submind-poc` and `rlm-poc`'s `invoke_trellage` share one client instead of forking it.
 */
export * from "../herdr/socket.js";
