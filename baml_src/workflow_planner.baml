class WorkflowNode {
  id string @description("Stable node identifier used by dependency edges, execution state, and replans.")
  kind string @description("Semantic role for the node, such as research, deliberation, planning, implementation, verification, report, or visualization. Use report for markdown/report publication nodes; reserve visualization for actual visual design or interactive visual artifacts.")
  harness string @description("Harness or executor that should run the node, such as research, decision-council, copilot-sdk, verifier, or reporter.")
  title string @description("Short human-readable title for the node shown in plans, reports, and runtime artifacts.")
  description string? @description("Optional human-readable description of what this node contributes to the workflow.")
  model string? @description("Optional intended primary model for this node, such as claude-opus-4.8, gpt-5.5, gpt-5-mini, gpt-5.3-codex, claude-sonnet-5, or deterministic.")
  modelRationale string? @description("Optional short rationale for the intended primary model.")
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
  client CopilotProxyGpt55
  prompt #"
    {{ _.role("system") }}
    You are a constrained macro-workflow planner for Weavekit.
    Produce a DAG for the requested template. Keep write nodes single-writer and avoid human approval gates.
    Ensure a verification node exists after implementation work and keep the graph acyclic.
    Use kind "report" for markdown/report publication nodes. Use kind "visualization" only for actual visual design or interactive visual artifact nodes.
    Populate node model metadata from this routing policy:
    - research nodes and non-mutating implementation-review nodes: model "gpt-5.5".
    - planning nodes: model "claude-opus-4.8", unless the planning node is the single writer implementation step.
    - implementation nodes that mutate files: model "gpt-5.3-codex".
    - decision-council/report synthesis nodes: model "claude-opus-4.8" when they invoke an LLM; reporter and verifier harness nodes are "deterministic".
    - verifier and reporter harness nodes: model "deterministic".
    Keep modelRationale short and aligned with the selected model.

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
  client CopilotProxyClaudeOpus48
  prompt #"
    {{ _.role("system") }}
    You are a bounded replanner for a macro-workflow DAG.
    Return a patch that only replaces remaining nodes. Do not alter completed nodes.
    If the reason says Copilot SDK requested user input or ask_user, do not answer the
    question inside the failed node. Add explicit read-only decision-council or research
    nodes that try to resolve the question from existing project/source context, then add
    a retry node for the failed step that depends on those resolver nodes. If the question
    requires a human and Telegram notification has already been sent, preserve that fact in
    the node descriptions and fail closed rather than inventing a hidden answer.

    {{ _.role("user") }}
    Reason: {{ reason }}
    Max remaining replans: {{ maxRemainingReplans }}
    Completed node ids: {{ completedNodeIds }}
    Current plan: {{ currentPlan }}

    {{ ctx.output_format }}
  "#
}
