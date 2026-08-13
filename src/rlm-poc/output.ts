import { buildLangfuseTraceUrl } from "../mastermind/telemetry.js";
import type { TrellageWorktreeDisposition } from "./trellage/worktrees.js";

export function buildRlmResumeReceipt(conversationId: string, traceId: string): string {
  const script = "scripts/rlm-poc.ts";
  const traceUrl = buildLangfuseTraceUrl(traceId);
  const trace = traceUrl ? traceUrl : `${traceId} (set LANGFUSE_PROJECT_ID to print a direct URL)`;
  return [
    "",
    `Conversation ID: ${conversationId}`,
    "Resume conversation:",
    `nub ${script} --resume ${shellQuote(conversationId)} --prompt '<follow-up>'`,
    `Langfuse trace: ${trace}`,
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Reports what happened to each worktree `invoke_trellage` provisioned.
 *
 * Retained worktrees are the run's only durable side effect outside the user's checkout, and they
 * live under Herdr's own path convention rather than anywhere the user would think to look, so the
 * run has to say where they are.
 */
export function buildTrellageWorktreeReceipt(
  dispositions: readonly TrellageWorktreeDisposition[],
): string {
  if (dispositions.length === 0) return "";
  const lines = ["", "Trellage worktrees:"];
  for (const disposition of dispositions) {
    const { worktree } = disposition;
    if (disposition.removed) {
      lines.push(`- reclaimed (${disposition.summary}): ${worktree.worktreePath}`);
      continue;
    }
    lines.push(
      `- retained (${disposition.summary}): ${worktree.worktreePath}`,
      `    branch ${worktree.branchName} · workspace ${worktree.workspaceId}`,
      ...(disposition.removalError ? [`    removal failed: ${disposition.removalError}`] : []),
    );
  }
  lines.push("");
  return lines.join("\n");
}
