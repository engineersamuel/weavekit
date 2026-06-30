import React, { useEffect, useMemo, useState, memo } from "react";
import { createRoot } from "react-dom/client";
import { Background, Controls, MiniMap, ReactFlow, Handle, Position } from "@xyflow/react";

const DEFAULT_STATUS = "pending";
const STATUS_COLORS = {
  passed: "#14b8a6",
  failed: "#f43f5e",
  running: "#fb923c",
  pending: "#475569",
};
const PLANNING_NODE_ID = "workflow-planning";
const REPLAY_EVENT_LABELS = {
  "planning-started": "Planning started",
  "planning-complete": "Planning complete",
  "node-added": "Node added",
  "node-status-changed": "Status changed",
  "node-removed": "Node removed",
  "edge-added": "Edge added",
  "edge-removed": "Edge removed",
  "replan-applied": "Replan applied",
  "run-completed": "Run completed",
};

function statusColor(status) {
  return STATUS_COLORS[status] ?? STATUS_COLORS.pending;
}

// Custom React Flow Node component
const WorkflowNode = memo(({ data }) => {
  const isDecisionCouncil = data.harness === "decision-council";
  const nodeStatus = data.status ?? DEFAULT_STATUS;
  
  // Personas representing the Decision Council
  const personas = isDecisionCouncil ? [
    { name: "Socratic", color: "#60a5fa" },
    { name: "Deep Module DRY", color: "#34d399" },
    { name: "Pragmatic", color: "#fb7185" },
    { name: "Skeptic", color: "#a78bfa" },
    { name: "Sun Tzu", color: "#f59e0b" },
    { name: "McKinsey", color: "#10b981" }
  ] : [];

  return (
    <div
      key={data.transitionKey}
      className={`custom-node node-status-${nodeStatus} node-transition-${data.transition ?? "stable"}`}
      style={{ borderColor: statusColor(nodeStatus) }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "#475569" }} />
      <div className="custom-node-header">
        <span className="node-kind-badge">{data.subtitle}</span>
        <span className="node-harness">{nodeStatus}</span>
      </div>
      <div className="custom-node-title">{data.label}</div>
      <div className="node-harness-line">{data.harness}</div>
      
      {isDecisionCouncil && (
        <div className="persona-set-container">
          <div className="persona-set-title">Council Personas</div>
          <div className="persona-grid">
            {personas.map((p) => (
              <span key={p.name} className="persona-badge" style={{ borderColor: p.color, color: p.color }}>
                {p.name}
              </span>
            ))}
          </div>
        </div>
      )}
      <Handle type="source" position={Position.Right} style={{ background: "#475569" }} />
    </div>
  );
});

const nodeTypes = {
  workflowNode: WorkflowNode,
};

function resolveNodeStatus(node, state) {
  const result = state.nodeResults?.find((entry) => entry.nodeId === node.id);
  if (result?.status === "passed") {
    return "passed";
  }
  if (result?.status === "failed") {
    return "failed";
  }
  if (state.activeNodeId === node.id) {
    return "running";
  }
  return DEFAULT_STATUS;
}

function buildGraph(state) {
  const plan = state.currentPlan ?? state.plan ?? { nodes: [] };
  const visibleNodes = plan.nodes ?? [];
  const rankLookup = new Map();

  function rank(node) {
    if (rankLookup.has(node.id)) {
      return rankLookup.get(node.id);
    }

    if (node.dependsOn.length === 0) {
      rankLookup.set(node.id, 0);
      return 0;
    }

    const dependencyRank = Math.max(...node.dependsOn.map((dependencyId) => {
      const dependency = visibleNodes.find((candidate) => candidate.id === dependencyId);
      return dependency ? rank(dependency) + 1 : 0;
    }));

    rankLookup.set(node.id, dependencyRank);
    return dependencyRank;
  }

  const layers = new Map();
  const nodes = [];
  const edges = [];

  visibleNodes.forEach((node) => {
    const nodeRank = rank(node);
    const layer = layers.get(nodeRank) ?? [];
    layer.push(node);
    layers.set(nodeRank, layer);
  });

  layers.forEach((layerNodes, layerIndex) => {
    layerNodes.forEach((node, nodeIndex) => {
      const status = resolveNodeStatus(node, state);
      nodes.push({
        id: node.id,
        type: "workflowNode",
        className: `node-status-${status}`,
        position: {
          x: layerIndex * 340,
          y: nodeIndex * 160,
        },
        data: {
          label: node.title,
          subtitle: node.kind,
          status,
          output: state.nodeResults?.find((entry) => entry.nodeId === node.id)?.output ?? "",
          error: state.nodeResults?.find((entry) => entry.nodeId === node.id)?.error ?? "",
          harness: node.harness,
          sourceNode: node,
          transitionKey: `live-${node.id}-${status}`,
          transition: "stable",
        },
      });
    });
  });

  visibleNodes.forEach((node) => {
    node.dependsOn.forEach((dependencyId) => {
      const status = resolveNodeStatus(node, state);
      edges.push({
        id: `${dependencyId}-${node.id}`,
        source: dependencyId,
        target: node.id,
        animated: status === "running",
        className: `edge-status-${status}`,
        style: { stroke: statusColor(status) },
      });
    });
  });

  return { nodes, edges };
}

function buildReplayGraph(history, state, replayIndex) {
  const replayView = buildReplayView(history);
  const visibleReplayNodes = replayView.nodes.filter((node) => node.exists);
  const visibleNodeIds = new Set(visibleReplayNodes.map((node) => node.id));
  const rankLookup = new Map();
  const layers = new Map();

  function rank(node) {
    if (rankLookup.has(node.id)) {
      return rankLookup.get(node.id);
    }

    if (node.id === PLANNING_NODE_ID) {
      rankLookup.set(node.id, 0);
      return 0;
    }

    const dependencies = node.dependsOn?.filter((dependencyId) => visibleNodeIds.has(dependencyId)) ?? [];
    if (dependencies.length === 0) {
      const nodeRank = visibleNodeIds.has(PLANNING_NODE_ID) ? 1 : 0;
      rankLookup.set(node.id, nodeRank);
      return nodeRank;
    }

    const dependencyRank = Math.max(...dependencies.map((dependencyId) => {
      const dependency = visibleReplayNodes.find((candidate) => candidate.id === dependencyId);
      return dependency ? rank(dependency) + 1 : 0;
    }));

    rankLookup.set(node.id, dependencyRank);
    return dependencyRank;
  }

  visibleReplayNodes.forEach((node) => {
    const nodeRank = rank(node);
    const layer = layers.get(nodeRank) ?? [];
    layer.push(node);
    layers.set(nodeRank, layer);
  });

  const nodes = [];
  Array.from(layers.entries())
    .sort(([leftRank], [rightRank]) => leftRank - rightRank)
    .forEach(([layerIndex, layerNodes]) => {
      layerNodes.forEach((node, nodeIndex) => {
        nodes.push({
          id: node.id,
          type: "workflowNode",
          className: `node-status-${node.status}`,
          position: {
            x: layerIndex * 340,
            y: nodeIndex * 160,
          },
          data: {
            label: node.title,
            subtitle: node.kind,
            status: node.status,
            output: state?.nodeResults?.find((entry) => entry.nodeId === node.id)?.output ?? "",
            error: state?.nodeResults?.find((entry) => entry.nodeId === node.id)?.error ?? "",
            harness: node.harness,
            sourceNode: node.sourceNode,
            transitionKey: `${replayIndex}-${node.id}-${node.status}`,
            transition: "entering",
          },
        });
      });
    });

  const edges = replayView.edges
    .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
    .map((edge) => {
      const target = visibleReplayNodes.find((node) => node.id === edge.target);
      const status = target?.status ?? DEFAULT_STATUS;
      return {
        ...edge,
        animated: status === "running",
        className: `edge-status-${status}`,
        style: { stroke: edge.kind === "planning" ? "#38bdf8" : statusColor(status) },
      };
    });

  return { nodes, edges, replayView };
}

function buildReplayView(events) {
  const nodes = new Map();
  const nodeOrder = [];
  const edges = new Map();
  let activePhase = "planning";

  function upsertNode(node, status = DEFAULT_STATUS) {
    if (!nodes.has(node.id)) {
      nodeOrder.push(node.id);
    }
    nodes.set(node.id, {
      id: node.id,
      kind: node.kind ?? "workflow",
      title: node.title ?? node.id,
      status,
      harness: node.harness ?? "workflow",
      dependsOn: node.dependsOn ?? [],
      exists: true,
      sourceNode: node,
    });
  }

  function ensurePlanningNode(status = "running") {
    if (nodes.has(PLANNING_NODE_ID)) {
      const existing = nodes.get(PLANNING_NODE_ID);
      nodes.set(PLANNING_NODE_ID, { ...existing, status, exists: true });
      return;
    }
    nodeOrder.unshift(PLANNING_NODE_ID);
    nodes.set(PLANNING_NODE_ID, {
      id: PLANNING_NODE_ID,
      kind: "planning",
      title: "DAG Planning",
      status,
      harness: "planning",
      dependsOn: [],
      exists: true,
      sourceNode: {
        id: PLANNING_NODE_ID,
        kind: "planning",
        title: "DAG Planning",
        harness: "planning",
        dependsOn: [],
      },
    });
  }

  function addEdge(source, target, kind = "dependency") {
    if (!source || !target) {
      return;
    }
    const id = `${source}-${target}`;
    edges.set(id, { id, source, target, kind });
  }

  for (const event of events) {
    if (event.phase) {
      activePhase = event.phase;
    }

    if (event.kind === "planning-started") {
      ensurePlanningNode("running");
      activePhase = "planning";
      continue;
    }

    if (event.kind === "planning-complete") {
      ensurePlanningNode("passed");
      activePhase = "running";
      continue;
    }

    if (event.kind === "node-added" && event.node) {
      if (nodes.has(PLANNING_NODE_ID)) {
        ensurePlanningNode("passed");
      }
      upsertNode(event.node, event.status ?? DEFAULT_STATUS);
      if (event.node.dependsOn?.length) {
        event.node.dependsOn.forEach((dependencyId) => addEdge(dependencyId, event.node.id));
      } else if (nodes.has(PLANNING_NODE_ID)) {
        addEdge(PLANNING_NODE_ID, event.node.id, "planning");
      }
      continue;
    }

    if (event.kind === "node-status-changed" && event.nodeId && nodes.has(event.nodeId)) {
      const node = nodes.get(event.nodeId);
      nodes.set(event.nodeId, { ...node, status: event.status ?? node.status });
      continue;
    }

    if (event.kind === "node-removed" && event.nodeId && nodes.has(event.nodeId)) {
      const node = nodes.get(event.nodeId);
      nodes.set(event.nodeId, { ...node, exists: false });
      continue;
    }

    if (event.kind === "edge-added") {
      const source = event.sourceNodeId ?? event.source ?? event.sourceId ?? event.edge?.source;
      const target = event.targetNodeId ?? event.target ?? event.targetId ?? event.edge?.target;
      addEdge(source, target);
      continue;
    }

    if (event.kind === "edge-removed") {
      const source = event.sourceNodeId ?? event.source ?? event.sourceId;
      const target = event.targetNodeId ?? event.target ?? event.targetId;
      const id = event.edgeId ?? event.edge?.id ?? `${source}-${target}`;
      edges.delete(id);
      continue;
    }

    if (event.kind === "replan-applied" && event.patch) {
      for (const nodeId of event.patch.replaceRemainingNodeIds ?? []) {
        if (nodes.has(nodeId)) {
          const node = nodes.get(nodeId);
          nodes.set(nodeId, { ...node, exists: false });
        }
      }
      for (const node of event.patch.newNodes ?? []) {
        upsertNode(node, DEFAULT_STATUS);
        if (node.dependsOn?.length) {
          node.dependsOn.forEach((dependencyId) => addEdge(dependencyId, node.id));
        }
      }
      continue;
    }

    if (event.kind === "run-completed") {
      activePhase = "completed";
    }
  }

  return {
    activePhase,
    nodes: nodeOrder.map((nodeId) => nodes.get(nodeId)).filter(Boolean),
    edges: Array.from(edges.values()),
  };
}

function eventTitle(event) {
  if (!event) {
    return "event";
  }
  return REPLAY_EVENT_LABELS[event.kind] ?? event.type ?? event.kind ?? "event";
}

function eventDetail(event) {
  if (!event) {
    return "Workflow state updated";
  }
  if (event.node?.title) {
    return event.node.title;
  }
  if (event.nodeId) {
    return event.nodeId;
  }
  if (event.status) {
    return event.status;
  }
  return event.reason ?? event.phase ?? "Workflow state updated";
}

function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [history, setHistory] = useState([]);
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [replayIndex, setReplayIndex] = useState(null);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [autoTrackNewRuns, setAutoTrackNewRuns] = useState(true);
  const [flowInstance, setFlowInstance] = useState(null);

  useEffect(() => {
    let active = true;
    function applyPayload(payload, options = {}) {
      if (!active || !payload) {
        return;
      }
      if (Array.isArray(payload.runs)) {
        setRuns(payload.runs);
      }
      if (payload.activeRunId) {
        setSelectedRunId(payload.activeRunId);
      }
      if (options.onlyRuns) {
        return;
      }
      setSnapshot(payload);
      if (Array.isArray(payload.history)) {
        setHistory(payload.history);
        if (autoTrackNewRuns) {
          setReplayIndex(null);
        }
      }
    }

    fetch("/api/replay")
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => applyPayload(payload))
      .catch(() => undefined);

    fetch("/api/runs")
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => applyPayload(payload, { onlyRuns: true }))
      .catch(() => undefined);

    const source = new EventSource("/events");
    source.addEventListener("state", (event) => {
      const payload = JSON.parse(event.data);
      if (!autoTrackNewRuns) {
        if (Array.isArray(payload.runs)) {
          setRuns(payload.runs);
        }
        return;
      }
      applyPayload(payload);
    });
    source.onerror = () => {
      source.close();
    };
    return () => {
      active = false;
      source.close();
    };
  }, [autoTrackNewRuns]);

  function loadRun(runId) {
    if (!runId) {
      setAutoTrackNewRuns(true);
      setReplayIndex(null);
      void fetch("/api/replay")
        .then((response) => response.ok ? response.json() : null)
        .then((payload) => {
          if (!payload) {
            return;
          }
          setSnapshot(payload);
          setRuns(Array.isArray(payload.runs) ? payload.runs : runs);
          setSelectedRunId(payload.activeRunId ?? "");
          setHistory(Array.isArray(payload.history) ? payload.history : []);
        })
        .catch(() => undefined);
      return;
    }

    setAutoTrackNewRuns(false);
    setReplayIndex(null);
    void fetch(`/api/replay?runId=${encodeURIComponent(runId)}`)
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (!payload) {
          return;
        }
        setSnapshot(payload);
        setRuns(Array.isArray(payload.runs) ? payload.runs : runs);
        setSelectedRunId(payload.activeRunId ?? runId);
        setHistory(Array.isArray(payload.history) ? payload.history : []);
      })
      .catch(() => undefined);
  }

  const hasHistory = history.length > 0;
  const effectiveReplayIndex = Math.min(replayIndex === null ? history.length : replayIndex, history.length);
  const replayEvents = useMemo(
    () => history.slice(0, Math.min(effectiveReplayIndex, history.length)),
    [effectiveReplayIndex, history],
  );
  const graph = useMemo(() => {
    if (hasHistory) {
      return buildReplayGraph(replayEvents, snapshot?.state, effectiveReplayIndex);
    }
    if (!snapshot?.state) {
      return { nodes: [], edges: [] };
    }
    return buildGraph(snapshot.state);
  }, [effectiveReplayIndex, hasHistory, replayEvents, snapshot]);

  useEffect(() => {
    if (!flowInstance || !autoTrackNewRuns || graph.nodes.length === 0) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      void flowInstance.fitView({ padding: 0.2, duration: 220 });
    });
    return () => cancelAnimationFrame(frame);
  }, [autoTrackNewRuns, flowInstance, graph.nodes, graph.edges]);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) {
      return null;
    }
    const graphNode = graph.nodes.find((node) => node.id === selectedNodeId);
    if (graphNode?.data?.sourceNode) {
      return graphNode.data.sourceNode;
    }
    if (!snapshot?.state) {
      return null;
    }
    const plan = snapshot.state.currentPlan ?? snapshot.state.plan ?? { nodes: [] };
    return plan.nodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [graph.nodes, selectedNodeId, snapshot]);

  const selectedResult = useMemo(() => {
    if (!snapshot?.state || !selectedNode) {
      return null;
    }
    return snapshot.state.nodeResults?.find((entry) => entry.nodeId === selectedNode.id) ?? null;
  }, [selectedNode, snapshot]);

  const workflowStatus = snapshot?.state?.status ?? "idle";
  const objective = snapshot?.state?.objective ?? "Waiting for workflow to start";
  const planId = snapshot?.state?.planId ?? "";
  const runName = snapshot?.run?.runName ?? snapshot?.state?.runName ?? "No run selected";
  const activePhase = graph.replayView?.activePhase ?? (workflowStatus === "idle" ? "waiting" : "live");
  const replayEvent = hasHistory ? history[Math.max(0, effectiveReplayIndex - 1)] : null;
  const recentEvents = hasHistory
    ? history.slice(Math.max(0, effectiveReplayIndex - 5), effectiveReplayIndex).reverse()
    : [];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <h1>Workflow Dashboard</h1>
          <div className={`status-pill`} style={{ color: workflowStatus === "passed" ? "#34d399" : workflowStatus === "failed" ? "#fb7185" : workflowStatus === "running" ? "#fb923c" : "#cbd5e1" }}>
            {workflowStatus}
          </div>
        </div>
        <div className="card run-panel">
          <h2>Run</h2>
          <select
            value={autoTrackNewRuns ? "" : selectedRunId}
            onChange={(event) => loadRun(event.target.value)}
          >
            <option value="">Latest run</option>
            {runs.map((run) => (
              <option value={run.runId} key={run.runId}>
                {run.runName} · {run.status}
              </option>
            ))}
          </select>
          <div className="run-name">{runName}</div>
        </div>
        <div className="card">
          <h2>Objective</h2>
          <p>{objective}</p>
          <div className="meta-grid">
            <div><strong>Plan:</strong> {planId}</div>
            <div><strong>Nodes:</strong> {graph.nodes.length}</div>
            <div><strong>Replans:</strong> {snapshot?.state?.replans?.length ?? 0}</div>
            <div><strong>Phase:</strong> {activePhase}</div>
          </div>
        </div>
        <div className="card replay-panel">
          <div className="replay-panel-header">
            <h2>Replay</h2>
            <button
              type="button"
              onClick={() => {
                setAutoTrackNewRuns(true);
                setReplayIndex(null);
              }}
              disabled={!hasHistory || (autoTrackNewRuns && replayIndex === null)}
            >
              Live
            </button>
          </div>
          <label className="tracking-toggle">
            <input
              type="checkbox"
              checked={autoTrackNewRuns}
              onChange={(event) => {
                const checked = event.target.checked;
                setAutoTrackNewRuns(checked);
                setReplayIndex(checked ? null : effectiveReplayIndex);
              }}
            />
            <span>Track new runs</span>
          </label>
          <input
            type="range"
            min="0"
            max={history.length}
            value={effectiveReplayIndex}
            disabled={!hasHistory}
            onChange={(event) => {
              setAutoTrackNewRuns(false);
              setReplayIndex(Number(event.target.value));
            }}
          />
          <div className="replay-meta">
            <span>{hasHistory ? `${effectiveReplayIndex} / ${history.length}` : "No replay history"}</span>
            <span>{replayEvent?.ts ?? "live state"}</span>
          </div>
          <div className="replay-current-event">{hasHistory ? eventTitle(replayEvent) : "Streaming live dashboard state"}</div>
        </div>
        <div className="card detail-panel">
          <h2>Selection</h2>
          {selectedNode ? (
            <>
              <div className="meta-grid">
                <div><strong>Node:</strong> {selectedNode.title}</div>
                <div><strong>Harness:</strong> {selectedNode.harness}</div>
                <div><strong>Kind:</strong> {selectedNode.kind}</div>
              </div>
              <pre>{selectedResult?.output ?? "No output recorded."}</pre>
              {selectedResult?.error ? <pre style={{ color: "#fda4af" }}>Error: {selectedResult.error}</pre> : null}
            </>
          ) : (
            <p>Select a node to inspect its output.</p>
          )}
        </div>
        <div className="card">
          <h2>Recent Events</h2>
          <div className="event-list">
            {recentEvents.length > 0 ? (
              recentEvents.map((event) => (
                <div className="event-item" key={`${event.seq ?? event.ts}-${event.kind}`}>
                  <strong>{eventTitle(event)}</strong>
                  <div>{eventDetail(event)}</div>
                </div>
              ))
            ) : snapshot?.event ? (
              <div className="event-item">
                <strong>{eventTitle(snapshot.event)}</strong>
                <div>{selectedNode?.title ? `Node ${selectedNode.title}` : "Workflow state updated"}</div>
              </div>
            ) : (
              <div className="event-item">Waiting for the first event.</div>
            )}
          </div>
        </div>
      </aside>
      <div className="canvas-shell">
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          fitView
          onNodeClick={(_, node) => setSelectedNodeId(node.id)}
          onPaneClick={() => setSelectedNodeId(null)}
          onInit={setFlowInstance}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} color="#243044" />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root"));
root.render(<App />);
