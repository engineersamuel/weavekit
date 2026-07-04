import { WorkflowGateKind, WorkflowNodeKind, type WorkflowPlanTemplateId } from "../types.js";
import type { WorkflowGrammar } from "../grammar.js";

export function renderTemplateOptimizerConstraints(args: {
  grammar: WorkflowGrammar;
  templateId: WorkflowPlanTemplateId;
  mode: "advisory" | "autonomous-pr";
}): string {
  const transitions = [...args.grammar.allowedTransitions.entries()]
    .sort(([fromA], [fromB]) => fromA.localeCompare(fromB))
    .map(([from, tos]) => `${from} -> ${[...tos].sort().join(", ")}`)
    .join("\n");
  const modeConstraints =
    args.mode === "advisory"
      ? [
          "advisory mode must not include implementation nodes",
          "advisory mode must not modify the target project",
          "plans must pass final recommendation review before report when plans exist",
        ]
      : [
          "autonomous-pr mode requires explicit enablement",
          "every included Opportunity must have confidence >= 0.95",
          "worktree preparation must happen before writes",
          "verification gates must run after writes",
          "no merge or self-approval behavior is allowed",
        ];
  return [
    `templateId: ${args.templateId}`,
    `mode: ${args.mode}`,
    `allowedNodeKinds: ${[...args.grammar.allowedNodeKinds].sort().join(", ")}`,
    `allowedHarnesses: ${[...args.grammar.allowedHarnesses].sort().join(", ")}`,
    `allowedGates: ${Object.values(WorkflowGateKind).sort().join(", ")}`,
    "allowedTransitions:",
    transitions,
    `requiredImplementationDownstreamGate: ${args.grammar.requiredImplementationDownstreamGate}`,
    `maxReplans: ${args.grammar.maxReplans}`,
    `implementationNodeKind: ${WorkflowNodeKind.IMPLEMENTATION}`,
    "modeConstraints:",
    ...modeConstraints.map((constraint) => `- ${constraint}`),
  ].join("\n");
}
