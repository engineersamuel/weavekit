import dagre from "@dagrejs/dagre";

const DEFAULT_NODE_WIDTH = 280;
const DEFAULT_NODE_HEIGHT = 150;
const HORIZONTAL_DIRECTION = "LR";
const HORIZONTAL_TARGET_POSITION = "left";
const HORIZONTAL_SOURCE_POSITION = "right";
const DEFAULT_EDGE_TYPE = "smoothstep";

type WorkflowLayoutNode = {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
  width?: number;
  height?: number;
  targetPosition?: string;
  sourcePosition?: string;
  [key: string]: unknown;
};

type WorkflowLayoutEdge = {
  id: string;
  source: string;
  target: string;
  type?: string;
  [key: string]: unknown;
};

export function layoutWorkflowGraph<
  TNode extends WorkflowLayoutNode,
  TEdge extends WorkflowLayoutEdge,
>({
  nodes,
  edges,
}: {
  nodes: TNode[];
  edges: TEdge[];
}): {
  nodes: Array<TNode & { targetPosition: string; sourcePosition: string }>;
  edges: Array<TEdge & { type: string }>;
} {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  const nodeIds = new Set(nodes.map((node) => node.id));

  graph.setGraph({
    rankdir: HORIZONTAL_DIRECTION,
    ranksep: 140,
    nodesep: 80,
    marginx: 40,
    marginy: 40,
  });

  nodes.forEach((node) => {
    graph.setNode(node.id, {
      width: node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH,
      height: node.measured?.height ?? node.height ?? DEFAULT_NODE_HEIGHT,
    });
  });

  edges.forEach((edge) => {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      graph.setEdge(edge.source, edge.target);
    }
  });

  dagre.layout(graph);

  return {
    nodes: nodes.map((node) => {
      const dimensions = graph.node(node.id) as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      return {
        ...node,
        targetPosition: HORIZONTAL_TARGET_POSITION,
        sourcePosition: HORIZONTAL_SOURCE_POSITION,
        position: {
          x: dimensions.x - dimensions.width / 2,
          y: dimensions.y - dimensions.height / 2,
        },
      };
    }),
    edges: edges.map((edge) => ({
      ...edge,
      type: edge.type ?? DEFAULT_EDGE_TYPE,
    })),
  };
}
