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
        const planningNode = view.nodes.find((node) => node.id === (event.nodeId ?? "workflow-planning"));
        if (planningNode) {
          planningNode.status = "passed";
        }
        view.activePhase = "running";
        return view;
      }

      if (event.kind === "node-added" && event.node) {
        upsertNode(view, event.node, event.status ?? "pending");
        if (event.node.dependsOn.length > 0) {
          for (const dependencyId of event.node.dependsOn) {
            upsertEdge(view, dependencyId, event.node.id);
          }
        } else if (view.nodes.some((node) => node.id === "workflow-planning")) {
          upsertEdge(view, "workflow-planning", event.node.id);
        }
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
        view.edges = view.edges.filter((edge) => edge.source !== event.nodeId && edge.target !== event.nodeId);
      }

      if (event.kind === "edge-added" && event.sourceNodeId && event.targetNodeId) {
        upsertEdge(view, event.sourceNodeId, event.targetNodeId);
      }

      if (event.kind === "edge-removed" && event.sourceNodeId && event.targetNodeId) {
        view.edges = view.edges.filter((edge) => edge.source !== event.sourceNodeId || edge.target !== event.targetNodeId);
      }

      if (event.kind === "replan-applied" && event.patch) {
        for (const id of event.patch.replaceRemainingNodeIds) {
          const node = view.nodes.find((candidate) => candidate.id === id);
          if (node) {
            node.exists = false;
          }
        }
        const removedIds = new Set(event.patch.replaceRemainingNodeIds);
        view.edges = view.edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target));
        for (const node of event.patch.newNodes) {
          upsertNode(view, node, "pending");
          for (const dependencyId of node.dependsOn) {
            upsertEdge(view, dependencyId, node.id);
          }
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

function upsertEdge(view: WorkflowReplayViewState, source: string, target: string) {
  const id = `${source}-${target}`;
  if (view.edges.some((edge) => edge.id === id)) {
    return;
  }
  view.edges.push({ id, source, target });
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
