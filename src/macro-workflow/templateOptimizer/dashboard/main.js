import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  BaseEdge,
  ConnectionLineType,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
} from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";

const EMPTY_GRAPH = { nodes: [], edges: [] };
const NODE_WIDTH = 220;
const NODE_HEIGHT = 78;
const elk = new ELK();

const TemplateNode = memo(({ data }) => (
  <div className={`template-node template-node-${data.source}`}>
    <Handle type="target" position={Position.Left} className="template-handle" />
    <div className="template-node-title">{data.label}</div>
    <div className="template-node-meta">{data.kind || "node"} / {data.harness || "harness"}</div>
    <div className="template-node-source">{data.sourceLabel}</div>
    <Handle type="source" position={Position.Right} className="template-handle" />
  </div>
));

const ElkEdge = memo(({ id, sourceX, sourceY, targetX, targetY, data, markerEnd, style }) => {
  const points = data?.points?.length ? data.points : [
    { x: sourceX, y: sourceY },
    { x: sourceX + 44, y: sourceY },
    { x: targetX - 44, y: targetY },
    { x: targetX, y: targetY },
  ];
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />;
});

const nodeTypes = { templateNode: TemplateNode };
const edgeTypes = { elk: ElkEdge };

function App() {
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState();
  const [detail, setDetail] = useState();
  const [loading, setLoading] = useState(true);

  const loadRun = useCallback(async (runId) => {
    if (!runId) {
      setDetail(undefined);
      return;
    }
    const response = await fetch(`/api/run?runId=${encodeURIComponent(runId)}`);
    if (!response.ok) {
      setDetail(undefined);
      return;
    }
    const payload = await response.json();
    setSelectedRunId(runId);
    setDetail(payload);
  }, []);

  const loadRuns = useCallback(async (preferredRunId) => {
    setLoading(true);
    const response = await fetch("/api/runs");
    const payload = await response.json();
    const nextRuns = payload.runs || [];
    const nextRunId = preferredRunId || selectedRunId || payload.latestRunId || nextRuns[0]?.runId;
    setRuns(nextRuns);
    setSelectedRunId(nextRunId);
    await loadRun(nextRunId);
    setLoading(false);
  }, [loadRun, selectedRunId]);

  useEffect(() => {
    void loadRuns();
  }, []);

  const run = detail?.run;
  const summary = detail?.summary;

  return (
    <div className="shell">
      <aside className="sidebar">
        <h1>Source-to-project template optimizer</h1>
        <p>Review completed optimizer runs and inspect the suggested template change.</p>
        <div className="callout">
          <strong>Completed optimizer runs</strong>
          <p>This UI does not generate new DAGs. Run a new optimization in your terminal, then refresh this page.</p>
          <code className="command">mise run source-to-project:optimize-template</code>
        </div>
        <div className="toolbar">
          <span className="muted">{runs.length === 1 ? "1 run" : `${runs.length} runs`}</span>
          <button className="button" type="button" onClick={() => loadRuns(selectedRunId)}>Refresh</button>
        </div>
        <RunList runs={runs} selectedRunId={selectedRunId} onSelect={loadRun} loading={loading} />
      </aside>

      <main className="main">
        {!run ? (
          <EmptyState />
        ) : (
          <>
            <DecisionBrief run={run} summary={summary} />
            <BeforeAfter detail={detail} />
            <section className="section panel">
              <div className="graph-toolbar">
                <h2>Proposed Graph Inspector</h2>
                <div className="graph-meta">
                  <span className="pill">Drag to pan. Wheel or controls to zoom.</span>
                  <span className="pill">{detail.finalGraph.nodes.length} nodes</span>
                  <span className="pill">{detail.finalGraph.edges.length} edges</span>
                </div>
              </div>
              <TemplateFlowGraph graph={detail.finalGraph} mode="inspector" ariaLabel="Proposed optimized template graph" />
            </section>
            <WhyBetter run={run} summary={summary} comparison={detail.graphComparison} />
            <RunComparison runs={runs} onSelect={loadRun} />
            <section className="grid-two">
              <div className="panel">
                <h2>Candidate Scores</h2>
                <CandidateScores candidates={detail.candidateComparisons || []} />
              </div>
              <div className="panel">
                <h2>Adoption Tasks</h2>
                <AdoptionTasks tasks={run.finalIncumbent?.adoptionTasks || []} />
              </div>
            </section>
            <ApplyPath run={run} summary={summary} />
            <FixtureMatrix iterations={run.iterations || []} />
            <RejectedMoves moves={run.rejectedMoves || []} />
            <Artifacts runId={summary?.runId || run.runId} />
          </>
        )}
      </main>
    </div>
  );
}

function RunList({ runs, selectedRunId, onSelect, loading }) {
  if (loading && runs.length === 0) {
    return <div className="empty">Loading optimizer runs.</div>;
  }
  if (runs.length === 0) {
    return <div className="empty">No optimizer runs found.</div>;
  }
  return (
    <div className="run-list">
      {runs.map((run) => (
        <button
          className="run-button"
          type="button"
          aria-current={String(run.runId === selectedRunId)}
          key={run.runId}
          onClick={() => onSelect(run.runId)}
        >
          <span className="run-title">
            <span>{run.runId}</span>
            <span className={`pill ${statusClass(run)}`}>{run.status}</span>
          </span>
          <span className="run-meta">
            <span>{formatDate(run.generatedAt || run.updatedAt)}</span>
            <span>delta {formatDelta(run.scoreDelta)}</span>
            <span>{run.iterationCount} iter</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <section className="section panel">
      <div className="empty">No optimizer run selected.</div>
    </section>
  );
}

function DecisionBrief({ run, summary }) {
  const fixtureRows = getFixtureRows(run.iterations || []);
  const challengerWins = fixtureRows.filter(({ judgment }) => (judgment.winner || judgment.winnerCandidateId) === "challenger").length;
  const confidence = summary?.decisionConfidence ?? run.iterations?.at(-1)?.aggregateJudgment?.decisionConfidence;
  const runId = summary?.runId || run.runId || "";
  const candidateId = run.finalRecommendation?.candidateId || run.finalIncumbent?.id || "";
  const dryRunCommand = `mise run optimize-template:apply -- ${runId} --dry-run --candidate ${candidateId}`;
  return (
    <section className="section panel">
      <div className="decision-layout">
        <div>
          <h2>Decision Brief</h2>
          <p className="muted">Selected run {runId}</p>
          <p className="rationale">{run.finalRecommendation?.rationale || run.finalIncumbent?.rationale || run.note || ""}</p>
          <div className="summary-grid">
            <Metric label="Recommendation" value={run.finalRecommendation?.recommendation || ""} />
            <Metric label="Score Delta" value={formatDelta(summary?.scoreDelta)} />
            <Metric label="Confidence" value={formatPercent(confidence)} />
            <Metric label="Fixture Wins" value={fixtureRows.length > 0 ? `${challengerWins} / ${fixtureRows.length}` : "n/a"} />
          </div>
        </div>
        <div>
          <h2>Human Action Check</h2>
          <ul className="decision-checks">
            <DecisionCheck label="Evidence" text="Review fixture wins, deltas, confidence, and rationale below." />
            <DecisionCheck label="Topology" text="Compare the current and proposed DAGs side by side before accepting." />
            <DecisionCheck label="Risk" text={`${summary?.criticalRegressionCount || 0} critical regression(s), ${summary?.rejectedMoveCount || 0} rejected move(s).`} />
            <DecisionCheck label="Apply" text="Use the dry-run apply path first; live rewrite is still intentionally gated." />
          </ul>
          <div className="decision-action">
            <h3>Preview Adoption Package</h3>
            <code className="command">{dryRunCommand}</code>
          </div>
        </div>
      </div>
    </section>
  );
}

function DecisionCheck({ label, text }) {
  return (
    <li>
      <span className="check-mark">OK</span>
      <span><strong>{label}</strong><br />{text}</span>
    </li>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span className="muted">{label}</span>
      <span className="metric-value">{String(value || "n/a")}</span>
    </div>
  );
}

function BeforeAfter({ detail }) {
  const comparison = detail.graphComparison;
  const run = detail.run;
  return (
    <section className="section panel">
      <h2>Before / After Template</h2>
      <ChangeSummary comparison={comparison} />
      <div className="graph-compare">
        <GraphCard
          title="Current Template"
          candidateId={run.baselineCandidateId || "baseline"}
          metrics={comparison?.baseline}
          graph={detail.baselineGraph}
          ariaLabel="Current template graph"
        />
        <GraphCard
          title="Proposed Optimized Template"
          candidateId={run.finalRecommendation?.candidateId || run.finalIncumbent?.id || "proposed"}
          metrics={comparison?.proposed}
          graph={detail.finalGraph}
          ariaLabel="Proposed optimized template graph"
        />
      </div>
    </section>
  );
}

function GraphCard({ title, candidateId, metrics, graph, ariaLabel }) {
  return (
    <div className="graph-card">
      <div className="graph-card-header">
        <h3>{title}</h3>
        <span className="pill candidate-pill">{candidateId}</span>
      </div>
      <GraphStats metrics={metrics} graph={graph} />
      <TemplateFlowGraph graph={graph} mode="preview" ariaLabel={ariaLabel} />
    </div>
  );
}

function GraphStats({ metrics, graph }) {
  const resolved = metrics || inferGraphMetrics(graph);
  return (
    <div className="graph-stats">
      <span className="pill">{resolved.totalNodes} nodes</span>
      <span className="pill">{resolved.sharedInitialNodes} shared</span>
      <span className="pill">{resolved.expansionNodes} expansion</span>
      <span className="pill">{resolved.edges} edges</span>
    </div>
  );
}

function ChangeSummary({ comparison }) {
  if (!comparison) {
    return <div className="empty">No graph comparison recorded.</div>;
  }
  return (
    <div className="change-summary">
      <ChangeBlock title="Added Nodes" items={comparison.addedNodes || []} labelFor={(node) => node.title || node.id} />
      <ChangeBlock title="Removed Nodes" items={comparison.removedNodes || []} labelFor={(node) => node.title || node.id} />
      <div>
        <h3>Topology Delta</h3>
        <ul className="change-list">
          <li>{formatSignedCount(comparison.proposed.totalNodes - comparison.baseline.totalNodes)} total nodes</li>
          <li>{formatSignedCount(comparison.proposed.sharedInitialNodes - comparison.baseline.sharedInitialNodes)} shared initial nodes</li>
          <li>{formatSignedCount(comparison.proposed.expansionNodes - comparison.baseline.expansionNodes)} expansion nodes</li>
          <li>{formatSignedCount(comparison.proposed.edges - comparison.baseline.edges)} edges</li>
        </ul>
      </div>
    </div>
  );
}

function ChangeBlock({ title, items, labelFor }) {
  const visible = items.slice(0, 8);
  const overflow = items.length - visible.length;
  return (
    <div>
      <h3>{title}</h3>
      <ul className="change-list">
        {visible.length === 0 ? <li>None</li> : visible.map((item) => <li key={item.id}>{labelFor(item)}</li>)}
        {overflow > 0 ? <li>+{overflow} more</li> : null}
      </ul>
    </div>
  );
}

function TemplateFlowGraph({ graph, mode, ariaLabel }) {
  const elkGraph = useMemo(() => buildElkGraph(graph || EMPTY_GRAPH), [graph]);
  const [layout, setLayout] = useState({ nodes: [], edges: [], loading: true, error: undefined });

  useEffect(() => {
    let cancelled = false;
    if (!elkGraph.children.length) {
      setLayout({ nodes: [], edges: [], loading: false, error: undefined });
      return () => {
        cancelled = true;
      };
    }

    setLayout((current) => ({ ...current, loading: true, error: undefined }));
    elk.layout(elkGraph)
      .then((layoutedGraph) => {
        if (cancelled) return;
        setLayout({ ...buildReactFlowGraph(graph || EMPTY_GRAPH, layoutedGraph), loading: false, error: undefined });
      })
      .catch((error) => {
        if (cancelled) return;
        setLayout({ nodes: [], edges: [], loading: false, error: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [elkGraph, graph]);

  const { nodes, edges, loading, error } = layout;
  if (nodes.length === 0) {
    return <div className={`flow-shell ${mode}`}><div className="empty">{loading ? "Laying out graph with ELK." : error ? `ELK layout failed: ${error}` : "No graph nodes recorded."}</div></div>;
  }
  return (
    <div className={`flow-shell ${mode}`} aria-label={ariaLabel}>
      <ReactFlow
        key={`${mode}-${nodes.map((node) => `${node.id}:${Math.round(node.position.x)}:${Math.round(node.position.y)}`).join("|")}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: mode === "preview" ? 0.18 : 0.22 }}
        minZoom={0.08}
        maxZoom={2.2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={mode !== "preview"}
        connectionLineType={ConnectionLineType.SmoothStep}
        defaultEdgeOptions={{ type: "elk" }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} color="var(--cp-border-strong)" />
        <Controls showInteractive={false} />
        {mode === "inspector" ? <MiniMap pannable zoomable /> : null}
      </ReactFlow>
    </div>
  );
}

function buildElkGraph(graph) {
  const nodeIds = new Set((graph.nodes || []).map((node) => node.id));
  return {
    id: "template-root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "60",
      "elk.layered.spacing.nodeNodeBetweenLayers": "130",
      "elk.layered.spacing.edgeNodeBetweenLayers": "48",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "24",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    },
    children: (graph.nodes || []).map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: (graph.edges || [])
      .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
      .map((edge, index) => ({
        id: edgeId(edge, index),
        sources: [edge.from],
        targets: [edge.to],
      })),
  };
}

function buildReactFlowGraph(graph, layoutedGraph) {
  const layoutNodes = new Map((layoutedGraph.children || []).map((node) => [node.id, node]));
  const layoutEdges = new Map((layoutedGraph.edges || []).map((edge) => [edge.id, edge]));
  const nodes = (graph.nodes || []).map((node) => {
    const position = layoutNodes.get(node.id) || { x: 0, y: 0 };
    return {
      id: node.id,
      type: "templateNode",
      position: { x: position.x, y: position.y },
      data: {
        label: node.title || node.id,
        kind: node.kind,
        harness: node.harness,
        source: node.source,
        sourceLabel: node.source === "expansion" ? `${node.mode || "mode"} expansion` : "shared initial",
      },
    };
  });
  const edges = (graph.edges || []).map((edge, edgeIndex) => ({
    id: edgeId(edge, edgeIndex),
    source: edge.from,
    target: edge.to,
    type: "elk",
    data: { points: edgeSectionPoints(layoutEdges.get(edgeId(edge, edgeIndex))) },
    style: { stroke: "var(--cp-text-muted)", strokeWidth: 1.6 },
  }));
  return { nodes, edges };
}

function edgeId(edge, index) {
  return `${edge.from}->${edge.to}-${index}`;
}

function edgeSectionPoints(edge) {
  const section = edge?.sections?.[0];
  if (!section?.startPoint || !section?.endPoint) {
    return undefined;
  }
  return [section.startPoint, ...(section.bendPoints || []), section.endPoint];
}

function WhyBetter({ run, summary, comparison }) {
  const fixtureRows = getFixtureRows(run.iterations || []);
  const latestAggregate = run.iterations?.at(-1)?.aggregateJudgment;
  const challengerWins = fixtureRows.filter(({ judgment }) => (judgment.winner || judgment.winnerCandidateId) === "challenger").length;
  const topologyDelta = comparison
    ? `Topology changed by ${formatSignedCount(comparison.proposed.totalNodes - comparison.baseline.totalNodes)} node(s), ${formatSignedCount(comparison.proposed.edges - comparison.baseline.edges)} edge(s), and ${formatSignedCount(comparison.proposed.expansionCases - comparison.baseline.expansionCases)} expansion case(s).`
    : "Topology comparison is unavailable for this run.";
  return (
    <section className="section panel">
      <h2>Why This Is Better</h2>
      <ul className="evidence-list">
        <li><strong>Aggregate judgment</strong><p>The proposed incumbent scored {formatDelta(summary?.scoreDelta ?? latestAggregate?.scoreDelta)} versus the current template with {formatPercent(summary?.decisionConfidence ?? latestAggregate?.decisionConfidence)} decision confidence and {summary?.criticalRegressionCount ?? latestAggregate?.criticalRegressionCount ?? 0} critical regression(s).</p></li>
        <li><strong>Fixture coverage</strong><p>The challenger won {challengerWins} of {fixtureRows.length} judged fixture(s), including no-fit and multi-opportunity scenarios when present.</p></li>
        <li><strong>Structural change</strong><p>{topologyDelta}</p></li>
        <li><strong>Optimizer rationale</strong><p>{run.finalIncumbent?.rationale || run.finalRecommendation?.rationale || ""}</p></li>
        <li>
          <strong>Fixture-level evidence</strong>
          {fixtureRows.length === 0 ? <p>No fixture judgments recorded.</p> : (
            <ul className="evidence-list nested">
              {fixtureRows.slice(0, 6).map(({ judgment }) => (
                <li key={judgment.fixtureId}>
                  <strong>{judgment.fixtureId || "fixture"}: {judgment.winner || judgment.winnerCandidateId || "unknown"}</strong>
                  <p>Delta {formatFixtureDelta(judgment)}, confidence {formatPercent(judgment.decisionConfidence)}. {judgment.rationale || ""}</p>
                </li>
              ))}
            </ul>
          )}
        </li>
      </ul>
    </section>
  );
}

function RunComparison({ runs, onSelect }) {
  if (runs.length === 0) {
    return <section className="section panel"><h2>Run Comparison</h2><div className="empty">No runs to compare.</div></section>;
  }
  return (
    <section className="section panel">
      <h2>Run Comparison</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Run</th><th>Status</th><th>Recommendation</th><th>Candidate</th><th>Iterations</th><th>Delta</th><th>Regressions</th></tr></thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.runId}>
                <td><button className="button" type="button" onClick={() => onSelect(run.runId)}>{run.runId}</button></td>
                <td>{run.status}</td>
                <td>{run.finalRecommendation || ""}</td>
                <td>{run.finalCandidateId || ""}</td>
                <td>{run.iterationCount}</td>
                <td>{formatDelta(run.scoreDelta)}</td>
                <td>{run.criticalRegressionCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CandidateScores({ candidates }) {
  if (candidates.length === 0) {
    return <div className="empty">No candidate score rows recorded.</div>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Candidate</th><th>Role</th><th>Strategy</th><th>Delta</th><th>Confidence</th><th>Decision</th></tr></thead>
        <tbody>
          {candidates.map((candidate, index) => (
            <tr key={`${candidate.id}-${candidate.role}-${index}`}>
              <td>{candidate.id}</td>
              <td>{candidate.role}</td>
              <td>{candidate.strategy || ""}</td>
              <td>{formatDelta(candidate.scoreDelta)}</td>
              <td>{formatPercent(candidate.decisionConfidence)}</td>
              <td>{formatCandidateDecision(candidate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdoptionTasks({ tasks }) {
  if (tasks.length === 0) {
    return <ul className="list"><li>No adoption tasks recorded.</li></ul>;
  }
  return (
    <ul className="list">
      {tasks.map((task, index) => (
        <li key={`${task.title}-${index}`}>
          <h3>{task.title || "Untitled task"}</h3>
          <p>{task.description || ""}</p>
          <p className="muted">{(task.filesLikelyTouched || []).join(", ")}</p>
        </li>
      ))}
    </ul>
  );
}

function ApplyPath({ run, summary }) {
  const runId = summary?.runId || run.runId || "";
  const candidateId = run.finalRecommendation?.candidateId || run.finalIncumbent?.id || "";
  const dryRunCommand = `mise run optimize-template:apply -- ${runId} --dry-run --candidate ${candidateId}`;
  return (
    <section className="section panel">
      <h2>HITL Apply Path</h2>
      <ol className="steps">
        <li><strong>Generate new candidates outside this viewer.</strong><p>This dashboard watches completed runs. Use the source-to-project optimize task, then press Refresh.</p><code className="command">mise run source-to-project:optimize-template</code></li>
        <li><strong>Review the recommended candidate.</strong><p>The before/after graphs, score tables, and evidence sections show why this candidate beat the current template.</p></li>
        <li><strong>Preview the adoption package.</strong><p>This is the current HITL-safe apply path. It writes or refreshes apply-dry-run.md without changing repository files.</p><code className="command">{dryRunCommand}</code></li>
        <li><strong>Live rewrite is not implemented yet.</strong><p>The apply script currently rejects non-dry-run writes, so accepting this candidate still requires a follow-up implementation step.</p></li>
      </ol>
    </section>
  );
}

function FixtureMatrix({ iterations }) {
  const rows = getFixtureRows(iterations);
  return (
    <section className="section panel">
      <h2>Fixture Judgment Matrix</h2>
      {rows.length === 0 ? <div className="empty">No fixture judgments recorded.</div> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Iteration</th><th>Fixture</th><th>Winner</th><th>Score Delta</th><th>Critical Regression</th><th>Confidence</th><th>Rationale</th></tr></thead>
            <tbody>
              {rows.map(({ iteration, judgment }) => (
                <tr key={`${iteration.index}-${iteration.candidateIndex}-${judgment.fixtureId}`}>
                  <td>{iteration.index}.{iteration.candidateIndex}</td>
                  <td>{judgment.fixtureId || ""}</td>
                  <td>{judgment.winner || judgment.winnerCandidateId || ""}</td>
                  <td>{formatFixtureDelta(judgment)}</td>
                  <td>{formatRegression(judgment)}</td>
                  <td>{formatPercent(judgment.decisionConfidence)}</td>
                  <td>{judgment.rationale || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RejectedMoves({ moves }) {
  return (
    <section className="section panel">
      <h2>Rejected Moves</h2>
      <ul className="list">{moves.length === 0 ? <li>No rejected moves recorded.</li> : moves.map((move) => <li key={move}>{move}</li>)}</ul>
    </section>
  );
}

function Artifacts({ runId }) {
  const files = ["optimizer-run.json", "summary.md", "apply-dry-run.md"];
  return (
    <section className="section panel">
      <h2>Artifacts</h2>
      <div className="links">
        {files.map((file) => (
          <a className="artifact-link" href={`/api/artifact?runId=${encodeURIComponent(runId || "")}&file=${encodeURIComponent(file)}`} target="_blank" rel="noreferrer" key={file}>{file}</a>
        ))}
      </div>
    </section>
  );
}

function inferGraphMetrics(graph) {
  const nodes = graph?.nodes || [];
  const expansionCases = new Set(nodes.map((node) => node.expansionCaseId).filter(Boolean));
  return {
    totalNodes: nodes.length,
    sharedInitialNodes: nodes.filter((node) => node.source === "shared-initial").length,
    expansionNodes: nodes.filter((node) => node.source === "expansion").length,
    edges: (graph?.edges || []).length,
    expansionCases: expansionCases.size,
  };
}

function getFixtureRows(iterations) {
  return iterations.flatMap((iteration) => (iteration.fixtureJudgments || []).map((judgment) => ({ iteration, judgment })));
}

function formatDate(value) {
  if (!value) return "unknown time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatDelta(value) {
  return typeof value === "number" ? `${value >= 0 ? "+" : ""}${value.toFixed(3)}` : "n/a";
}

function formatPercent(value) {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "n/a";
}

function formatSignedCount(value) {
  return `${value >= 0 ? "+" : ""}${value}`;
}

function formatFixtureDelta(judgment) {
  if (typeof judgment.scoreDelta === "number") return formatDelta(judgment.scoreDelta);
  if (typeof judgment.challengerScore === "number" && typeof judgment.incumbentScore === "number") {
    return formatDelta(judgment.challengerScore - judgment.incumbentScore);
  }
  return "n/a";
}

function formatRegression(judgment) {
  if (typeof judgment.criticalRegression === "boolean") return judgment.criticalRegression ? "yes" : "no";
  if (Array.isArray(judgment.criticalRegressions)) return judgment.criticalRegressions.length ? judgment.criticalRegressions.join("; ") : "no";
  return "n/a";
}

function formatCandidateDecision(candidate) {
  if (candidate.role === "baseline") return "current template";
  if (candidate.role === "final-incumbent") return candidate.recommendation || "selected";
  if (typeof candidate.replacedIncumbent === "boolean") return candidate.replacedIncumbent ? "replaced incumbent" : "kept incumbent";
  return candidate.recommendation || "";
}

function statusClass(run) {
  if (run.criticalRegressionCount > 0) return "bad";
  if (run.finalRecommendation === "adopt-candidate") return "good";
  return "warn";
}

createRoot(document.getElementById("root")).render(<App />);
