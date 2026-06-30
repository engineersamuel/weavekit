class WorkflowNode {
  id string @description("Stable node identifier used by dependency edges, execution state, and replans.")
  kind string @description("Semantic role for the node, such as research, deliberation, implementation, verification, or visualization.")
  harness string @description("Harness or executor that should run the node, such as research, decision-council, copilot-sdk, verifier, or reporter.")
  title string @description("Short human-readable title for the node shown in plans, reports, and runtime artifacts.")
  prompt string @description("Instruction or task prompt passed to the selected harness.")
  dependsOn string[] @description("IDs of prerequisite nodes that must complete before this node can run.")
  gates string[] @description("Automated gate kinds that this node should enforce or require, such as output-contract, review-accepted, or verification.")
  writeMode string @description("Execution mode for the node: read-only for analysis-only steps or single-writer for the one implementation step that may mutate files.")
  replanPolicy string @description("Policy controlling whether this node can trigger bounded replanning after a failure, such as never or on-verification-failure.")
}

class WorkflowPlan {
  id string @description("Stable identifier for the generated workflow plan.")
  objective string @description("High-level objective supplied by the caller for the workflow.")
  templateId string @description("Template identifier used to constrain the plan, such as implementation-review.")
  maxReplans int @description("Maximum number of bounded replans permitted while executing the plan.")
  nodes WorkflowNode[] @description("Ordered DAG nodes that make up the workflow plan.")
}

class WorkflowReplanPatch {
  reason string @description("Human-readable explanation for why the remaining portion of the plan is being replaced.")
  replaceRemainingNodeIds string[] @description("IDs of the remaining nodes that should be replaced by the patch.")
  newNodes WorkflowNode[] @description("Replacement nodes that should be inserted for the remaining portion of the workflow.")
}

function PlanWorkflow(objective: string, prompt: string, templateId: string) -> WorkflowPlan {
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    You are a constrained macro-workflow planner for Weavekit.
    Produce a DAG for the requested template. Keep write nodes single-writer and avoid human approval gates.
    Ensure a verification node exists after implementation work and keep the graph acyclic.

    Available templates: implementation-review

    {{ _.role("user") }}
    Objective: {{ objective }}
    Prompt: {{ prompt }}
    Requested template: {{ templateId }}

    {{ ctx.output_format }}
  "#
}

function GenerateReplanPatch(
  reason: string,
  maxRemainingReplans: int,
  completedNodeIds: string[],
  currentPlan: WorkflowPlan
) -> WorkflowReplanPatch {
  client DefaultClient
  prompt #"
    {{ _.role("system") }}
    You are a bounded replanner for a macro-workflow DAG.
    Return a patch that only replaces remaining nodes. Do not alter completed nodes.

    Reason: {{ reason }}
    Max remaining replans: {{ maxRemainingReplans }}
    Completed node ids: {{ completedNodeIds }}
    Current plan: {{ currentPlan }}

    {{ ctx.output_format }}
  "#
}
