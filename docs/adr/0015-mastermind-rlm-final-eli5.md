# 0015 — Plain-language final review for RLM work

Status: accepted

## Context

An RLM-backed Mastermind attempt produces two different kinds of evidence. The execution storyboard
from [ADR 0014](0014-rlm-run-storyboard.md) shows recursion, delegation, chronology, and failures
while the run is active. The final marker-based code-review comment shows the independent
post-implementation verdict, acceptance coverage, findings, and manual verification.

Both artifacts are useful for technical audit, but neither gives a non-specialist a short answer to
five basic questions: what did we think, why did the work matter, what did success mean, what
happened, and what should happen next? The execution storyboard cannot answer those questions
authoritatively because it is finalized before the independent review verdict exists.

## Decision

- **Synthesize once at the final-review boundary.** `AssessPostImplementationReview` returns a
  required `PostImplementationReviewEli5` value with `hypothesis`, `purpose`, `goal`, `outcome`, and
  at most four ordered `nextSteps`. It uses the frozen ticket and independent review dossier in the
  same model call that sets the verdict. Prompt rules require simple language, evidence alignment,
  and verdict-specific next-step ordering. No second summarization call is added.

- **Keep the execution and result pictures separate.** The existing RLM storyboard continues to
  explain how the recursive work ran. A deterministic renderer under
  `src/mastermind/codeReview/eli5.ts` turns the reviewed ELI5 fields into an accessible SVG and PNG
  that explain what the final result means. TypeScript controls only bounded presentation; it does
  not perform the synthesis.

- **Put complete text before the picture.** The final code-review comment places `## ELI5` after the
  verdict and before `## Technical review`. Markdown repeats all five fields and ordered next steps.
  The PNG is supplementary, has descriptive alternative text, and uses labels and numbers in
  addition to color.

- **Limit the behavior to RLM execution.** Only reviews whose successful attempt used
  `RLM_SUBMIND` receive the ELI5 section and image. Direct-execution comments retain their prior
  format. The BAML result still carries the typed explanation so the assessment contract stays
  uniform.

- **Persist publication before the comment side effect.** The existing code-review
  `projection_json` stores the local SVG and PNG paths, uploaded PNG URL, and failure diagnostics.
  Mastermind persists that pending publication before creating the marker comment. A resumed
  projection reuses the stored URL and marker instead of knowingly uploading or commenting twice.
  No database migration is required.

- **Treat visual failure as non-fatal.** Rendering and attachment upload are best-effort. A failure
  adds one short visual-unavailable note while preserving the complete Markdown explanation,
  technical review, and authoritative verdict. A gateway without attachment upload publishes text
  only.

- **Accept legacy stored reviews.** Runtime normalization treats the ELI5 value as untrusted
  `unknown`. A pre-feature review row without that field follows the prior technical-comment path
  instead of failing deserialization or projection.

## Consequences

- A reader can understand the reviewed result before entering the technical evidence, while the
  detailed review remains unchanged below it.
- The infographic cannot disagree with a later verdict because it is generated from the same final
  assessment, after independent review.
- RLM final review writes two additional local files under
  `.weavekit/mastermind-code-review/<review-id>/` and can create one additional Linear attachment.
- The deterministic layout truncates visual copy to fixed bounds. The complete normalized text in
  Markdown remains the source for any detail omitted from the picture.
- An upload can still be repeated if the process fails after Linear accepts bytes but before the
  pending URL is persisted. Once the URL is durable, retries reuse it.
- Existing comments, including the ENG-12 comment that motivated this decision, are not backfilled.
