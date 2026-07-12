import {
  runDecisionCouncil,
  type RunDecisionCouncilOptions,
} from "../../decision-council/runner.js";
import type {
  DecisionCouncilInput,
  DecisionCouncilRunState,
} from "../../decision-council/types.js";
import { DEFAULT_ROUTING_POLICY, RouteTaskKind } from "../../decision-council/modelRouter.js";
import type { SourceToProjectThresholds } from "../../config.js";
import type { OpportunityCouncilReview } from "../../generated/baml_client/index.js";
import type { OpportunityAcceptance } from "./harnesses.js";

export type CouncilDeliberationPersona = {
  id: string;
  name: string;
  archetype?: string;
};

export type CouncilDeliberationResult =
  | {
      status: "completed";
      personas: CouncilDeliberationPersona[];
      personaSelectionRationale: string;
      recommendation: string;
      rationale: string[];
      strongestObjections: string[];
      confidence: number;
      convergence: number;
      nextExperiment: string;
      finalReportMarkdown: string;
      model: string;
    }
  | {
      status: "failed";
      error: string;
    };

export type CouncilDeliberationRunner = (
  input: DecisionCouncilInput,
  options?: { maxRounds?: number },
) => Promise<CouncilDeliberationResult>;

/**
 * Builds the DecisionCouncilInput fed to the real persona council from the deterministic
 * council-review gate's own inputs/outputs, so personas debate the same evidence the gate
 * already scored rather than re-deriving opportunities from scratch.
 */
export function buildCouncilDeliberationInput(args: {
  objective?: string;
  review: OpportunityCouncilReview;
  acceptances: OpportunityAcceptance[];
  thresholds: SourceToProjectThresholds;
}): DecisionCouncilInput {
  const { review, acceptances, thresholds } = args;
  const accepted = acceptances.filter((acceptance) => acceptance.accepted);
  const rejected = acceptances.filter((acceptance) => !acceptance.accepted);

  const prompt =
    "A deterministic gate just ranked source-to-project opportunities against fixed acceptance " +
    "thresholds. Critique whether the gate's accept/reject calls are the right ones to promote " +
    "into an implementation plan, and flag any opportunity that looks miscategorized.";

  const context = [
    args.objective ? `Original objective: ${args.objective}` : undefined,
    `Ranking rationale: ${review.rankingRationale}`,
    `Acceptance thresholds: minApplicability=${thresholds.minApplicability}, ` +
      `minConfidence=${thresholds.minConfidence}, minImpact=${thresholds.minImpact}, ` +
      `minAcceptanceAverage=${thresholds.minAcceptanceAverage}, maxRisk=${thresholds.maxRisk}`,
    accepted.length > 0
      ? `Accepted opportunities (${accepted.length}):\n${accepted
          .map(
            (a) =>
              `- ${a.title}: ${a.reason} (acceptance average ${a.acceptanceAverage.toFixed(2)})`,
          )
          .join("\n")}`
      : "No opportunities were accepted by the deterministic gate.",
    rejected.length > 0
      ? `Rejected opportunities (${rejected.length}):\n${rejected
          .map(
            (a) =>
              `- ${a.title}: ${a.reason} (acceptance average ${a.acceptanceAverage.toFixed(2)})`,
          )
          .join("\n")}`
      : undefined,
  ].filter((line): line is string => Boolean(line));

  const constraints = [
    "Focus on whether the accept/reject decisions are directionally correct; do not propose new " +
      "opportunities that are not already listed above.",
  ];

  return { prompt, context, constraints };
}

/**
 * Runs the real persona-driven decision council on a council-review gate's opportunities and
 * shapes the result for macro-workflow dashboard display. Never throws: deliberation failures are
 * returned as a {status: "failed"} result so the deterministic gate remains authoritative even
 * when the (real, agent-backed) deliberation call fails or times out.
 */
export async function runCouncilDeliberation(
  input: DecisionCouncilInput,
  options: { maxRounds?: number } = {},
): Promise<CouncilDeliberationResult> {
  let runState: DecisionCouncilRunState | undefined;
  const runOptions: RunDecisionCouncilOptions = {
    maxRounds: options.maxRounds ?? 1,
    deps: { writeArtifacts: false },
    onRunState: (state) => {
      runState = state;
    },
  };

  try {
    const report = await runDecisionCouncil(input, runOptions);
    const selection = runState?.rounds.at(-1)?.personaSelection;
    const personaById = new Map((runState?.personas ?? []).map((persona) => [persona.id, persona]));
    const personas: CouncilDeliberationPersona[] = (selection?.personaIds ?? []).flatMap((id) => {
      const persona = personaById.get(id);
      return persona ? [{ id: persona.id, name: persona.name, archetype: persona.archetype }] : [];
    });

    return {
      status: "completed",
      personas,
      personaSelectionRationale: selection?.rationale ?? "",
      recommendation: report.recommendation,
      rationale: report.rationale,
      strongestObjections: report.strongestObjections,
      confidence: report.confidence,
      convergence: report.convergence,
      nextExperiment: report.nextExperiment,
      finalReportMarkdown: report.finalReportMarkdown,
      model: DEFAULT_ROUTING_POLICY[RouteTaskKind.PERSONA].model,
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
