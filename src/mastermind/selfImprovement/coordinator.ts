import type { WeavekitConfig } from "../../config.js";
import { toBamlTicket } from "../actions/reviewTicket.js";
import type { MastermindDecisionProvider } from "../decision/bamlAdapters.js";
import { MastermindState } from "../domain/events.js";
import type { LinearGateway } from "../linear/client.js";
import type { ExecutionAttempt, MastermindStore, MastermindWorkItem } from "../store/store.js";
import { withMastermindSpan } from "../telemetry.js";
import type { SubmindTraceSource } from "./traceSource.js";
import { collectMastermindMissionStatements } from "./missionStatements.js";

const SEVERITY_RANK: Record<"BLOCKING" | "IMPORTANT" | "SUGGESTION", number> = {
  BLOCKING: 3,
  IMPORTANT: 2,
  SUGGESTION: 1,
};

/**
 * Terminal states after which it's worth mining the Submind trace: both the "everything worked"
 * and the "human had to step in" ends of the outcome spectrum can carry useful process signal.
 */
const ANALYZABLE_STATES = new Set<MastermindState>([
  MastermindState.COMPLETED,
  MastermindState.AWAITING_ACCEPTANCE,
  MastermindState.CHANGES_REQUESTED,
  MastermindState.NEEDS_HUMAN,
  MastermindState.FAILED,
]);

/**
 * Best-effort secondary loop: after an RLM/Submind-delegated work item reaches a terminal state,
 * read the run record persisted with its result, ask `AnalyzeSubmindTrace` to compare the actual
 * executed path against the ticket and Mastermind/Submind mission statements, and file a Linear
 * triage ticket per concrete finding at/above the configured minimum severity.
 *
 * This coordinator must never throw back into the main Mastermind execution/decision loop: a
 * failure here (BAML error, Linear rejection) only means "no self-improvement ticket this time,"
 * never a reason to fail the underlying work item. Every public entry point therefore swallows and
 * logs errors internally.
 */
export class SelfImprovementCoordinator {
  constructor(
    private readonly config: WeavekitConfig,
    private readonly store: Pick<MastermindStore, "getLatestTicketSnapshot">,
    private readonly linear: LinearGateway,
    private readonly traceSource: SubmindTraceSource,
    private readonly decisions: Pick<MastermindDecisionProvider, "analyzeSubmindTrace">,
  ) {}

  async process(work: MastermindWorkItem, attempt: ExecutionAttempt): Promise<void> {
    const settings = this.config.mastermind.selfImprovement;
    if (!settings?.enabled) return;
    if (!ANALYZABLE_STATES.has(work.state)) return;
    const runRecord = attempt.result?.runRecord;
    if (!runRecord) return;

    try {
      await withMastermindSpan(
        "mastermind.self_improvement.analyze",
        {
          "langfuse.observation.type": "chain",
          "weavekit.mastermind.work_id": work.id,
          "weavekit.mastermind.self_improvement.run_id": runRecord.runId,
        },
        async () => this.analyzeAndFile(work, attempt, settings),
      );
    } catch (error) {
      // Best-effort: log only. The main Mastermind loop must never fail because self-improvement
      // analysis couldn't run.
      console.error(
        `[mastermind] self-improvement analysis failed for work ${work.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async analyzeAndFile(
    work: MastermindWorkItem,
    attempt: ExecutionAttempt,
    settings: NonNullable<WeavekitConfig["mastermind"]["selfImprovement"]>,
  ): Promise<void> {
    if (!this.decisions.analyzeSubmindTrace) return;
    const traceSummary = await this.traceSource.fetchSubmindTraceSummary(attempt);
    if (!traceSummary) return;

    const ticket = await this.store.getLatestTicketSnapshot(work.id);
    if (!ticket) return;

    const { RLM_SUBMIND_SYSTEM_PROMPT } = await import("../../rlm-poc/submindPrompt.js");
    const missionStatements = collectMastermindMissionStatements(RLM_SUBMIND_SYSTEM_PROMPT);

    const report = await this.decisions.analyzeSubmindTrace(
      toBamlTicket(ticket),
      missionStatements,
      traceSummary,
    );

    const minRank = SEVERITY_RANK[settings.minSeverity];
    const findings = report.findings.filter(
      (finding) => SEVERITY_RANK[finding.severity] >= minRank,
    );
    if (findings.length === 0) return;

    if (!this.linear.createIssue || !this.linear.findIssueCommentByMarker) return;
    if (!this.linear.createIssueComment) return;

    // Idempotency: self-improvement tickets are filed in a separate team/project, so there is no
    // single Linear issue to search for a per-finding marker comment on. Instead, post one marker
    // comment on the *originating* ticket the instant filing starts for this attempt, and skip the
    // whole attempt if that marker is already present - trading fine-grained per-finding replay
    // safety for a simple, durable "have we already run this for this attempt" check.
    const attemptMarker = `<!-- weavekit-mastermind-self-improvement:${attempt.id} -->`;
    const alreadyProcessed = await this.linear.findIssueCommentByMarker(
      work.issueId,
      attemptMarker,
    );
    if (alreadyProcessed) return;
    await this.linear.createIssueComment(
      work.issueId,
      `${attemptMarker}\nMastermind self-improvement analysis filed ${findings.length} triage ticket(s) against attempt ${attempt.attemptNumber}'s Submind trace.`,
    );

    for (const finding of findings) {
      await this.linear.createIssue({
        teamId: settings.targetTeamId,
        title: `[Mastermind self-improvement] ${finding.title}`,
        description: [
          `Severity: **${finding.severity}** · Category: ${finding.category}`,
          "",
          `Source work item: ${work.id} (ticket ${ticket.identifier}, attempt ${attempt.attemptNumber})`,
          `Submind trace: ${traceSummary.url ?? traceSummary.traceId}`,
          "",
          finding.suggestedTicketBody,
        ].join("\n"),
        ...(settings.targetProjectId ? { projectId: settings.targetProjectId } : {}),
        ...(settings.ticketLabelId ? { labelIds: [settings.ticketLabelId] } : {}),
      });
    }
  }
}
