/**
 * "Mission statement" text passed to `AnalyzeSubmindTrace` so the self-improvement auditor
 * compares Submind's actual executed path against the behavioral rules Mastermind expects it to
 * follow. `RLM_SUBMIND_SYSTEM_PROMPT` (src/rlm-poc/submindPrompt.ts) is pulled in verbatim - its
 * literal system prompt, not a paraphrase - so it always matches what the Submind session actually
 * saw. `DecideNextAction`'s BAML prompt is not similarly importable at runtime (it lives in
 * baml_src/mastermind.baml, consumed only through the generated client), so its "DELEGATE_SUBMIND
 * means planning, fan-out, synthesis, or multiple workers are likely needed" rule is restated here
 * as a short, explicitly-labeled excerpt. Keep this in sync with baml_src/mastermind.baml's
 * `DecideNextAction` function if that rule text changes.
 */
export const MASTERMIND_DECISION_MISSION_STATEMENT = `Mastermind's DecideNextAction classifier routes a reviewed Linear ticket to DELEGATE_SUBMIND
specifically when "planning, fan-out, synthesis, or multiple workers are likely needed" - i.e. the
ticket is not a single bounded implementation task. Mastermind expects the delegated Submind
session to actually decompose the work, delegate bounded pieces to appropriately-specialized
recursive profiles, reconcile their results, and verify the outcome against the ticket's acceptance
criteria before reporting completion - not to implement everything itself in one pass, and not to
delegate work to a mismatched profile or an unnecessary external harness.`;

export function collectMastermindMissionStatements(submindSystemPrompt: string): string[] {
  return [MASTERMIND_DECISION_MISSION_STATEMENT, submindSystemPrompt];
}
