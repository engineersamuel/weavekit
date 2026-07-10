type ViewportNode = {
  id: string;
  position?: { x?: number; y?: number };
};

type ViewportEdge = {
  id: string;
  source: string;
  target: string;
};

export function createWorkflowViewportFitKey(args: {
  runId?: string;
  nodes: ViewportNode[];
  edges: ViewportEdge[];
}): string {
  const nodeKey = args.nodes
    .map(
      (node) =>
        `${node.id}@${Math.round(node.position?.x ?? 0)},${Math.round(node.position?.y ?? 0)}`,
    )
    .join("|");
  const edgeKey = args.edges.map((edge) => `${edge.id}:${edge.source}>${edge.target}`).join("|");

  return `${args.runId ?? ""}::${nodeKey}::${edgeKey}`;
}

export function shouldFitWorkflowViewport(args: {
  autoTrackNewRuns: boolean;
  nodeCount: number;
  fitKey: string;
  previousFitKey?: string | null;
}): boolean {
  return (
    args.nodeCount > 0 &&
    args.fitKey !== args.previousFitKey &&
    (args.autoTrackNewRuns || !args.previousFitKey)
  );
}

export function shouldResetWorkflowViewportFitKey(args: {
  currentRunId?: string;
  nextRunId?: string;
}): boolean {
  return (args.currentRunId ?? "") !== (args.nextRunId ?? "");
}
