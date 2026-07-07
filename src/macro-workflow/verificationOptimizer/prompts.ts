import type { ProjectCatalogEntry } from "../../config.js";
import type { VerificationAudit, VerificationOpportunity, VerificationRecommendationReview } from "../../generated/baml_client/index.js";

export function buildVerificationAuditPrompt(project: ProjectCatalogEntry): string {
  return [
    "Audit the target project's current verification surface.",
    "Inspect only the configured target project. Do not use external or deep research in v1.",
    "Focus on tests, lint/typecheck/format configuration, scripts, CI checks, and documentation for verification commands.",
    "Explicitly check for missing fast feedback-loop practices: lint scripts/config, formatter scripts/config, git commit hooks such as Husky or lefthook, lint-staged configuration, coverage scripts, 100% coverage thresholds, and CI.",
    "Treat absence of these common feedback-loop checks as evidence-backed verification gaps when repository scans prove they are missing.",
    "Do not fix product bugs or recommend broad rewrites just to satisfy a formatter.",
    "Return a concise evidence-grounded transcript with file references and current validation commands.",
    "",
    `Project JSON:\n${JSON.stringify(project)}`,
  ].join("\n");
}

export function buildVerificationImplementationPrompt(args: {
  project: ProjectCatalogEntry;
  audit: VerificationAudit;
  opportunity: VerificationOpportunity;
  review: VerificationRecommendationReview;
}): string {
  return [
    "Implement the selected verification-only improvement in this isolated worktree.",
    "",
    "Scope rules:",
    "- Change only verification assets: tests, lint/typecheck/format config, scripts, CI checks, or docs for verification commands.",
    "- Do not fix product bugs as part of this change.",
    "- Do not rewrite the repository broadly to satisfy a new formatter.",
    "- Keep the PR limited to this single selected recommendation.",
    "",
    `Project: ${args.project.displayName} (${args.project.id})`,
    `Selected opportunity:\n${JSON.stringify(args.opportunity)}`,
    `Strict review:\n${JSON.stringify(args.review)}`,
    `Audit:\n${JSON.stringify(args.audit)}`,
  ].join("\n");
}

export function buildVerificationImplementationReviewPrompt(args: {
  opportunity: VerificationOpportunity;
  proofCommands: string[];
}): string {
  return [
    "Review the implemented verification-only improvement.",
    "Reject if the change fixed product behavior, broadened scope, or skipped required proof commands.",
    "",
    `Selected opportunity:\n${JSON.stringify(args.opportunity)}`,
    `Proof commands:\n${JSON.stringify(args.proofCommands)}`,
  ].join("\n");
}
