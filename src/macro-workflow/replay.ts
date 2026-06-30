import type {
  RuntimeWorkflowNode,
  WorkflowReplayEvent,
  WorkflowReplayNodeView,
  WorkflowReplayViewState,
} from "./types.js";

export type { WorkflowReplayEvent, WorkflowReplayNodeView, WorkflowReplayViewState } from "./types.js";
export { WorkflowReplayEventKind } from "./types.js";

export function replayViewStateFromEvents(events: WorkflowReplayEvent[]): WorkflowReplayViewState {
  return events.reduce<WorkflowReplayViewState>(
    (view, event) => {
      if (event.kind === "planning-started") {
        ensurePlanningNode(view, event.nodeId ?? "workflow-planning");
        view.activePhase = "planning";
        return view;
      }

      if (event.kind === "planning-complete") {
        view.activePhase = "running";
        return view;
      }

      if (event.kind === "node-added" && event.node) {
        upsertNode(view, event.node, event.status ?? "pending");
      }

      if (event.kind === "node-status-changed" && event.nodeId) {
        const node = view.nodes.find((candidate) => candidate.id === event.nodeId);
        if (node) {
          node.status = event.status ?? node.status;
        }
      }

      if (event.kind === "node-removed" && event.nodeId) {
        const node = view.nodes.find((candidate) => candidate.id === event.nodeId);
        if (node) {
          node.exists = false;
        }
      }

      if (event.kind === "replan-applied" && event.patch) {
        for (const id of event.patch.replaceRemainingNodeIds) {
          const node = view.nodes.find((candidate) => candidate.id === id);
          if (node) {
            node.exists = false;
          }
        }
        for (const node of event.patch.newNodes) {
          upsertNode(view, node, "pending");
        }
      }

      if (event.kind === "run-completed") {
        view.activePhase = "completed";
      }

      return view;
    },
    { activePhase: "planning", nodes: [], edges: [] },
  );
}

function ensurePlanningNode(view: WorkflowReplayViewState, id: string) {
  if (view.nodes.some((node) => node.id === id)) {
    return;
  }

  view.nodes.unshift({
    id,
    kind: "planning",
    title: "DAG Planning",
    status: "running",
    harness: "planning",
    exists: true,
  });
}

function upsertNode(view: WorkflowReplayViewState, node: RuntimeWorkflowNode, status: WorkflowReplayNodeView["status"]) {
  const existing = view.nodes.find((candidate) => candidate.id === node.id);
  if (existing) {
    existing.kind = node.kind;
    existing.title = node.title;
    existing.status = status;
    existing.harness = node.harness;
    existing.exists = true;
    return;
  }

  view.nodes.push({
    id: node.id,
    kind: node.kind,
    title: node.title,
    status,
    harness: node.harness,
    exists: true,
  });
}
