import React, { useEffect, useMemo, useRef, useState, memo } from "react";
import { createRoot } from "react-dom/client";
import { Background, ConnectionLineType, Controls, MiniMap, ReactFlow, Handle, Position } from "@xyflow/react";
import { layoutWorkflowGraph } from "./layout.ts";
import { createWorkflowViewportFitKey, shouldFitWorkflowViewport } from "./viewport.ts";
import { resolveBlockedNodeDisplay, resolveNodeExecutionDisplay, resolveNodeModelDisplay } from "./executionContext.ts";
import { buildNodeArtifactLinks } from "./artifactLinks.ts";
import {
  buildDeepResearchQuestionBatchSummary,
  buildDeepResearchProviderFailureSummary,
  buildVerificationOpportunityAdvancementSummary,
} from "./payloadHighlights.ts";

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
  const prLaunchState = data.prLaunchState;
  
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
      <div className="node-model-line">model {data.model}</div>
      {data.autoImplementLaunch?.status === "launched" ? (
        <div className="node-inline-actions nodrag">
          <span className="node-action-badge node-action-badge-success">
            Auto-implement started: {data.autoImplementLaunch.agentName}
          </span>
        </div>
      ) : data.autoImplementLaunch?.status === "failed" ? (
        <div className="node-inline-actions nodrag">
          <span className="node-action-error">Auto-implement launch failed: {data.autoImplementLaunch.error}</span>
        </div>
      ) : null}
      {data.canCreatePr && data.autoImplementLaunch?.status !== "launched" ? (
        <div className="node-inline-actions nodrag">
          {data.agentOptions?.length > 0 ? (
            <select
              className="node-action-select"
              disabled={prLaunchState?.status === "running"}
              value={data.selectedAgentId ?? ""}
              onChange={(event) => {
                event.stopPropagation();
                data.onSelectAgent?.(event.target.value);
              }}
              onClick={(event) => event.stopPropagation()}
            >
              {data.agentOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            className="node-action-button"
            disabled={prLaunchState?.status === "running"}
            onClick={(event) => {
              event.stopPropagation();
              data.onCreatePr?.(data.sourceNode?.id);
            }}
          >
            {prLaunchState?.status === "running" ? "Creating..." : prLaunchState?.status === "passed" ? "PR Agent Started" : "Create PR"}
          </button>
          {prLaunchState?.status === "failed" ? <span className="node-action-error">{prLaunchState.message}</span> : null}
        </div>
      ) : null}
      
      {isDecisionCouncil && (
        <div className="persona-list-container">
          <div className="persona-list-title">Council Personas</div>
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
  if (state.activeNodeIds?.includes(node.id) || state.activeNodeId === node.id) {
    return "running";
  }
  return DEFAULT_STATUS;
}

function resolveNodeModel(node, state) {
  return resolveNodeModelDisplay(node, state);
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
      const result = state.nodeResults?.find((entry) => entry.nodeId === node.id);
      nodes.push({
        id: node.id,
        type: "workflowNode",
        className: `node-status-${status}`,
        position: {
          x: layerIndex * 340,
          y: nodeIndex * 190,
        },
        data: {
          label: node.title,
          subtitle: node.kind,
          status,
          output: result?.output ?? "",
          error: result?.error ?? "",
          harness: node.harness,
          model: resolveNodeModel(node, state),
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

  return layoutWorkflowGraph({ nodes, edges });
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
        const result = state?.nodeResults?.find((entry) => entry.nodeId === node.id);
        nodes.push({
          id: node.id,
          type: "workflowNode",
          className: `node-status-${node.status}`,
          position: {
            x: layerIndex * 340,
            y: nodeIndex * 190,
          },
          data: {
            label: node.title,
            subtitle: node.kind,
            status: node.status,
            output: result?.output ?? "",
            error: result?.error ?? "",
            harness: node.harness,
            model: resolveNodeModel(node.sourceNode ?? node, state ?? {}),
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

  return { ...layoutWorkflowGraph({ nodes, edges }), replayView };
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
      description: node.description,
      model: node.model,
      modelRationale: node.modelRationale,
      status,
      harness: node.harness ?? "workflow",
      dependsOn: node.dependsOn ?? [],
      exists: true,
      sourceNode: node,
    });
  }

  function ensurePlanningNode(status = "running", eventNode) {
    const sourceNode = eventNode ?? {
      id: PLANNING_NODE_ID,
      kind: "planning",
      title: "DAG Planning",
      description: "Plan the workflow DAG from the objective and template.",
      model: "claude-opus-4.8",
      modelRationale: "Workflow DAG planning uses the strongest available planning synthesis model.",
      harness: "workflow-planner",
      dependsOn: [],
    };
    if (nodes.has(PLANNING_NODE_ID)) {
      const existing = nodes.get(PLANNING_NODE_ID);
      nodes.set(PLANNING_NODE_ID, {
        ...existing,
        ...sourceNode,
        status,
        exists: true,
        sourceNode,
      });
      return;
    }
    nodeOrder.unshift(PLANNING_NODE_ID);
    nodes.set(PLANNING_NODE_ID, {
      id: PLANNING_NODE_ID,
      kind: sourceNode.kind,
      title: sourceNode.title,
      description: sourceNode.description,
      model: sourceNode.model,
      modelRationale: sourceNode.modelRationale,
      status,
      harness: sourceNode.harness,
      dependsOn: [],
      exists: true,
      sourceNode,
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
      ensurePlanningNode("running", event.node);
      activePhase = "planning";
      continue;
    }

    if (event.kind === "planning-complete") {
      ensurePlanningNode("passed", event.node);
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

function MarkdownOutput({ markdown }) {
  const blocks = useMemo(() => parseMarkdownBlocks(markdown), [markdown]);
  return (
    <div className="markdown-output">
      {blocks.map((block, index) => renderMarkdownBlock(block, index))}
    </div>
  );
}

function parseMarkdownBlocks(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  let quote = [];
  let code = null;

  function flushParagraph() {
    if (paragraph.length === 0) {
      return;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  }

  function flushList() {
    if (!list) {
      return;
    }
    blocks.push(list);
    list = null;
  }

  function flushQuote() {
    if (quote.length === 0) {
      return;
    }
    blocks.push({ type: "quote", text: quote.join("\n") });
    quote = [];
  }

  function flushOpenBlocks() {
    flushParagraph();
    flushList();
    flushQuote();
  }

  for (const line of lines) {
    const fenceMatch = line.match(/^```(\S*)\s*$/);
    if (fenceMatch && code) {
      blocks.push({ type: "code", language: code.language, text: code.lines.join("\n") });
      code = null;
      continue;
    }
    if (fenceMatch) {
      flushOpenBlocks();
      code = { language: fenceMatch[1] ?? "", lines: [] };
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushOpenBlocks();
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushOpenBlocks();
      blocks.push({ type: "heading", level: headingMatch[1].length, text: headingMatch[2] });
      continue;
    }

    const unorderedMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (unorderedMatch) {
      flushParagraph();
      flushQuote();
      if (!list || list.ordered) {
        flushList();
        list = { type: "list", ordered: false, items: [] };
      }
      list.items.push(unorderedMatch[1]);
      continue;
    }

    const orderedMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (orderedMatch) {
      flushParagraph();
      flushQuote();
      if (!list || !list.ordered) {
        flushList();
        list = { type: "list", ordered: true, items: [] };
      }
      list.items.push(orderedMatch[1]);
      continue;
    }

    const quoteMatch = line.match(/^\s*>\s?(.+)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }

  if (code) {
    blocks.push({ type: "code", language: code.language, text: code.lines.join("\n") });
  }
  flushOpenBlocks();
  return blocks;
}

function renderMarkdownBlock(block, index) {
  if (block.type === "heading") {
    const Heading = `h${Math.min(Math.max(block.level, 1), 4)}`;
    return <Heading key={index}>{renderInlineMarkdown(block.text)}</Heading>;
  }
  if (block.type === "list") {
    const List = block.ordered ? "ol" : "ul";
    return (
      <List key={index}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
        ))}
      </List>
    );
  }
  if (block.type === "quote") {
    return <blockquote key={index}>{block.text.split("\n").map((line, lineIndex) => <React.Fragment key={lineIndex}>{lineIndex > 0 ? <br /> : null}{renderInlineMarkdown(line)}</React.Fragment>)}</blockquote>;
  }
  if (block.type === "code") {
    return (
      <pre className="markdown-code" key={index}>
        {block.language ? <span className="markdown-code-language">{block.language}</span> : null}
        <code>{block.text}</code>
      </pre>
    );
  }
  return <p key={index}>{renderInlineMarkdown(block.text)}</p>;
}

function renderInlineMarkdown(text) {
  const source = String(text);
  const parts = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) {
      parts.push(source.slice(cursor, match.index));
    }
    const token = match[0];
    const key = parts.length;
    if (token.startsWith("`")) {
      parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      parts.push(
        <a key={key} href={linkMatch[2]} target="_blank" rel="noreferrer">
          {linkMatch[1]}
        </a>,
      );
    }
    cursor = match.index + token.length;
  }
  if (cursor < source.length) {
    parts.push(source.slice(cursor));
  }
  return parts;
}

function RichNodeOutput({ result }) {
  if (result?.payload && Object.keys(result.payload).length > 0) {
    return (
      <section className="node-output-section">
        <h3>Node Output</h3>
        <div className="rich-output">
          <PayloadHighlights payload={result.payload} />
          {result.output?.trim() ? (
            <section className="structured-section">
              <h3>Output Summary</h3>
              <MarkdownOutput markdown={result.output} />
            </section>
          ) : null}
          <StructuredValue value={result.payload} title="Typed Output Payload" path="payload" />
        </div>
      </section>
    );
  }

  return (
    <section className="node-output-section">
      <h3>Node Output</h3>
      <section className="structured-section">
        <h3>Output Summary</h3>
        <MarkdownOutput markdown={result?.output ?? ""} />
      </section>
    </section>
  );
}

function PayloadHighlights({ payload }) {
  const verificationAdvancement = buildVerificationOpportunityAdvancementSummary(payload);
  if (verificationAdvancement) {
    return <VerificationOpportunityAdvancementHighlights summary={verificationAdvancement} />;
  }

  const providerFailure = buildDeepResearchProviderFailureSummary(payload);
  if (providerFailure) {
    return <DeepResearchProviderFailureHighlights summary={providerFailure} />;
  }

  const questionBatch = buildDeepResearchQuestionBatchSummary(payload);
  if (questionBatch) {
    return <DeepResearchQuestionBatchHighlights summary={questionBatch} />;
  }

  const plans = Array.isArray(payload?.plans) ? payload.plans : [];
  if (plans.length > 0) {
    return <PlanHighlights plans={plans} />;
  }

  const councilReview = payload?.councilReview ?? payload?.councilInputReview;
  if (Array.isArray(councilReview?.opportunities) && councilReview.opportunities.length > 0) {
    return <OpportunityHighlights review={councilReview} acceptances={payload?.opportunityAcceptances} />;
  }

  return null;
}

function PlanHighlights({ plans }) {
  return (
    <section className="payload-highlights">
      <h3>Recommendation</h3>
      <div className="highlight-grid">
        {plans.map((plan, index) => {
          const title = plan.title || `Plan ${index + 1}`;
          const recommendation = plan.recommendation || plan.targetChange || plan.scope || title;
          const expectedUserValue = plan.expectedUserValue || "";
          const outline = Array.isArray(plan.implementationOutline) ? plan.implementationOutline : [];
          return (
            <article className="highlight-card" key={`${title}-${index}`}>
              <div className="highlight-kicker">{(plan.opportunityIds ?? []).join(", ") || `Plan ${index + 1}`}</div>
              <h4>{title}</h4>
              <p>{recommendation}</p>
              {plan.problemSolved ? (
                <div className="highlight-field">
                  <span>Problem Solved</span>
                  <p>{plan.problemSolved}</p>
                </div>
              ) : null}
              {plan.sourceLessonApplied ? (
                <div className="highlight-field">
                  <span>Source Lesson</span>
                  <p>{plan.sourceLessonApplied}</p>
                </div>
              ) : null}
              {plan.targetChange && plan.targetChange !== recommendation ? (
                <div className="highlight-field">
                  <span>What Changes</span>
                  <p>{plan.targetChange}</p>
                </div>
              ) : null}
              {expectedUserValue ? (
                <div className="highlight-field">
                  <span>Expected Value</span>
                  <p>{expectedUserValue}</p>
                </div>
              ) : null}
              {outline.length > 0 ? (
                <div className="highlight-field">
                  <span>First Steps</span>
                  <ol>
                    {outline.slice(0, 4).map((step, stepIndex) => <li key={stepIndex}>{step}</li>)}
                  </ol>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function VerificationOpportunityAdvancementHighlights({ summary }) {
  return (
    <section className="payload-highlights verification-advancement-highlights">
      <div className="highlight-header">
        <h3>Verification Opportunities</h3>
        <div className="highlight-badge-row">
          <span className="workflow-badge advanced">{summary.capLabel}</span>
          {summary.notAdvancedCount > 0 ? <span className="workflow-badge muted">{summary.notAdvancedCount} not advanced</span> : null}
        </div>
      </div>
      {summary.rankingRationale ? <p className="highlight-rationale">{summary.rankingRationale}</p> : null}
      <div className="highlight-grid">
        {summary.opportunities.map((opportunity, index) => (
          <article className={`highlight-card compact opportunity-card ${opportunity.status}`} key={opportunity.id}>
            <div className="highlight-card-topline">
              <div className="highlight-kicker">#{index + 1} · {opportunity.id}</div>
              <span className={`workflow-badge ${opportunity.status === "advanced" ? "advanced" : "muted"}`}>
                {opportunity.badgeLabel}
              </span>
            </div>
            <h4>{opportunity.title}</h4>
            {opportunity.currentVerificationGap ? (
              <div className="highlight-field">
                <span>Gap</span>
                <p>{opportunity.currentVerificationGap}</p>
              </div>
            ) : null}
            {opportunity.targetChange ? (
              <div className="highlight-field">
                <span>Target Change</span>
                <p>{opportunity.targetChange}</p>
              </div>
            ) : null}
            {opportunity.runId ? (
              <div className="highlight-field">
                <span>Research Run</span>
                <code className="inline-code">{opportunity.runId}</code>
              </div>
            ) : null}
            {opportunity.score ? (
              <div className="score-row">
                <span>Confidence {formatScoreValue(opportunity.score.confidence)}</span>
                <span>Impact {formatScoreValue(opportunity.score.impact)}</span>
                <span>Risk {formatScoreValue(opportunity.score.risk)}</span>
                <span>Cost {formatScoreValue(opportunity.score.implementationCost)}</span>
              </div>
            ) : null}
            {opportunity.proofCommands.length > 0 ? (
              <div className="highlight-field">
                <span>Proof Commands</span>
                <ul className="compact-code-list">
                  {opportunity.proofCommands.map((command) => <li key={command}><code>{command}</code></li>)}
                </ul>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function DeepResearchProviderFailureHighlights({ summary }) {
  return (
    <section className="payload-highlights provider-failure-highlights">
      <div className="highlight-header">
        <h3>Provider Research Degraded</h3>
        <div className="highlight-badge-row">
          <span className="workflow-badge degraded">{summary.failureCount} provider {summary.failureCount === 1 ? "failure" : "failures"}</span>
          <span className="workflow-badge neutral">{summary.evidenceCount} evidence items from this node</span>
        </div>
      </div>
      {summary.runId ? (
        <div className="highlight-field">
          <span>Research Run</span>
          <code className="inline-code">{summary.runId}</code>
        </div>
      ) : null}
      <div className="highlight-grid">
        {summary.failures.map((failure) => (
          <article className="highlight-card compact provider-failure-card" key={`${failure.provider}-${failure.iteration}`}>
            <div className="highlight-card-topline">
              <div className="highlight-kicker">{failure.provider} · iteration {failure.iteration}</div>
              <span className="workflow-badge degraded">{failure.retryCount} {failure.retryCount === 1 ? "retry" : "retries"}</span>
            </div>
            <p>{failure.message}</p>
            <div className="highlight-badge-row">
              <span className="workflow-badge muted">{failure.questionCount} {failure.questionCount === 1 ? "question" : "questions"} affected</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DeepResearchQuestionBatchHighlights({ summary }) {
  return (
    <section className="payload-highlights question-batch-highlights">
      <div className="highlight-header">
        <h3>Research Question Batch</h3>
        <div className="highlight-badge-row">
          <span className="workflow-badge advanced">{summary.questionCount} questions</span>
          <span className="workflow-badge neutral">iteration {summary.iteration}</span>
          {summary.providerCount > 0 ? <span className="workflow-badge neutral">{summary.providerCount} providers</span> : null}
        </div>
      </div>
      {summary.runId ? (
        <div className="highlight-field">
          <span>Research Run</span>
          <code className="inline-code">{summary.runId}</code>
        </div>
      ) : null}
      {summary.providerStrategy.length > 0 ? (
        <div className="provider-strategy-list">
          {summary.providerStrategy.map((strategy) => <span className="workflow-badge strategy" key={strategy}>{strategy}</span>)}
        </div>
      ) : null}
      <div className="highlight-grid question-grid">
        {summary.questions.map((question, index) => (
          <article className="highlight-card compact question-card" key={question.id}>
            <div className="highlight-card-topline">
              <div className="highlight-kicker">Question {index + 1} · {question.id}</div>
              <div className="highlight-badge-row">
                {question.researchModeLabel ? <span className={`workflow-badge mode ${modeBadgeClass(question.researchMode)}`}>{question.researchModeLabel}</span> : null}
                <span className="workflow-badge neutral">{question.queryCount} {question.queryCount === 1 ? "query" : "queries"}</span>
              </div>
            </div>
            <p>{question.text}</p>
            {question.researchModeRationale ? <p className="question-routing-rationale">{question.researchModeRationale}</p> : null}
            <div className="highlight-field">
              <span>Advances To</span>
              <div className="highlight-badge-row">
                {question.routedProviders.length > 0
                  ? question.routedProviders.map((provider) => <span className="workflow-badge advanced" key={provider}>{provider}</span>)
                  : <span className="workflow-badge muted">No external provider</span>}
              </div>
            </div>
            {question.providerHints.length > 0 ? (
              <div className="highlight-badge-row">
                {question.providerHints.map((hint) => <span className="workflow-badge muted" key={hint}>{hint}</span>)}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function modeBadgeClass(mode) {
  if (mode === "local-only") {
    return "local-only";
  }
  if (mode === "official-docs" || mode === "web-lookup") {
    return "docs";
  }
  if (mode === "recency-social") {
    return "recency";
  }
  if (mode === "deep-research") {
    return "deep";
  }
  return "neutral";
}

function OpportunityHighlights({ review, acceptances }) {
  const opportunities = review.opportunities.slice(0, 6);
  const acceptanceById = new Map((Array.isArray(acceptances) ? acceptances : []).map((acceptance) => [acceptance.id, acceptance]));
  return (
    <section className="payload-highlights">
      <h3>Ranked Opportunities</h3>
      {review.rankingRationale ? <p className="highlight-rationale">{review.rankingRationale}</p> : null}
      <div className="highlight-grid">
        {opportunities.map((opportunity, index) => (
          <article className="highlight-card compact" key={opportunity.id ?? `${opportunity.title}-${index}`}>
            <div className="highlight-kicker">#{index + 1}{opportunity.id ? ` · ${opportunity.id}` : ""}</div>
            <h4>{opportunity.title ?? `Opportunity ${index + 1}`}</h4>
            {opportunity.projectChange ? <p>{opportunity.projectChange}</p> : null}
            {opportunity.lesson ? (
              <div className="highlight-field">
                <span>Source Lesson</span>
                <p>{opportunity.lesson}</p>
              </div>
            ) : null}
            {opportunity.score ? (
              <div className="score-row">
                <span>Applicability {formatScoreValue(opportunity.score.applicability)}</span>
                <span>Impact {formatScoreValue(opportunity.score.impact)}</span>
                <span>Confidence {formatScoreValue(opportunity.score.confidence)}</span>
              </div>
            ) : null}
            {acceptanceById.has(opportunity.id) ? (
              <div className={`acceptance-row ${acceptanceById.get(opportunity.id).accepted ? "accepted" : "rejected"}`}>
                <span>{acceptanceById.get(opportunity.id).accepted ? "Accepted" : "Rejected"}</span>
                <span>Avg {formatScoreValue(acceptanceById.get(opportunity.id).acceptanceAverage)}</span>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function formatScoreValue(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function NodeExecutionContext({ node, result, state }) {
  const isPlanningNode = node?.id === PLANNING_NODE_ID;
  const { plannedPrompt, execution, calls, hasActualExecution } = resolveNodeExecutionDisplay({ node, result, state });

  return (
    <section className="execution-context">
      <h3>Execution Context</h3>
      <dl className="execution-fields">
        <div>
          <dt>{isPlanningNode ? "Planner" : "Configured Harness"}</dt>
          <dd>{isPlanningNode ? "workflow-planner" : node?.harness ?? execution?.executor ?? "unknown"}</dd>
        </div>
        <div>
          <dt>Node Kind</dt>
          <dd>{node?.kind ?? "workflow"}</dd>
        </div>
        {node?.writeMode ? (
          <div>
            <dt>Write Mode</dt>
            <dd>{node.writeMode}</dd>
          </div>
        ) : null}
        {node?.dependsOn?.length ? (
          <div>
            <dt>Depends On</dt>
            <dd>{node.dependsOn.join(", ")}</dd>
          </div>
        ) : null}
        {state?.templateId ? (
          <div>
            <dt>Template</dt>
            <dd>{state.templateId}</dd>
          </div>
        ) : null}
      </dl>
      <PromptBlock title={isPlanningNode ? "Original Request" : "Planned Node Prompt"} prompt={plannedPrompt} />
      {calls.length > 0 ? (
        <div className="execution-calls">
          <h4>Execution Calls</h4>
          {calls.map((call, index) => (
            <article className="execution-call" key={`${call.executor}-${index}`}>
              <dl className="execution-fields">
                <div>
                  <dt>Executor</dt>
                  <dd>{call.executor}</dd>
                </div>
                {call.operation ? (
                  <div>
                    <dt>Operation</dt>
                    <dd>{call.operation}</dd>
                  </div>
                ) : null}
                {call.mode ? (
                  <div>
                    <dt>Mode</dt>
                    <dd>{call.mode}</dd>
                  </div>
                ) : null}
                {call.cwd ? (
                  <div>
                    <dt>Cwd</dt>
                    <dd>{call.cwd}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Model</dt>
                  <dd>{call.model ?? "Not recorded in this run"}</dd>
                </div>
              </dl>
              {call.prompt ? <PromptBlock title="Actual Prompt" prompt={call.prompt} /> : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="execution-note">
          {hasActualExecution
            ? "Actual execution calls were not recorded for this run."
            : "Actual execution prompt has not been published for this harness yet."}
        </p>
      )}
    </section>
  );
}

function BlockedNodeNotice({ display }) {
  return (
    <section className="blocked-node-notice">
      <h3>Blocked</h3>
      <p>{display.message}</p>
      {display.failedDependencies.length > 0 ? (
        <div className="highlight-grid">
          {display.failedDependencies.map((dependency) => (
            <article className="highlight-card compact provider-failure-card" key={dependency.nodeId}>
              <div className="highlight-kicker">{dependency.nodeId}</div>
              <h4>{dependency.title}</h4>
              {dependency.error ? <p>{dependency.error}</p> : null}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function NodeArtifactLinks({ node, result, snapshot, onOpenArtifact }) {
  const links = buildNodeArtifactLinks({ node, result, snapshot });
  if (links.length === 0) {
    return null;
  }

  const outputDir = snapshot?.run?.outputDir;
  return (
    <section className="artifact-links">
      <h3>Generated Artifacts</h3>
      {outputDir ? (
        <div className="artifact-output-dir">
          <span>Output directory</span>
          <code>{outputDir}</code>
        </div>
      ) : null}
      <div className="artifact-link-list">
        {links.map((link) => (
          <button type="button" onClick={() => onOpenArtifact(link)} key={link.file}>
            <span>{link.label}</span>
            <code>{link.file}</code>
          </button>
        ))}
      </div>
    </section>
  );
}

function ArtifactModal({ artifact, onClose }) {
  if (!artifact) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="artifact-modal" role="dialog" aria-modal="true" aria-labelledby="artifact-modal-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="artifact-modal-header">
          <div>
            <div className="output-panel-eyebrow">{artifact.file}</div>
            <h2 id="artifact-modal-title">{artifact.label}</h2>
          </div>
          <div className="artifact-modal-actions">
            <a href={artifact.href} target="_blank" rel="noreferrer">Open raw</a>
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </header>
        <div className="artifact-modal-body">
          {artifact.loading ? (
            <p className="output-empty">Loading artifact...</p>
          ) : artifact.error ? (
            <pre className="output-error">{artifact.error}</pre>
          ) : artifact.kind === "markdown" ? (
            <MarkdownOutput markdown={artifact.content ?? ""} />
          ) : artifact.kind === "json" ? (
            <StructuredValue value={artifact.value} title="Artifact JSON" path="artifact" />
          ) : (
            <pre className="artifact-plain-text">{artifact.content ?? ""}</pre>
          )}
        </div>
      </section>
    </div>
  );
}

function PromptBlock({ title, prompt }) {
  return (
    <details className="prompt-block" open>
      <summary>{title}</summary>
      <pre>{prompt || "No prompt recorded."}</pre>
    </details>
  );
}

function buildPlanningPayload(state) {
  const plan = state?.currentPlan ?? state?.plan;
  if (!plan) {
    return {
      objective: state?.objective ?? "No original prompt recorded.",
    };
  }
  return {
    objective: state?.objective ?? plan.objective,
    planId: state?.planId ?? plan.id,
    templateId: state?.templateId ?? plan.templateId,
    maxReplans: plan.maxReplans,
    nodes: (plan.nodes ?? []).map((node) => ({
      id: node.id,
      title: node.title,
      kind: node.kind,
      harness: node.harness,
      prompt: node.prompt,
      input: node.input,
      dependsOn: node.dependsOn,
      gates: node.gates,
      writeMode: node.writeMode,
      replanPolicy: node.replanPolicy,
    })),
  };
}

function StructuredValue({ value, title, path, depth = 0 }) {
  if (typeof value === "string") {
    return (
      <section className="structured-section">
        <StructuredHeading title={title} depth={depth} />
        <MarkdownOutput markdown={value} />
      </section>
    );
  }

  if (Array.isArray(value)) {
    return (
      <section className="structured-section">
        <StructuredHeading title={`${title} (${value.length})`} depth={depth} />
        <StructuredArray value={value} path={path} depth={depth} />
      </section>
    );
  }

  if (isPlainObject(value)) {
    return (
      <section className="structured-section">
        <StructuredHeading title={title} depth={depth} />
        <StructuredObject value={value} path={path} depth={depth} />
      </section>
    );
  }

  return (
    <section className="structured-section">
      <StructuredHeading title={title} depth={depth} />
      <div className="structured-scalar">{formatScalar(value)}</div>
    </section>
  );
}

function StructuredHeading({ title, depth }) {
  const Heading = depth <= 0 ? "h2" : depth === 1 ? "h3" : "h4";
  return <Heading>{humanizeKey(title)}</Heading>;
}

function StructuredObject({ value, path, depth }) {
  const entries = Object.entries(value);
  const scalarEntries = entries.filter(([, entryValue]) => isScalarValue(entryValue));
  const complexEntries = entries.filter(([, entryValue]) => !isScalarValue(entryValue));

  return (
    <div className="structured-object">
      {scalarEntries.length > 0 ? (
        <dl className="structured-fields">
          {scalarEntries.map(([key, entryValue]) => (
            <div className="structured-field" key={`${path}.${key}`}>
              <dt>{humanizeKey(key)}</dt>
              <dd>{renderScalarValue(entryValue)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {complexEntries.map(([key, entryValue]) => (
        <StructuredValue
          value={entryValue}
          title={key}
          path={`${path}.${key}`}
          depth={depth + 1}
          key={`${path}.${key}`}
        />
      ))}
      {entries.length > 0 ? (
        <details className="raw-json">
          <summary>Raw JSON</summary>
          <pre>{JSON.stringify(value, null, 2)}</pre>
        </details>
      ) : (
        <p className="output-empty">No fields recorded.</p>
      )}
    </div>
  );
}

function StructuredArray({ value, path, depth }) {
  if (value.length === 0) {
    return <p className="output-empty">No items recorded.</p>;
  }

  if (value.every((item) => isScalarValue(item))) {
    return (
      <ul className="structured-list">
        {value.map((item, index) => (
          <li key={`${path}.${index}`}>{renderScalarValue(item)}</li>
        ))}
      </ul>
    );
  }

  return (
    <div className="structured-items">
      {value.map((item, index) => (
        <article className="structured-item" key={`${path}.${index}`}>
          <div className="structured-item-title">{itemTitle(item, index)}</div>
          <StructuredValue value={item} title={`Item ${index + 1}`} path={`${path}.${index}`} depth={depth + 1} />
        </article>
      ))}
    </div>
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isScalarValue(value) {
  return value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function renderScalarValue(value) {
  if (typeof value === "string" && value.trim().match(/[\n#*>`-]|\[[^\]]+\]\(/)) {
    return <MarkdownOutput markdown={value} />;
  }
  return <span>{formatScalar(value)}</span>;
}

function formatScalar(value) {
  if (value === null || value === undefined) {
    return "Not recorded";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return String(value);
}

function itemTitle(item, index) {
  if (!isPlainObject(item)) {
    return `Item ${index + 1}`;
  }
  return item.title ?? item.displayName ?? item.id ?? item.sourceId ?? item.projectId ?? `Item ${index + 1}`;
}

function humanizeKey(key) {
  return String(key)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
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
  const [artifactModal, setArtifactModal] = useState(null);
  const [prLaunches, setPrLaunches] = useState({});
  const [agentOptions, setAgentOptions] = useState([]);
  const [defaultAgentId, setDefaultAgentId] = useState(undefined);
  const [selectedAgentByNode, setSelectedAgentByNode] = useState({});
  const lastViewportFitKey = useRef(null);

  useEffect(() => {
    let active = true;
    fetch("/api/source-to-project/agent-options")
      .then((response) => response.json())
      .then((payload) => {
        if (!active) return;
        setAgentOptions(Array.isArray(payload.options) ? payload.options : []);
        setDefaultAgentId(payload.defaultAgentId);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

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

  async function openArtifact(link) {
    const loadingArtifact = {
      ...link,
      kind: artifactKind(link.file),
      loading: true,
      content: "",
    };
    setArtifactModal(loadingArtifact);
    try {
      const response = await fetch(link.href);
      if (!response.ok) {
        throw new Error(`Artifact request failed with HTTP ${response.status}.`);
      }
      const content = await response.text();
      const kind = artifactKind(link.file);
      setArtifactModal({
        ...link,
        kind,
        loading: false,
        content,
        value: kind === "json" ? JSON.parse(content) : undefined,
      });
    } catch (error) {
      setArtifactModal({
        ...link,
        kind: artifactKind(link.file),
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function createPrForNode(nodeId) {
    const runId = snapshot?.activeRunId ?? snapshot?.run?.runId ?? snapshot?.state?.runId;
    if (!runId || !nodeId) {
      return;
    }
    const launchKey = prLaunchKey(runId, nodeId);
    const agentId = selectedAgentByNode[nodeId] ?? defaultAgentId;
    setPrLaunches((current) => ({
      ...current,
      [launchKey]: { status: "running", message: "Creating PR agent..." },
    }));
    try {
      const response = await fetch("/api/source-to-project/pr-launch", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ runId, nodeId, agentId }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || `PR launch failed with HTTP ${response.status}.`);
      }
      setPrLaunches((current) => ({
        ...current,
        [launchKey]: {
          status: "passed",
          message: payload.launch?.agentName ? `Started ${payload.launch.agentName}` : "PR agent started.",
          launch: payload.launch,
        },
      }));
    } catch (error) {
      setPrLaunches((current) => ({
        ...current,
        [launchKey]: {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }

  function artifactKind(file) {
    if (file.endsWith(".md") || file.endsWith(".markdown")) {
      return "markdown";
    }
    if (file.endsWith(".json")) {
      return "json";
    }
    return "text";
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
  const graphWithActions = useMemo(() => ({
    ...graph,
    nodes: graph.nodes.map((node) => {
      const sourceNode = node.data?.sourceNode;
      const runId = snapshot?.activeRunId ?? snapshot?.run?.runId ?? snapshot?.state?.runId;
      const launchKey = prLaunchKey(runId, node.id);
      const nodeResult = snapshot?.state?.nodeResults?.find((entry) => entry.nodeId === node.id);
      const canCreatePr = Boolean(
        runId
        && snapshot?.state?.templateId === "source-to-project"
        && sourceNode?.kind === "report"
        && sourceNode?.id?.startsWith("report-opportunity-")
        && node.data?.status === "passed"
        && nodeResult?.status === "passed",
      );
      return {
        ...node,
        data: {
          ...node.data,
          canCreatePr,
          prLaunchState: prLaunches[launchKey],
          onCreatePr: createPrForNode,
          autoImplementLaunch: nodeResult?.payload?.autoImplementLaunch,
          agentOptions,
          selectedAgentId: selectedAgentByNode[node.id] ?? defaultAgentId,
          onSelectAgent: (agentId) => setSelectedAgentByNode((current) => ({ ...current, [node.id]: agentId })),
        },
      };
    }),
  }), [graph, prLaunches, snapshot, agentOptions, defaultAgentId, selectedAgentByNode]);
  const activeRunId = snapshot?.activeRunId ?? snapshot?.run?.runId ?? snapshot?.state?.runId;
  const viewportFitKey = useMemo(() => createWorkflowViewportFitKey({
    runId: activeRunId,
    nodes: graphWithActions.nodes,
    edges: graphWithActions.edges,
  }), [activeRunId, graphWithActions.nodes, graphWithActions.edges]);

  useEffect(() => {
    if (!flowInstance || !shouldFitWorkflowViewport({
      autoTrackNewRuns,
      nodeCount: graphWithActions.nodes.length,
      fitKey: viewportFitKey,
      previousFitKey: lastViewportFitKey.current,
    })) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      lastViewportFitKey.current = viewportFitKey;
      void flowInstance.fitView({ padding: 0.2, duration: 220 });
    });
    return () => cancelAnimationFrame(frame);
  }, [autoTrackNewRuns, flowInstance, graphWithActions.nodes.length, viewportFitKey]);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) {
      return null;
    }
    const graphNode = graphWithActions.nodes.find((node) => node.id === selectedNodeId);
    if (graphNode?.data?.sourceNode) {
      return graphNode.data.sourceNode;
    }
    if (!snapshot?.state) {
      return null;
    }
    const plan = snapshot.state.currentPlan ?? snapshot.state.plan ?? { nodes: [] };
    return plan.nodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [graphWithActions.nodes, selectedNodeId, snapshot]);

  const selectedResult = useMemo(() => {
    if (!snapshot?.state || !selectedNode) {
      return null;
    }
    return snapshot.state.nodeResults?.find((entry) => entry.nodeId === selectedNode.id) ?? null;
  }, [selectedNode, snapshot]);
  const selectedGraphNode = useMemo(() => {
    if (!selectedNodeId) {
      return null;
    }
    return graphWithActions.nodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [graphWithActions.nodes, selectedNodeId]);
  const selectedNodeStatus = selectedGraphNode?.data?.status
    ?? selectedResult?.status
    ?? (selectedNode ? resolveNodeStatus(selectedNode, snapshot?.state ?? { nodeResults: [] }) : DEFAULT_STATUS);
  const selectedBlockedDisplay = useMemo(() => {
    return resolveBlockedNodeDisplay(selectedNode, snapshot?.state);
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
  const selectedOutput = selectedResult?.output?.trim() ?? "";
  const canRenderSelectedOutput = selectedNodeStatus === "passed" && selectedResult?.status === "passed" && selectedOutput.length > 0;
  const isPlanningSelection = selectedNode?.id === PLANNING_NODE_ID;

  return (
    <div className={`app-shell ${selectedNode ? "has-output-panel" : ""}`}>
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
            <div><strong>Nodes:</strong> {graphWithActions.nodes.length}</div>
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
                <div><strong>Status:</strong> {selectedNodeStatus}</div>
              </div>
            </>
          ) : (
            <p>No node selected.</p>
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
          nodes={graphWithActions.nodes}
          edges={graphWithActions.edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => setSelectedNodeId(node.id)}
          onPaneClick={() => setSelectedNodeId(null)}
          onInit={setFlowInstance}
          connectionLineType={ConnectionLineType.SmoothStep}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} color="#243044" />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      {selectedNode ? (
        <aside className="output-panel" aria-label="Node output">
          <div className="output-panel-header">
            <div>
              <div className="output-panel-eyebrow">{selectedNode.kind} · {selectedNodeStatus}</div>
              <h2>{selectedNode.title}</h2>
            </div>
            <button type="button" onClick={() => setSelectedNodeId(null)}>Close</button>
          </div>
          <div className="output-panel-body">
            <NodeExecutionContext node={selectedNode} result={selectedResult} state={snapshot?.state} />
            {isPlanningSelection ? (
              <StructuredValue value={buildPlanningPayload(snapshot?.state)} title="Planned DAG" path="plannedDag" />
            ) : canRenderSelectedOutput || (selectedNodeStatus === "passed" && selectedResult?.payload) ? (
              <RichNodeOutput result={selectedResult} />
            ) : selectedResult?.error ? (
              <pre className="output-error">Error: {selectedResult.error}</pre>
            ) : selectedBlockedDisplay.blocked ? (
              <BlockedNodeNotice display={selectedBlockedDisplay} />
            ) : selectedNodeStatus !== "passed" ? (
              <p className="output-empty">Output will render after this node passes.</p>
            ) : (
              <p className="output-empty">No output recorded.</p>
            )}
            <NodeArtifactLinks node={selectedNode} result={selectedResult} snapshot={snapshot} onOpenArtifact={openArtifact} />
          </div>
        </aside>
      ) : null}
      <ArtifactModal artifact={artifactModal} onClose={() => setArtifactModal(null)} />
    </div>
  );
}

function prLaunchKey(runId, nodeId) {
  return `${runId ?? ""}:${nodeId ?? ""}`;
}

const root = createRoot(document.getElementById("root"));
root.render(<App />);
